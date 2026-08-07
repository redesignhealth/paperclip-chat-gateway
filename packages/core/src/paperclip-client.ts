/**
 * PaperclipClient is the ONLY place in the gateway that knows Paperclip's
 * actual HTTP surface. Every other package talks to this interface, not to
 * `fetch` against Paperclip directly, so API drift is contained to one
 * file. See docs/paperclip-api.md for the endpoints this was coded
 * against, with upstream file references.
 */

import { z } from "zod";

export interface PaperclipIssueComment {
  id: string;
  body: string;
  authorType: string;
  createdAt: string;
}

export interface PaperclipIssue {
  id: string;
  companyId: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
}

export interface PostCommentInput {
  issueId: string;
  body: string;
  /** Ask Paperclip to move a blocked/done issue back to in-progress. */
  resume?: boolean;
}

export interface ActiveRun {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | string;
  agentId: string;
  lastOutputAt: string | null;
}

/**
 * Narrow, gateway-shaped view of Paperclip. Deliberately does NOT expose
 * Paperclip's full issue/agent/company surface — only what a 1:1 chat
 * relay needs: read an issue, post a comment (which Paperclip itself turns
 * into an agent wakeup), and poll for the active run so the UI can show
 * "thinking..." / stream-ish status.
 */
export interface PaperclipClient {
  getIssue(issueId: string): Promise<PaperclipIssue | null>;
  /** Creates a new issue assigned to `agentId`, used to open a fresh session. */
  createConversationIssue(input: { agentId: string; title: string }): Promise<PaperclipIssue>;
  postComment(input: PostCommentInput): Promise<PaperclipIssueComment>;
  listComments(issueId: string): Promise<PaperclipIssueComment[]>;
  getActiveRun(issueId: string): Promise<ActiveRun | null>;
}

/**
 * Runtime shape validation for everything Paperclip returns. This project's
 * convention is "zod at every boundary"; without this, upstream API drift
 * (a renamed/removed field) would silently propagate an `undefined` deep
 * into the UI instead of failing loudly at the one place that talks HTTP.
 */
const paperclipIssueSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  title: z.string(),
  status: z.string(),
  assigneeAgentId: z.string().nullable(),
}) satisfies z.ZodType<PaperclipIssue>;

const paperclipIssueCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  authorType: z.string(),
  createdAt: z.string(),
}) satisfies z.ZodType<PaperclipIssueComment>;

const activeRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  agentId: z.string(),
  lastOutputAt: z.string().nullable(),
}) satisfies z.ZodType<ActiveRun>;

export class PaperclipApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "PaperclipApiError";
  }
}

export interface HttpPaperclipClientOptions {
  /** Base URL of the Paperclip API server, e.g. https://paperclip.example.com/api */
  baseUrl: string;
  /** Scoped per-agent Paperclip API key (see AgentCredentialStore). */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * Real implementation, coded against the endpoints documented in
 * docs/paperclip-api.md:
 *
 * - GET  /issues/:id
 * - POST /issues/:id/comments        (this is how a message is "sent" —
 *   Paperclip wakes the assignee agent as a side effect of the comment)
 * - GET  /issues/:id/comments
 * - GET  /issues/:issueId/active-run
 *
 * Auth: `Authorization: Bearer <scoped agent key>`, matching Paperclip's
 * agent API key middleware (server/src/middleware/auth.ts upstream).
 *
 * Issue creation for opening a brand-new conversation is intentionally
 * left as a documented gap — see docs/paperclip-api.md — because upstream
 * issue creation requires a company id and project/goal linkage this
 * gateway does not otherwise need to know about. `createConversationIssue`
 * throws `NotImplementedError` until that's resolved with a real Paperclip
 * deployment to test against.
 */
export class HttpPaperclipClient implements PaperclipClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpPaperclipClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new PaperclipApiError(response.status, body, `Paperclip API request to ${path} failed with ${response.status}`);
    }
    const json = await response.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new PaperclipApiError(
        response.status,
        json,
        `Paperclip API response from ${path} did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  async getIssue(issueId: string): Promise<PaperclipIssue | null> {
    try {
      return await this.request(`/issues/${encodeURIComponent(issueId)}`, paperclipIssueSchema);
    } catch (error) {
      if (error instanceof PaperclipApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createConversationIssue(input: { agentId: string; title: string }): Promise<PaperclipIssue> {
    throw new NotImplementedError(
      `createConversationIssue(agentId="${input.agentId}") requires upstream issue-creation fields ` +
        "(companyId, project/goal linkage) not yet finalized against a real Paperclip deployment. " +
        "See docs/paperclip-api.md.",
    );
  }

  async postComment(input: PostCommentInput): Promise<PaperclipIssueComment> {
    return this.request(`/issues/${encodeURIComponent(input.issueId)}/comments`, paperclipIssueCommentSchema, {
      method: "POST",
      body: JSON.stringify({ body: input.body, resume: input.resume }),
    });
  }

  async listComments(issueId: string): Promise<PaperclipIssueComment[]> {
    return this.request(`/issues/${encodeURIComponent(issueId)}/comments`, z.array(paperclipIssueCommentSchema));
  }

  async getActiveRun(issueId: string): Promise<ActiveRun | null> {
    try {
      return await this.request(`/issues/${encodeURIComponent(issueId)}/active-run`, activeRunSchema.nullable());
    } catch (error) {
      if (error instanceof PaperclipApiError && error.status === 404) return null;
      throw error;
    }
  }
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
