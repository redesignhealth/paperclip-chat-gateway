import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { GatewayDeps } from "../types.js";
import { readSessionEmail, requireAuth, requireCsrf } from "./auth.js";

/**
 * Admin allowlist guard. Fails closed by construction: `deps.isAdminEmail`
 * (backed by `GATEWAY_ADMIN_EMAILS`, see apps/gateway/src/config.ts) must
 * return `false` for every email when the allowlist is unset/empty, so an
 * operator who forgets to set it gets "nobody is admin" — never
 * "everybody is admin." This guard runs strictly after `requireAuth`
 * (see each route's `preHandler` array below), so `readSessionEmail` is
 * reading a cookie `requireAuth` has already validated the presence of.
 */
async function requireAdmin(req: FastifyRequest, reply: FastifyReply, deps: GatewayDeps): Promise<void> {
  const email = readSessionEmail(req);
  if (!email || !deps.isAdminEmail(email)) {
    reply.code(403).send({ error: "Admin access required." });
    return;
  }
}

const registerAgentSchema = z.object({
  agentId: z.string().min(1),
  apiKey: z.string().min(1),
  kind: z.enum(["personal", "shared"]).optional(),
});

const grantAccessSchema = z.object({
  employeeId: z.string().min(1),
  agentId: z.string().min(1),
  role: z.enum(["owner", "member"]).optional(),
});

const revokeAccessSchema = z.object({
  employeeId: z.string().min(1),
  agentId: z.string().min(1),
});

/**
 * Admin endpoints backing agent registration and person<->agent grants
 * (replacing the old "edit an EFS file + write an SSM param + terraform
 * apply + restart" onboarding flow). OPT-IN: registers nothing when
 * `deps.admin` is unset (e.g. the file/env store is active) — same pattern
 * as the agent broker route in routes/agent.ts.
 *
 * Every route here requires BOTH `requireAuth` (a valid session) AND
 * `requireAdmin` (the session's verified email is on the
 * `GATEWAY_ADMIN_EMAILS` allowlist) as `preHandler`s, in that order, plus
 * `requireCsrf` on every state-changing (non-GET) route — the same
 * double-submit CSRF protection chat's POST route uses.
 *
 * No route here ever returns key material: `registerAgent`'s request body
 * carries a plaintext key in (never out), and `listAgents`'s response only
 * ever reports `hasCredential: boolean` — see AdminStore's own doc
 * comments in packages/store-postgres/src/admin.ts.
 */
export function registerAdminRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  if (!deps.admin) {
    app.log.info("admin API disabled (no DB-backed store configured) — /api/admin/* not registered");
    return;
  }
  const admin = deps.admin;

  const adminPreHandler = [requireAuth, (req: FastifyRequest, reply: FastifyReply) => requireAdmin(req, reply, deps)];

  app.post("/api/admin/agents", { preHandler: [...adminPreHandler, requireCsrf] }, async (req, reply) => {
    const parsed = registerAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.message });
      return;
    }
    try {
      await admin.registerAgent(parsed.data);
      reply.code(201).send({ agentId: parsed.data.agentId });
    } catch (error) {
      req.log.error({ err: (error as Error).name }, "failed to register agent");
      reply.code(409).send({ error: (error as Error).message });
    }
  });

  app.get("/api/admin/agents", { preHandler: adminPreHandler }, async (_req, reply) => {
    const agents = await admin.listAgents();
    reply.send({ agents });
  });

  app.post("/api/admin/grants", { preHandler: [...adminPreHandler, requireCsrf] }, async (req, reply) => {
    const parsed = grantAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.message });
      return;
    }
    const grantedBy = readSessionEmail(req) ?? "unknown-admin";
    try {
      await admin.grantAccess({ ...parsed.data, grantedBy });
      reply.code(201).send({ ok: true });
    } catch (error) {
      req.log.warn({ err: (error as Error).name }, "grantAccess rejected");
      reply.code(409).send({ error: (error as Error).message });
    }
  });

  app.post("/api/admin/revocations", { preHandler: [...adminPreHandler, requireCsrf] }, async (req, reply) => {
    const parsed = revokeAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.message });
      return;
    }
    const revoked = await admin.revokeAccess(parsed.data);
    if (!revoked) {
      reply.code(404).send({ error: "No active grant found for that employee/agent pair." });
      return;
    }
    reply.send({ ok: true });
  });
}
