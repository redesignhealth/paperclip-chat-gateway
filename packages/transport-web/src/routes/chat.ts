import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionKeyFor } from "@paperclip-chat-gateway/core";
import type { GatewayDeps } from "../types.js";
import { readSessionEmployeeId } from "./auth.js";

const sendMessageSchema = z.object({
  body: z.string().min(1).max(8000),
});

/**
 * The core enforcement point: every chat route resolves "which agent may
 * this employee talk to" via BindingTable, and pulls that agent's — and
 * only that agent's — credential from AgentCredentialStore. There is no
 * code path here that accepts an agentId from the request body.
 */
export function registerChatRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/chat")) return;
    const employeeId = readSessionEmployeeId(req);
    if (!employeeId) {
      reply.code(401).send({ error: "Not authenticated." });
      return;
    }
    (req as { employeeId?: string }).employeeId = employeeId;
  });

  app.get("/api/chat/session", async (req, reply) => {
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

  app.get("/api/chat/messages", async (req, reply) => {
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
    const comments = await client.listComments(session.issueId);
    reply.send({ messages: comments });
  });

  app.post("/api/chat/messages", async (req, reply) => {
    const employeeId = (req as { employeeId?: string }).employeeId!;
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.message });
      return;
    }

    // Deny by default: resolveAgentFor is the *only* source of truth for
    // which agent this employee may reach. There is no fallback agent.
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
      const issue = await client.createConversationIssue({
        agentId,
        title: `Chat: ${sessionKeyFor(employeeId, agentId)}`,
      });
      session = { employeeId, agentId, issueId: issue.id };
      await deps.sessions.put(session);
    }

    const comment = await client.postComment({ issueId: session.issueId, body: parsed.data.body, resume: true });
    reply.send({ comment });
  });
}
