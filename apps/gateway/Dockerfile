# syntax=docker/dockerfile:1
# Pinned to a specific Node 22 patch release rather than a floating tag.
# For production, prefer pinning to this tag's immutable digest as well
# (`docker pull` it once and copy the sha256 here).
FROM node:22.12.0-bookworm-slim AS base
RUN corepack enable
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
ENV NODE_ENV=production
USER gateway
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
