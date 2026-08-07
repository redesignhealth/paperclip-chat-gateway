/**
 * Session model: issue-backed, mirroring Paperclip's own conversational
 * design (see doc/plans/2026-03-11-agent-chat-ui-and-issue-backed-
 * conversations.md upstream). Paperclip has no separate chat/thread
 * object — the durable record of a conversation is a Paperclip issue, and
 * "sending a message" is posting a comment on that issue. The gateway
 * adopts the same idea instead of inventing its own transcript store:
 *
 * - one ChatSession == one Paperclip issue, keyed by (employeeId, agentId)
 * - resuming a conversation later means reopening/commenting on the same
 *   issue, not looking up a separate session table
 * - the gateway does not persist message history itself; Paperclip's
 *   issue comments are the source of truth
 *
 * This package only models the mapping; it does not know how issues are
 * created or fetched — that's PaperclipClient's job.
 */

export interface ChatSession {
  employeeId: string;
  agentId: string;
  /** The Paperclip issue id backing this conversation. */
  issueId: string;
}

/**
 * Deterministic, collision-resistant key for an (employee, agent) pair.
 * Used by session lookup/creation so "does this pair already have an
 * issue?" is a stable, cacheable question.
 *
 * `employeeId`/`agentId` are percent-encoded before interpolation so a
 * crafted id containing the literal delimiter text (e.g. an agentId of
 * `"agent:x"`) can never be engineered to collide two distinct pairs onto
 * the same key. `encodeURIComponent` escapes `:` (and every other
 * character outside its narrow unreserved set), so the only way `:` can
 * appear in the resulting string is as one of the two fixed delimiters
 * this function itself inserts.
 */
export function sessionKeyFor(employeeId: string, agentId: string): string {
  return `employee:${encodeURIComponent(employeeId)}:agent:${encodeURIComponent(agentId)}`;
}

/**
 * Minimal store for the employee/agent -> issue mapping. A real deployment
 * might back this with a small KV table; v1 ships an in-memory
 * implementation suitable for a single-instance gateway process, since the
 * durable state (comments, run history) already lives in Paperclip.
 */
export interface SessionStore {
  get(employeeId: string, agentId: string): Promise<ChatSession | null>;
  put(session: ChatSession): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ChatSession>();

  async get(employeeId: string, agentId: string): Promise<ChatSession | null> {
    return this.sessions.get(sessionKeyFor(employeeId, agentId)) ?? null;
  }

  async put(session: ChatSession): Promise<void> {
    this.sessions.set(sessionKeyFor(session.employeeId, session.agentId), session);
  }
}
