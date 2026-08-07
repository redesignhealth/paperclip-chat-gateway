# paperclip-chat-gateway

A standalone, transport-agnostic chat gateway for [Paperclip](https://github.com/paperclipai/paperclip) agents.

**The problem:** Paperclip deliberately has no chat surface ("agents have jobs, not chat windows"), and its access model is company-scoped — there is no built-in way to give each human a private, free-text channel to *their own* agent and nobody else's.

**What this does:** one small service with one job —

1. **Authenticate** the human (pluggable auth adapter)
2. **Bind** them 1:1 to their agent (hard lookup, enforced in code)
3. **Deliver** the message via Paperclip's issue-comment API, using a narrowly-scoped per-agent credential only the gateway holds

Run your agents in protected mode so the gateway is their only wake principal, and the per-person channel scoping Paperclip can't express becomes a property of your deployment.

## Architecture

```
                        ┌────────────────────────────────────────────┐
                        │                apps/gateway                │
                        │         (composition root, env config)     │
                        └───────────────┬──────────────────────────┬─┘
                                        │                          │
                 ┌──────────────────────▼───────┐   ┌──────────────▼───────────────┐
                 │      packages/auth-oidc      │   │     packages/transport-web    │
                 │  OIDC login/callback via     │   │  fastify API + session cookie │
                 │  openid-client (certified)   │   │  + minimal React/Vite chat UI │
                 └──────────────┬────────────────┘   └──────────────┬────────────────┘
                                │                                   │
                                └───────────────┬───────────────────┘
                                                │
                                  ┌─────────────▼─────────────┐
                                  │        packages/core       │
                                  │  the security kernel:      │
                                  │  IdentityResolver           │
                                  │  BindingTable (deny-by-def) │
                                  │  AgentCredentialStore       │
                                  │  PaperclipClient            │
                                  │  Session (issue-backed)     │
                                  └─────────────┬───────────────┘
                                                │  Bearer <scoped agent key>
                                                ▼
                                     Paperclip API (issue comments)
                                                │
                                                ▼
                                   your agent, running in
                                   Paperclip protected mode
```

`packages/core` has no auth-provider or transport specifics — it is the one
package that must stay honest about the security model regardless of which
auth adapter or transport ships next.

## Agent-facing identity broker (`POST /api/agent/scheduler`)

Everything above is "human calls in, gateway calls Paperclip." This is the
mirror image: **an external scheduler service needs to know WHICH HUMAN a
calling Paperclip agent acts for, without trusting any spoofable claim.**
The gateway is the only thing positioned to answer that safely, because it's
the only party that holds both a verified `BindingTable` and (per this
feature) the shared secret needed to verify a Paperclip agent's run token.

### What a Paperclip agent run token is

Every Paperclip agent process receives `PAPERCLIP_API_KEY` in its env: a
run-bound JWT with claims `sub` (agentId), `company_id`, `run_id`, and —
critically — `responsible_user_id`, signed HS256. Source-verified against
Paperclip's `server/src/agent-auth-jwt.ts`:

- The signing key is **not** the raw `BETTER_AUTH_SECRET`. Paperclip derives
  a per-company, per-control-plane-instance key:
  `HMAC-SHA256(masterSecret, "jwt:${instanceId}:${companyId}")`, itself
  hex-encoded and then used as the HMAC key for the token (yes, the hex
  string's UTF-8 bytes, not the raw digest — `packages/core/src/agent-token.ts`
  mirrors this exactly, including that detail, because getting it wrong
  produces a verifier that silently rejects every real token). Paperclip
  also accepts a fallback verification against the raw master secret, for
  tokens minted before per-company derivation existed; this gateway mirrors
  that fallback too, but — unlike Paperclip's own default — ships it
  **disabled by default**, requiring an explicit opt-in
  (`AGENT_JWT_ENABLE_LEGACY_FALLBACK=true`) rather than an explicit opt-out,
  since any holder of the raw master secret can mint tokens accepted via
  that path.
- There is no JWKS/asymmetric option and no introspection endpoint. HS256
  shared-secret verification is the only cryptographic option available —
  this gateway and Paperclip must run in the **same trust domain** and share
  `AGENT_JWT_SECRET` out of band via a real secret store.
- `company_id` is read from the token's own unverified claims to pick a
  candidate key, but the value is also checked against this deployment's own
  `AGENT_JWT_COMPANY_ID` allowlist *before* that key is derived. A
  validly-signed token minted by Paperclip for a different company on the
  same control-plane instance is rejected outright — it never gets a chance
  to pick a signature-verifying key. This allowlist is required whenever the
  broker is enabled; there is no "trust whatever company_id says" fallback.

### The broker is opt-in

`AGENT_JWT_SECRET` has no default, and leaving it unset does not fail
startup — it disables this whole feature. A gateway deployment with no
agent-broker settings starts normally with `/api/agent/scheduler` simply
not registered (404, not 401/501). Setting `AGENT_JWT_SECRET` turns the
broker on and triggers strict validation of `AGENT_JWT_COMPANY_ID` (required)
and `AGENT_JWT_ISSUER`/`AGENT_JWT_AUDIENCE` (at least one required) at boot
— see `apps/gateway/.env.example` for the full set of `AGENT_JWT_*` settings
and `apps/gateway/src/index.ts` for the startup log line that states plainly
which mode (`ENABLED`/`DISABLED`) a running instance is in.

### Trust model — read this before wiring anything to the broker route

**What possession of a valid run token proves:** that the bearer is (or very
recently was) a live run of agent `sub`, i.e. `run_id`. Nothing more.

**What it does NOT prove — and specifically, what this gateway refuses to
even look at:** `responsible_user_id`. That field is client-settable by any
Paperclip member at issue creation time, so it is not a property the
token's *signer* attests to in any cryptographic sense — it is
attacker-controllable data riding inside an otherwise-legitimate token.
`packages/core/src/agent-token.ts`'s `verifyAgentRunToken` never reads this
claim out of the verified payload, and `VerifiedAgentToken` has no field
for it — there is no code path anywhere downstream of verification that
could accidentally rely on it. `packages/core/test/agent-token.test.ts`
asserts this directly: two otherwise-identical tokens differing only in
`responsible_user_id` resolve to byte-identical results.

**Who this gateway believes a call is "for," concretely:** the *human*
returned by `BindingTable.resolveEmployeeFor(agentId)` — the same
deny-by-default binding table the human-facing routes use, just walked in
the other direction. An `agentId` with no configured binding is rejected
with 403, never guessed. Ambiguity (two employees somehow bound to one
agent) can't reach this code path at all: `BindingTable.fromConfig` already
rejects that shape at load time (`DuplicateAgentBindingError`), before any
request is ever served.

**Why the verifier must live in the same trust domain as Paperclip, and why
the downstream scheduler must NOT hold this secret:** `AGENT_JWT_SECRET` is
symmetric — anything that has it can *mint* valid tokens, not just verify
them. This gateway needs it to verify inbound tokens. The downstream
scheduler never needs to see a token at all: it receives an already-resolved
`employeeId` from this gateway, over whatever transport/auth you configure
between gateway and scheduler (see `SchedulerClient` in
`packages/core/src/scheduler-client.ts`). Handing the scheduler the shared
secret would let a scheduler compromise (or a bug in a *third* service) mint
tokens that impersonate arbitrary agents against Paperclip itself — a much
larger blast radius than what this gateway needs to expose.

### Open transport question (unresolved — needs a live instance)

**How an agent actually attaches this token to an outbound call to this
gateway is not answered by source alone**, and this PR does not invent an
answer. Paperclip generates a per-run MCP config with a bearer credential
scoped to *its own* gateway; whether an agent's runtime can be configured to
also attach a bearer header (this token) to a *different* outbound MCP/HTTP
target — this gateway's `/api/agent/scheduler` — is unknown without a live
Paperclip deployment to test against. This PR builds and tests the
*receiving* side correctly (verify → resolve → broker) and stops there
deliberately, rather than guessing at Paperclip's per-run MCP config
mechanics.

`packages/core/src/scheduler-client.ts`'s `HttpSchedulerClient.forward` is
similarly an intentional `NotImplementedError` stub, for the same reason
`PaperclipClient.createConversationIssue` is: the real downstream
scheduler's request/response shape, endpoint path, and auth are not known
from source. Wire the real call there once that's answered, following the
same "one file owns the whole HTTP surface, validated with zod" convention
as `HttpPaperclipClient`.

## Threat model

**What this gateway protects against:**

- A human reaching an agent that isn't theirs. `BindingTable` is deny-by-default:
  an (employee, agent) pair not explicitly configured resolves to `null`,
  never a guess or a default agent.
- One agent's Paperclip credential leaking to another agent's traffic.
  `AgentCredentialStore` is keyed per-agent; there is no shared board key
  anywhere in this codebase, and lookups for an unconfigured agent return
  `null`, not another agent's key.
- Login from outside an approved identity population. The OIDC adapter
  enforces an allowed-email-domain list before `IdentityResolver` is even
  consulted, and requires the identity provider to assert `email_verified`
  on that email. `loadOidcConfigFromEnv` refuses to start with an empty
  (unrestricted) allow-list unless a caller explicitly passes
  `allowUnrestrictedDomains: true` — this gateway's own composition root
  (`apps/gateway`) never does, so there is currently no env var or flag
  that disables this check without a code change.
- API drift silently breaking delivery. All Paperclip HTTP calls go through
  one `PaperclipClient` interface (`docs/paperclip-api.md` documents
  exactly what it's coded against), and every response is validated against
  a zod schema at that one boundary, so a shape change fails loudly there —
  with contract tests — instead of propagating an `undefined` deep into the
  UI.

**What this gateway does *not* protect against:**

- A compromised auth adapter or identity provider. If your OIDC issuer is
  compromised, this gateway trusts whatever claims it returns for the
  domains you've allow-listed.
- A compromised agent. This gateway controls who can *reach* an agent, not
  what that agent does once woken — run agents in Paperclip's protected
  mode and apply Paperclip's own permission model for that.
- Availability / DoS. There's no rate limiting in v1. Don't expose this
  directly to the internet without a reverse proxy that has some.
- Message content inspection. The gateway relays message bodies verbatim;
  it does not scan, redact, or moderate content.
- Anything about how the per-agent Paperclip key was minted or approved.
  That's Paperclip's join/approve/claim-key flow
  (`doc/HERMES_GATEWAY_ONBOARDING.md` upstream); this gateway only holds
  and uses the key once claimed.

## Quickstart

```sh
pnpm install
cp apps/gateway/.env.example apps/gateway/.env
cp apps/gateway/config/gateway.example.json apps/gateway/config/gateway.json
# edit both files: OIDC issuer/client, allowed email domains,
# employee list, employee->agent bindings, and the claimed per-agent
# Paperclip API key(s)

pnpm run build
pnpm --filter @paperclip-chat-gateway/gateway run start
```

For local dev with hot reload on the UI:

```sh
pnpm --filter @paperclip-chat-gateway/transport-web run dev:ui
```

Run tests:

```sh
pnpm test
```

## Running the built image

`apps/gateway/Dockerfile` builds an image that intentionally ships with
**no config or credentials baked in** — `.dockerignore` excludes
`apps/gateway/config/gateway.json`, `apps/gateway/.env`, and any
`*credentials*.json` from the build context, so none of that
deployment-specific/secret material ever lands in an image layer or a
registry push. You must provide them at **runtime**:

```sh
docker build -t paperclip-chat-gateway apps/gateway/.. # from repo root
docker run \
  -p 3000:3000 \
  --env-file /path/to/real.env \
  -v /path/to/real/gateway.json:/app/config/gateway.json:ro \
  paperclip-chat-gateway
```

- The employee roster + bindings file is read from `GATEWAY_CONFIG_PATH`
  (default `./config/gateway.json`, i.e. `/app/config/gateway.json` in the
  container). Mount a real file there, or set `GATEWAY_CONFIG_PATH` to a
  different mounted path. See `apps/gateway/config/gateway.example.json`
  for the shape (obviously-fake values; it's the one config file that
  *is* included in the image, purely as a discoverable reference).
- If `CREDENTIAL_STORE_KIND=file`, the credential file is read from
  `CREDENTIAL_STORE_FILE_PATH` and must be mounted the same way; the
  default `CREDENTIAL_STORE_KIND=env` instead reads
  `PAPERCLIP_AGENT_KEY__<encoded agentId>` env vars (pass via `--env-file`
  or your orchestrator's secret store — never `COPY`'d into the image).
- Starting the container without a config at the resolved path fails fast
  with a `GatewayConfigError` that names `GATEWAY_CONFIG_PATH` and the
  exact path it looked at, instead of an opaque crash.

### Reverse proxies and `TRUST_PROXY`

By default the gateway does **not** trust `X-Forwarded-*` headers
(`TRUST_PROXY` unset → Fastify's `trustProxy: false`). That's the safe
default for a gateway exposed directly, or behind a proxy you don't fully
control — trusting those headers blindly would let any client spoof
`req.protocol`/`req.hostname` (which feed into the OIDC callback URL) by
setting the headers itself.

If you run this behind a reverse proxy or load balancer that terminates
TLS and sets `X-Forwarded-*` (and, critically, **strips** any
client-supplied values first), set `TRUST_PROXY` so OIDC redirects and
logging see the real client-facing protocol/host:

- `TRUST_PROXY=true` — trust any forwarded headers (only safe if nothing
  upstream of your proxy can reach the gateway directly)
- `TRUST_PROXY=10.0.0.1` or a comma-separated list — trust only specific
  proxy IPs/CIDRs (preferred)
- `TRUST_PROXY=1` — trust a hop count instead of an IP list

At startup the gateway logs the active mode (`{"trustProxy": ...}` in the
`"listening"` log line) so a deployment that's misbehaving because of a
proxy-trust mismatch (e.g. OIDC redirect URIs coming back with the wrong
scheme/host) is diagnosable from the logs alone, without having to check
the env var configuration by hand.

## Deploying to ECS Fargate

For orchestrators beyond plain `docker run` — ECS Fargate specifically — see
[`docs/deployment/ecs-fargate.md`](docs/deployment/ecs-fargate.md). It covers
the container health-check tooling trap (the runtime image has neither
`curl` nor `wget`), the tradeoffs between the two ways to deliver
`GATEWAY_CONFIG_PATH` at runtime (EFS mount vs. render-from-secret-store at
container start), why `CREDENTIAL_STORE_KIND=env` is the natural fit for
ECS's own `secrets` mechanism, and a fully-genericized sample task
definition ([`docs/deployment/sample-task-definition.json`](docs/deployment/sample-task-definition.json)).

## Repo layout

- `packages/core` — security kernel: identity resolution, the binding
  table (now bidirectional — employee→agent and agent→employee), per-agent
  credential storage, the Paperclip API client interface, the issue-backed
  session model, the agent run-token verifier (`agent-token.ts`), and the
  downstream scheduler client interface (`scheduler-client.ts`). No
  auth-provider or transport code.
- `packages/auth-oidc` — generic OIDC adapter (`openid-client`). The only
  auth adapter in v1; anything OIDC-compliant works.
- `packages/transport-web` — fastify API + session cookie + a minimal
  React/Vite chat UI (login → chat pane → send → agent reply), plus the
  agent-facing identity-broker route (`routes/agent.ts`,
  `POST /api/agent/scheduler`).
- `apps/gateway` — composition root: wires the above together from env
  config, single Dockerfile.
- `docs/paperclip-api.md` — the actual Paperclip API surface this gateway
  calls, with upstream file references.

## Works with

Built and coded against a Paperclip checkout during active development in
2026; pin your Paperclip deployment and re-run this repo's
`docs/paperclip-api.md` review if you're on a materially different
Paperclip version. No specific Paperclip release has been tagged as the
compatibility baseline yet — this is a v1 scaffold, tracked for follow-up.

## Prior art

- [mvanhorn's Paperclip chat plugins](https://github.com/mvanhorn) — convenience-focused chat plugins for Paperclip; different threat model (not built around per-employee credential isolation).
- [brendandebeasi/paperclip-chat-bots](https://github.com/brendandebeasi/paperclip-chat-bots) — bot-style chat integrations for Paperclip; optimized for quick setup over strict 1:1 binding enforcement.
- [OpenClaw](https://github.com/paperclipai/paperclip) — Paperclip's own built-in gateway adapter family; shares the "gateway holds one scoped credential" shape but is not a standalone, transport-agnostic project.

This project deliberately does not depend on or vendor any of the above —
see the dependency policy in the v1 scaffold PR for why.

## Status

Early. Built in the open from day one. v1 scaffold: core security kernel,
OIDC auth, and a minimal web transport are real; a few integration points
are documented gaps:

- Issue creation and live-run streaming — see `docs/paperclip-api.md`.
- The SSM-backed (or other secret-manager-backed) `AgentCredentialStore`
  mentioned as a future swap-in doesn't exist yet; v1 ships only the
  env-var- and file-backed implementations in `packages/core`.
- Agent-facing broker (`POST /api/agent/scheduler`): the receiving side
  (verify run token → resolve employee via `BindingTable` → broker) is real
  and tested. Two things are explicitly not: how an agent's runtime attaches
  this token to an outbound call in the first place (needs a live Paperclip
  instance to answer — see "Open transport question" above), and the actual
  downstream scheduler request shape (`HttpSchedulerClient.forward` is a
  documented `NotImplementedError` stub).

## License

MIT
