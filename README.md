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

## Repo layout

- `packages/core` — security kernel: identity resolution, the binding
  table, per-agent credential storage, the Paperclip API client interface,
  and the issue-backed session model. No auth-provider or transport code.
- `packages/auth-oidc` — generic OIDC adapter (`openid-client`). The only
  auth adapter in v1; anything OIDC-compliant works.
- `packages/transport-web` — fastify API + session cookie + a minimal
  React/Vite chat UI (login → chat pane → send → agent reply).
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

## License

MIT
