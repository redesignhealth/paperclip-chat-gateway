import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { NotImplementedError, PaperclipApiError, sessionKeyFor } from "@paperclip-chat-gateway/core";
import type { GatewayDeps } from "../types.js";
import { readSessionEmployeeId, requireCsrf } from "./auth.js";

const sendMessageSchema = z.object({
  body: z.string().min(1).max(8000),
});

/**
 * Route-scoped auth guard, attached per-route via each route's `preHandler`
 * option rather than a blanket `app.addHook("preHandler", ...)` that
 * pattern-matches on `req.url.startsWith("/api/chat")`. A string-prefix
 * check is fragile: any future route registered outside that exact prefix
 * (a typo, a moved path, a route mounted by another plugin) would silently
 * bypass authentication instead of failing to compile/register. Attaching
 * the guard directly to each route makes "is this route authenticated?"
 * visible at the call site and impossible to accidentally skip.
 */
async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const employeeId = readSessionEmployeeId(req);
  if (!employeeId) {
    reply.code(401).send({ error: "Not authenticated." });
    return;
  }
  (req as { employeeId?: string }).employeeId = employeeId;
}

/** Logs and maps a PaperclipApiError without leaking upstream response bodies into logs or the client response. */
function handlePaperclipApiError(req: FastifyRequest, reply: FastifyReply, error: PaperclipApiError): void {
  req.log.error({ status: error.status }, "Paperclip API request failed");
  reply.code(502).send({ error: "The agent's backend is temporarily unavailable. Please try again." });
}

/**
 * The core enforcement point: every chat route resolves "which agent may
 * this employee talk to" via BindingTable, and pulls that agent's — and
 * only that agent's — credential from AgentCredentialStore. There is no
 * code path here that accepts an agentId (or any other attribution, such
 * as a Paperclip `responsibleUserId`) from the request body — the only
 * client-controlled field accepted by `sendMessageSchema` is the message
 * `body` text itself, and zod strips any other keys a client might send.
 */
export function registerChatRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  app.get("/api/chat/session", { preHandler: requireAuth }, async (req, reply) => {
    const employeeId = (req as { employeeId?: string }).employeeId!;
    const agentId = deps.bindings.resolveAgentFor(employeeId);
    if (!agentId) {
      reply.code(403).send({ error: "No agent is bound to this identity." });
      return;
    }

    const existing = await deps.sessions.get(employeeId, agentId);
    if (!existing) {
      reply.code(404).send({ agentId, issueId: null });
      return;
    }
    reply.send({ agentId, issueId: existing.issueId });
  });

  app.get("/api/chat/messages", { preHandler: requireAuth }, async (req, reply) => {
    const employeeId = (req as { employeeId?: string }).employeeId!;
    const agentId = deps.bindings.resolveAgentFor(employeeId);
    if (!agentId) {
      reply.code(403).send({ error: "No agent is bound to this identity." });
      return;
    }
    const session = await deps.sessions.get(employeeId, agentId);
    if (!session) {
      reply.send({ messages: [] });
      return;
    }

    const apiKey = await deps.credentials.getKeyFor(agentId);
    if (!apiKey) {
      req.log.error({ agentId }, "no credential configured for bound agent");
      reply.code(503).send({ error: "Agent is not available right now." });
      return;
    }
    const client = deps.paperclipClientFor(agentId, apiKey);
    try {
      const comments = await client.listComments(session.issueId);
      reply.send({ messages: comments });
    } catch (error) {
      if (error instanceof PaperclipApiError) {
        handlePaperclipApiError(req, reply, error);
        return;
      }
      throw error;
    }
  });

  app.post("/api/chat/messages", { preHandler: [requireAuth, requireCsrf] }, async (req, reply) => {
    const employeeId = (req as { employeeId?: string }).employeeId!;
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.message });
      return;
    }

    // Deny by default: resolveAgentFor is the *only* source of truth for
    // which agent this employee may reach. There is no fallback agent, and
    // — see the module docstring — no field in `parsed.data` can influence
    // which agent this message goes to or whose identity Paperclip
    // attributes it to.
    const agentId = deps.bindings.resolveAgentFor(employeeId);
    if (!agentId) {
      reply.code(403).send({ error: "No agent is bound to this identity." });
      return;
    }

    const apiKey = await deps.credentials.getKeyFor(agentId);
    if (!apiKey) {
      req.log.error({ agentId }, "no credential configured for bound agent");
      reply.code(503).send({ error: "Agent is not available right now." });
      return;
    }

    const client = deps.paperclipClientFor(agentId, apiKey);
    let session = await deps.sessions.get(employeeId, agentId);
    if (!session) {
      try {
        const issue = await client.createConversationIssue({
          agentId,
          title: `Chat: ${sessionKeyFor(employeeId, agentId)}`,
        });
        session = { employeeId, agentId, issueId: issue.id };
        await deps.sessions.put(session);
      } catch (error) {
        if (error instanceof NotImplementedError) {
          // This is the *first message* path for every employee, every
          // process restart (InMemorySessionStore starts empty) — it must
          // never fall through to an uncaught 500. Fail loudly but
          // gracefully: the client gets a clear, actionable reason instead
          // of a stack trace.
          req.log.warn({ agentId, err: error }, "session bootstrap requires a pre-provisioned Paperclip issue");
          reply.code(503).send({
            error:
              "Starting a new conversation isn't supported yet: session bootstrap requires a " +
              "pre-provisioned Paperclip issue for this agent. Ask an operator to seed one, or reply " +
              "to an existing conversation.",
          });
          return;
        }
        if (error instanceof PaperclipApiError) {
          handlePaperclipApiError(req, reply, error);
          return;
        }
        throw error;
      }
    }

    try {
      const comment = await client.postComment({ issueId: session.issueId, body: parsed.data.body, resume: true });
      reply.send({ comment });
    } catch (error) {
      if (error instanceof PaperclipApiError) {
        handlePaperclipApiError(req, reply, error);
        return;
      }
      throw error;
    }
  });
}
