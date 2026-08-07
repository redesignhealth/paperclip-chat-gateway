import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChatRoutes } from "./routes/chat.js";
import type { GatewayDeps } from "./types.js";

export type { AdminBackend, BindingResolver, GatewayDeps } from "./types.js";

export interface BuildServerOptions {
  deps: GatewayDeps;
  /** Absolute path to the built UI's static assets (packages/transport-web/ui/dist). Omit in tests. */
  uiDistPath?: string;
  /**
   * Fastify's `trustProxy` option, controlling whether `req.protocol` /
   * `req.hostname` (fed into the OIDC callback URL) are taken from
   * client-supplied `X-Forwarded-*` headers. Defaults to `false`
   * (don't trust any forwarded headers) — pass the specific proxy
   * IP/CIDR/hop-count for your deployment topology instead of blanket
   * `true`, which would let ANY client spoof its own protocol/host by
   * setting those headers when nothing strips them first.
   */
  trustProxy?: boolean | string | string[] | number;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: options.trustProxy ?? false });

  await app.register(fastifyCookie, { secret: options.deps.cookieSecret });

  app.get("/health", async () => ({ ok: true }));

  registerAuthRoutes(app, options.deps);
  registerChatRoutes(app, options.deps);
  registerAgentRoutes(app, options.deps);
  registerAdminRoutes(app, options.deps);

  if (options.uiDistPath) {
    await app.register(fastifyStatic, {
      root: path.resolve(options.uiDistPath),
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api") || req.raw.url?.startsWith("/auth")) {
        reply.code(404).send({ error: "Not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  return app;
}
