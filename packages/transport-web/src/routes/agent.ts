import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentTokenVerificationError, NotImplementedError, verifyAgentRunToken } from "@paperclip-chat-gateway/core";
import type { GatewayDeps } from "../types.js";

const BEARER_PREFIX = "Bearer ";

function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  // RFC 7235 auth-scheme names are case-insensitive ("Bearer" vs "bearer"),
  // so match the prefix case-insensitively rather than requiring the exact
  // casing Paperclip's own client happens to send today.
  if (!header || header.length < BEARER_PREFIX.length || header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX.toLowerCase()) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

interface AuthenticatedAgentCall {
  agentId: string;
  runId: string;
  employeeId: string;
}

/**
 * Gateway-brokered agent identity verification: the security core of this
 * route. Two independent checks gate every call, and both must pass:
 *
 *  1. Cryptographic: `verifyAgentRunToken` proves the bearer token is a
 *     genuinely Paperclip-signed run token (HS256, correct derived key,
 *     unexpired) and yields only `agentId`/`runId` — never a human claim.
 *  2. Authorization: `bindings.resolveEmployeeFor(agentId)` is the ONLY
 *     source of truth for which human (if any) this agentId acts for.
 *     Deny-by-default — an agentId with no configured binding is rejected
 *     here, not passed through with a null/guessed employeeId.
 *
 * Nothing else — not the request body, not any other header, not a
 * `responsible_user_id` claim the token might carry (it doesn't; see
 * agent-token.ts) — can influence which employeeId this call is attributed
 * to downstream.
 */
async function authenticateAgentCall(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: GatewayDeps,
): Promise<AuthenticatedAgentCall | null> {
  // Callers only reach this function once registerAgentRoutes has confirmed
  // agentTokenConfig/schedulerClient are present (see below) — asserted here
  // only to satisfy the type checker inside the still-optional GatewayDeps shape.
  if (!deps.agentTokenConfig) {
    throw new Error("authenticateAgentCall invoked without agentTokenConfig; this is a bug in route registration");
  }

  const token = extractBearerToken(req);
  if (!token) {
    reply.code(401).send({ error: "Missing bearer token." });
    return null;
  }

  let verified;
  try {
    verified = await verifyAgentRunToken(token, deps.agentTokenConfig);
  } catch (error) {
    if (error instanceof AgentTokenVerificationError) {
      req.log.warn({ reason: error.message }, "agent run token rejected");
      reply.code(401).send({ error: "Invalid or expired agent token." });
      return null;
    }
    throw error;
  }

  const employeeId = await deps.bindings.resolveEmployeeFor(verified.agentId);
  if (!employeeId) {
    req.log.warn({ agentId: verified.agentId }, "no employee bound to this agentId; denying by default");
    reply.code(403).send({ error: "This agent is not bound to any employee." });
    return null;
  }

  return { agentId: verified.agentId, runId: verified.runId, employeeId };
}

/** Mirrors `chat.ts`'s `sendMessageSchema` body bound (`.max(8000)`). */
const MAX_ACTION_LENGTH = 8000;

/**
 * `payload` is opaque (see below) so it can't be bounded by shape, only by
 * serialized size — this caps it well under Fastify's default 1MiB
 * `bodyLimit` so a single oversized-but-still-parseable payload can't be
 * used to pressure downstream services or this process's memory.
 */
const MAX_PAYLOAD_BYTES = 32 * 1024;

/**
 * Deliberately generic: the downstream scheduler's real request/response
 * vocabulary is not known from source (see README's "Open transport
 * question" and `HttpSchedulerClient`), so this schema only constrains the
 * shape the *gateway* needs to route the call — an action name and an
 * opaque payload — rather than inventing scheduler-specific fields.
 */
const brokerRequestSchema = z.object({
  action: z.string().min(1).max(MAX_ACTION_LENGTH),
  payload: z
    .unknown()
    .optional()
    .refine((value) => value === undefined || Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") <= MAX_PAYLOAD_BYTES, {
      message: `payload must serialize to at most ${MAX_PAYLOAD_BYTES} bytes`,
    }),
});

/**
 * Agent-facing broker route: the mirror image of `routes/chat.ts`. Chat
 * routes authenticate a human and call out to Paperclip on their behalf;
 * this route authenticates a Paperclip agent run and calls out to the
 * downstream scheduler on behalf of the human that agent is bound to.
 *
 * OPT-IN: registers nothing at all when `deps.agentTokenConfig` is unset —
 * see `GatewayDeps.agentTokenConfig`. A deployment that hasn't configured
 * the agent broker gets no `/api/agent/scheduler` route (404, not a
 * confusing 401/501) and every other route is unaffected.
 */
export function registerAgentRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  if (!deps.agentTokenConfig || !deps.schedulerClient) {
    app.log.info("agent broker disabled (AGENT_JWT_SECRET not configured) — /api/agent/scheduler not registered");
    return;
  }

  app.post("/api/agent/scheduler", async (req, reply) => {
    const auth = await authenticateAgentCall(req, reply, deps);
    if (!auth) return;

    const parsed = brokerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ err: parsed.error.message }, "agent broker request body failed validation");
      reply.code(400).send({ error: "Invalid request body." });
      return;
    }

    try {
      const result = await deps.schedulerClient!.forward({
        employeeId: auth.employeeId,
        agentId: auth.agentId,
        runId: auth.runId,
        action: parsed.data.action,
        payload: parsed.data.payload,
      });
      reply.send(result ?? { ok: true });
    } catch (error) {
      if (error instanceof NotImplementedError) {
        req.log.warn({ err: error.message }, "downstream scheduler call not implemented");
        reply.code(501).send({ error: "Downstream scheduler is not configured for this deployment." });
        return;
      }
      throw error;
    }
  });
}
