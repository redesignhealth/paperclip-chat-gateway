# Deploying to AWS ECS Fargate

This is a generic deployment guide for running the gateway on ECS Fargate. It
contains **no organization-specific values** — no account IDs, VPC/subnet
IDs, cluster names, Tailscale tailnets, or SSM paths. If you're deploying
inside Redesign Health, see the private `rh-paperclip` repo's
`terraform/environments/dev` for the actual instantiation of the pattern
described here; this doc is the thing that instantiation follows.

There is no Terraform module shipped in this repo (yet). One adopter
(Redesign Health) does not justify guessing at a second adopter's VPC/subnet/
cluster conventions, IAM boundary policies, or whether they even use
Tailscale for private networking — a parameterized module built against a
single real deployment tends to bake in that deployment's assumptions anyway.
This guide plus the sample task definition below is deliberately the
lower-commitment option: copy it, adapt the specifics to your environment,
and treat any repeated pattern that emerges across multiple *external*
adopters as the trigger to promote this into a real module.

## Container contract

- **Listens on** `PORT` (default `3000`), plain HTTP. Put a load balancer,
  Tailscale sidecar, or other TLS-terminating layer in front of it — the
  container itself does not terminate TLS.
- **Health endpoint**: `GET /health`. Wire this into your orchestrator's
  health check.
- **Runtime image**: `node:22.12.0-bookworm-slim` (see `apps/gateway/Dockerfile`).
  This image has **no `curl` and no `wget`** — verified directly against the
  pinned tag (`docker run --rm node:22.12.0-bookworm-slim sh -c 'which curl;
  which wget'` returns nothing for either). Any health check you configure
  from *outside* the container (an ECS `healthCheck` block, a Kubernetes
  probe using `exec`, etc.) must account for this. Node's built-in `fetch`
  is available (Node 22 ships it natively), so the image's own `HEALTHCHECK`
  uses that:

  ```
  node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  ```

  Reuse this exact command (adjusted for your `PORT`) for any container-level
  health check you configure — do not assume `curl -f .../health` will work,
  it will fail with "executable file not found" on this image. This is the
  same trap flagged in TECH-4894 for the sibling Paperclip server image;
  always verify against the actual pinned tag rather than assuming.

- **No config or credentials baked into the image.** `.dockerignore` excludes
  `apps/gateway/config/gateway.json`, `**/.env*`, and anything matching
  `*credentials*.json` from the build context. You must supply both at
  container start, by one of the mechanisms below.

## Runtime config: `GATEWAY_CONFIG_PATH`

The employee roster + employee→agent binding table (`config/gateway.example.json`
shows the shape) is read once, at process startup, from `GATEWAY_CONFIG_PATH`
(default `./config/gateway.json`). There is no hot-reload — changing the file
requires a container restart to take effect.

Two reasonable ways to get a real file onto that path in ECS Fargate:

1. **EFS volume mount** (recommended for ECS). Mount an EFS access point
   read-only at the container path `GATEWAY_CONFIG_PATH` resolves to.
   Pros: arbitrary JSON size, human-editable in place (e.g. via a bastion
   or `efs-utils` mount elsewhere), no redeploy needed to pick up a new
   roster — just an ECS service restart (`force-new-deployment`) to reread
   the file. Cons: requires provisioning + securing an EFS file system and
   its own security group, and the file is exactly as available as whatever
   process/host is trusted to write to it.
2. **Render from a secret store at container start.** An entrypoint wrapper
   that reads a JSON blob out of AWS Secrets Manager / SSM Parameter Store
   and writes it to `GATEWAY_CONFIG_PATH` before `exec`'ing the real command.
   Pros: no EFS to provision; config change is just an SSM `put-parameter`
   + redeploy. Cons: SSM `String`/`SecureString` parameters cap out at 4 KB
   (standard tier) — fine for a modest roster, a real constraint for a large
   one; Secrets Manager has no such cap but costs more per secret and adds
   an extra API call (and IAM grant) to the container's startup path.

Either is defensible; pick based on whether your roster is large/frequently
edited (favors EFS) or small/infrequently edited (favors the render-at-start
approach — one less piece of infrastructure to run).

## Per-agent credentials: `CREDENTIAL_STORE_KIND`

- `CREDENTIAL_STORE_KIND=env` (default): each per-agent Paperclip API key is
  an environment variable named `PAPERCLIP_AGENT_KEY__<encoded agentId>`
  (see the README's Quickstart section for the exact encoding, or call
  `EnvAgentCredentialStore.envVarNameFor(agentId)`). This maps directly onto
  ECS's native `secrets` (`valueFrom`) mechanism on the container definition —
  one SSM `SecureString` (or Secrets Manager secret) per agent, resolved by
  the **execution role** before the container starts, never written to disk
  or to any shared filesystem. This is the natural fit for ECS specifically
  because `secrets` already does exactly this, with no extra plumbing.
  Tradeoff: adding a new agent means adding a new SSM parameter + a new
  `secrets` entry + a service redeploy — there is no way to add an agent
  without touching the task definition.
- `CREDENTIAL_STORE_KIND=file` + `CREDENTIAL_STORE_FILE_PATH`: a JSON
  `agentId -> key` map read from a mounted file, same tradeoffs as the EFS
  option above for `GATEWAY_CONFIG_PATH` — appropriate if you're already
  running an EFS mount for the config file and would rather manage one
  mutable file than N individual secrets.

For ECS specifically, prefer `env` — it uses the platform's own secret
injection instead of re-deriving a weaker version of it via a mounted file.

## Networking

The gateway needs outbound access to two things: your OIDC issuer, and your
Paperclip API base URL (`PAPERCLIP_API_BASE_URL`). Neither requires inbound
access to the gateway task itself if you put it behind a load balancer or a
private overlay network (Tailscale, a VPN mesh, etc.) — the container listens
on plain HTTP and expects TLS termination and access control to happen in
front of it. If your Paperclip instance is only reachable over a private
overlay network, the gateway task needs its own presence on that network
(e.g. its own sidecar container joining the same mesh) — it is a separate
node from Paperclip's own, not a shared one.

## Sample ECS task definition

`sample-task-definition.json` in this directory is a fully genericized,
placeholder-only task definition showing:

- The gateway container: image, port, env vars, `secrets` (SSM `valueFrom`)
  for OIDC + per-agent credentials, the `node -e fetch(...)` health check,
  and an EFS mount for `GATEWAY_CONFIG_PATH`.
- An optional private-network sidecar container (shown here as a generic
  `network-sidecar` container — substitute your own overlay network's
  container image) that the gateway container depends on (`dependsOn`,
  condition `START`) before it needs outbound reachability to Paperclip.

Every placeholder is `<ALL_CAPS_LIKE_THIS>` — there are no real account IDs,
ARNs, or hostnames anywhere in this file. Fill in your own VPC/subnet/cluster,
IAM role ARNs, ECR image URI, SSM parameter ARNs, and (if applicable) overlay
network sidecar configuration.

## Checklist before first deploy

- [ ] `GATEWAY_CONFIG_PATH` resolves to a real, valid config file at container
      start (EFS mount or render-at-start — see above). The process throws a
      `GatewayConfigError` naming the path it looked at if this is wrong;
      check container logs first, not the health check, if the task won't
      come up.
- [ ] Every `agentId` referenced in the config's `bindings` array has a
      corresponding credential configured (env var or credential file) —
      the process fails closed at boot with a clear error listing exactly
      which `agentId`s are missing one, rather than a runtime 503 on the
      unlucky first message.
- [ ] `COOKIE_SECRET` is a real random ≥32-character value, not the example
      placeholder.
- [ ] `OIDC_ALLOWED_EMAIL_DOMAINS` matches your actual identity population —
      leaving this too broad means anyone at any allowed domain who can
      authenticate against your OIDC issuer can log in (they still can't
      reach any agent without a binding, but they can log in).
- [ ] The health check command matches what's actually in your pinned image
      tag (re-run the `which curl; which wget` check above if you ever
      change the base image in `apps/gateway/Dockerfile`).
