# syntax=docker/dockerfile:1
# Pinned to a specific Node 22 patch release rather than a floating tag.
# For production, prefer pinning to this tag's immutable digest as well
# (`docker pull` it once and copy the sha256 here).
FROM node:22.12.0-bookworm-slim AS base
# The Corepack build bundled with this Node image ships a stale set of npm
# registry signing keys, so it rejects the signature on current pnpm
# tarballs with "Cannot find matching keyid". Upgrading Corepack itself
# (rather than pinning COREPACK_INTEGRITY_KEYS or disabling verification)
# pulls in current keys and keeps working as npm rotates them in the
# future. Do not "simplify" this away or replace it with
# COREPACK_INTEGRITY_KEYS=0 — that would drop signature verification on a
# package-manager download for an auth gateway.
RUN npm install -g corepack@latest && corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/package.json
COPY packages/auth-oidc/package.json packages/auth-oidc/package.json
COPY packages/transport-web/package.json packages/transport-web/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @paperclip-chat-gateway/core run build \
 && pnpm --filter @paperclip-chat-gateway/auth-oidc run build \
 && pnpm --filter @paperclip-chat-gateway/transport-web run build \
 && pnpm --filter @paperclip-chat-gateway/gateway run build \
 && pnpm deploy --filter @paperclip-chat-gateway/gateway --prod /app/deploy

FROM node:22.12.0-bookworm-slim AS runtime
# No pnpm/corepack usage at runtime (the built app is copied in as plain
# JS and started with `node`), so the Corepack signing-key upgrade above
# doesn't need to be repeated here.
RUN groupadd --system gateway && useradd --system --gid gateway --home-dir /app gateway
WORKDIR /app
COPY --from=build --chown=gateway:gateway /app/deploy ./
# The gateway resolves the UI dist directory at startup via Node module
# resolution against @paperclip-chat-gateway/transport-web's own
# package.json (see apps/gateway/src/ui-dist.ts), then appends `ui/dist`.
# That means the built UI must live at `ui/dist` *relative to wherever
# `pnpm deploy` materialized that package* — i.e. inside its node_modules
# entry, not at some other path that happens to look plausible from the
# repo's source layout. Get this wrong and `assertUiDistExists` fails fast
# at startup with a clear error instead of a runtime 404 on every page load.
COPY --from=build --chown=gateway:gateway /app/packages/transport-web/ui/dist ./node_modules/@paperclip-chat-gateway/transport-web/ui/dist
# Gateway config and per-agent credentials are deliberately NOT baked into
# this image (see .dockerignore: apps/gateway/config/gateway.json and any
# *credentials*.json are excluded from the build context). They contain
# per-deployment employee rosters, employee->agent bindings, and secrets,
# so they must be provided at RUNTIME instead:
#   - mount a real config at the default path, e.g.
#       docker run -v /path/to/gateway.json:/app/config/gateway.json:ro ...
#   - or override the path with GATEWAY_CONFIG_PATH (and
#     CREDENTIAL_STORE_FILE_PATH if CREDENTIAL_STORE_KIND=file)
# See config/gateway.example.json for the config file's shape, and the
# README's "Running the built image" section for the full contract.
# Starting the image without one fails fast with a GatewayConfigError that
# names the env var and the path it looked at (apps/gateway/src/config.ts).
ENV NODE_ENV=production
USER gateway
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
