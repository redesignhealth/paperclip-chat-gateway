import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChatRoutes } from "./routes/chat.js";
import type { GatewayDeps } from "./types.js";

export type { GatewayDeps } from "./types.js";

export interface BuildServerOptions {
  deps: GatewayDeps;
  /** Absolute path to the built UI's static assets (packages/transport-web/ui/dist). Omit in tests. */
  uiDistPath?: string;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: true });

  await app.register(fastifyCookie, { secret: options.deps.cookieSecret });

  app.get("/health", async () => ({ ok: true }));

  registerAuthRoutes(app, options.deps);
  registerChatRoutes(app, options.deps);

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
