import { beforeEach, describe, expect, it } from "vitest";
import {
  BindingTable,
  EnvAgentCredentialStore,
  InMemorySessionStore,
  NotImplementedError,
  PaperclipApiError,
  type ActiveRun,
  type PaperclipClient,
  type PaperclipIssue,
  type PaperclipIssueComment,
  type PostCommentInput,
} from "@paperclip-chat-gateway/core";
import { OidcAdapter, type OidcPort } from "@paperclip-chat-gateway/auth-oidc";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import type { GatewayDeps } from "../src/types.js";

const OIDC_CONFIG = {
  issuerUrl: "https://issuer.example",
  clientId: "gateway-client",
  clientSecret: "gateway-secret",
  redirectUri: "https://gateway.example/auth/callback",
  allowedEmailDomains: ["redesignhealth.com"],
};

class MockIssuerPort implements OidcPort {
  async buildAuthorizationUrl(input: { redirectUri: string; state: string; codeVerifier: string; nonce: string }) {
    return { url: `https://issuer.example/authorize?state=${input.state}&nonce=${input.nonce}`, codeChallenge: "cc" };
  }

  async handleCallback() {
    return { sub: "sub-1", email: "alice@redesignhealth.com", raw: {} };
  }
}

/**
 * Records every call it receives so tests can assert exactly what reached
 * "Paperclip" — in particular, that no client-supplied value ever ends up
 * as the agentId/employeeId a call is scoped to.
 */
class FakePaperclipClient implements PaperclipClient {
  public readonly createConversationIssueCalls: Array<{ agentId: string; title: string }> = [];
  public readonly postCommentCalls: PostCommentInput[] = [];

  constructor(
    private readonly behavior: {
      createConversationIssue?: () => Promise<PaperclipIssue>;
      listComments?: () => Promise<PaperclipIssueComment[]>;
      postComment?: () => Promise<PaperclipIssueComment>;
    } = {},
  ) {}

  async getIssue(): Promise<PaperclipIssue | null> {
    return null;
  }

  async createConversationIssue(input: { agentId: string; title: string }): Promise<PaperclipIssue> {
    this.createConversationIssueCalls.push(input);
    if (this.behavior.createConversationIssue) return this.behavior.createConversationIssue();
    throw new NotImplementedError("createConversationIssue is not implemented in this fake by default");
  }

  async postComment(input: PostCommentInput): Promise<PaperclipIssueComment> {
    this.postCommentCalls.push(input);
    if (this.behavior.postComment) return this.behavior.postComment();
    return { id: "comment-1", body: input.body, authorType: "user", createdAt: new Date().toISOString() };
  }

  async listComments(): Promise<PaperclipIssueComment[]> {
    if (this.behavior.listComments) return this.behavior.listComments();
    return [];
  }

  async getActiveRun(): Promise<ActiveRun | null> {
    return null;
  }
}

function makeDeps(overrides: Partial<GatewayDeps> = {}, client: FakePaperclipClient = new FakePaperclipClient()): GatewayDeps {
  const bindings = BindingTable.fromConfig({
    bindings: [{ employeeId: "emp-alice", agentId: "agent-alice-cfo" }],
  });
  return {
    oidc: new OidcAdapter(OIDC_CONFIG, new MockIssuerPort()),
    bindings,
    credentials: new EnvAgentCredentialStore({
      [EnvAgentCredentialStore.envVarNameFor("agent-alice-cfo")]: "key-alice",
    } as NodeJS.ProcessEnv),
    sessions: new InMemorySessionStore(),
    paperclipClientFor: () => client,
    paperclipApiBaseUrl: "https://paperclip.example/api",
    cookieSecret: "test-cookie-secret-test-cookie-secret",
    resolveEmployeeId: async (claims) => (claims.email === "alice@redesignhealth.com" ? "emp-alice" : null),
    isAdminEmail: () => false,
    ...overrides,
  };
}

/** Logs in as alice and returns the session + CSRF cookie header pair. */
async function loginAsAlice(app: FastifyInstance): Promise<{ cookieHeader: string; csrfToken: string }> {
  const login = await app.inject({ method: "GET", url: "/auth/login" });
  const txnCookieHeader = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const callback = await app.inject({
    method: "GET",
    url: "/auth/callback?code=abc&state=whatever",
    headers: { cookie: txnCookieHeader },
  });

  const sessionCookie = callback.cookies.find((c) => c.name === "pcg_session")!;
  const csrfCookie = callback.cookies.find((c) => c.name === "pcg_csrf")!;
  return {
    cookieHeader: `${sessionCookie.name}=${sessionCookie.value}; ${csrfCookie.name}=${csrfCookie.value}`,
    csrfToken: csrfCookie.value,
  };
}

describe("POST /api/chat/messages — session bootstrap (blocking fix #1)", () => {
  it("returns a graceful 503 (not a 500) when the session doesn't exist and createConversationIssue is unimplemented", async () => {
    const client = new FakePaperclipClient(); // default: createConversationIssue throws NotImplementedError
    const app = await buildServer({ deps: makeDeps({}, client) });
    const { cookieHeader, csrfToken } = await loginAsAlice(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { cookie: cookieHeader, "content-type": "application/json", "x-csrf-token": csrfToken },
      payload: { body: "hello agent" },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/pre-provisioned/i);
  });

  it("succeeds normally once a session already exists (createConversationIssue is never called)", async () => {
    const client = new FakePaperclipClient();
    const sessions = new InMemorySessionStore();
    await sessions.put({ employeeId: "emp-alice", agentId: "agent-alice-cfo", issueId: "issue-existing" });
    const app = await buildServer({ deps: makeDeps({ sessions }, client) });
    const { cookieHeader, csrfToken } = await loginAsAlice(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { cookie: cookieHeader, "content-type": "application/json", "x-csrf-token": csrfToken },
      payload: { body: "hello again" },
    });

    expect(res.statusCode).toBe(200);
    expect(client.createConversationIssueCalls).toHaveLength(0);
    expect(client.postCommentCalls).toEqual([{ issueId: "issue-existing", body: "hello again", resume: true }]);
  });
});

describe("POST /api/chat/messages — CSRF protection", () => {
  it("rejects a write request with no CSRF header even with a valid session cookie", async () => {
    const app = await buildServer({ deps: makeDeps() });
    const { cookieHeader } = await loginAsAlice(app);
    // Split out just the session cookie to simulate a cross-site request
    // that can't read the (non-httpOnly) CSRF cookie or forge the header.
    const sessionOnly = cookieHeader.split("; ")[0];

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { cookie: sessionOnly, "content-type": "application/json" },
      payload: { body: "hello" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a write request whose CSRF header doesn't match the cookie", async () => {
    const app = await buildServer({ deps: makeDeps() });
    const { cookieHeader } = await loginAsAlice(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { cookie: cookieHeader, "content-type": "application/json", "x-csrf-token": "totally-wrong-token" },
      payload: { body: "hello" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/chat/messages — attribution can never come from the client", () => {
  it("ignores client-supplied agentId/employeeId/responsibleUserId in the request body: routing and issue title still come only from the authenticated session and BindingTable", async () => {
    const client = new FakePaperclipClient({
      createConversationIssue: async () => ({
        id: "issue-new",
        companyId: "company-1",
        title: "t",
        status: "in_progress",
        assigneeAgentId: "agent-alice-cfo",
      }),
    });
    const app = await buildServer({ deps: makeDeps({}, client) });
    const { cookieHeader, csrfToken } = await loginAsAlice(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { cookie: cookieHeader, "content-type": "application/json", "x-csrf-token": csrfToken },
      payload: {
        body: "hello",
        // None of these fields exist in sendMessageSchema; zod strips them,
        // and there is no code path that reads req.body for routing at all.
        agentId: "agent-mallory-controlled",
        employeeId: "emp-mallory",
        responsibleUserId: "emp-mallory",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(client.createConversationIssueCalls).toEqual([{ agentId: "agent-alice-cfo", title: expect.stringContaining("agent-alice-cfo") }]);
    expect(client.postCommentCalls[0]?.issueId).toBe("issue-new");
  });
});

describe("POST /api/chat/messages — resume:true contract", () => {
  it("always sends resume: true when relaying a message, regardless of caller input", async () => {
    const client = new FakePaperclipClient();
    const sessions = new InMemorySessionStore();
    await sessions.put({ employeeId: "emp-alice", agentId: "agent-alice-cfo", issueId: "issue-1" });
    const app = await buildServer({ deps: makeDeps({ sessions }, client) });
    const { cookieHeader, csrfToken } = await loginAsAlice(app);

    await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { cookie: cookieHeader, "content-type": "application/json", "x-csrf-token": csrfToken },
      payload: { body: "hi" },
    });

    expect(client.postCommentCalls).toHaveLength(1);
    expect(client.postCommentCalls[0].resume).toBe(true);
  });
});

describe("GET /api/chat/messages — upstream error sanitization", () => {
  it("maps a PaperclipApiError to a 502 without leaking the upstream response body to the client", async () => {
    const client = new FakePaperclipClient({
      listComments: async () => {
        throw new PaperclipApiError(500, { secretUpstreamDebugInfo: "internal-trace-id-12345" }, "boom");
      },
    });
    const sessions = new InMemorySessionStore();
    await sessions.put({ employeeId: "emp-alice", agentId: "agent-alice-cfo", issueId: "issue-1" });
    const app = await buildServer({ deps: makeDeps({ sessions }, client) });
    const { cookieHeader } = await loginAsAlice(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/chat/messages",
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(JSON.stringify(body)).not.toContain("secretUpstreamDebugInfo");
    expect(JSON.stringify(body)).not.toContain("internal-trace-id-12345");
  });
});

describe("GET /api/chat/session", () => {
  let deps: GatewayDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("returns 404 with a null issueId when no session exists yet", async () => {
    const app = await buildServer({ deps });
    const { cookieHeader } = await loginAsAlice(app);

    const res = await app.inject({ method: "GET", url: "/api/chat/session", headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ agentId: "agent-alice-cfo", issueId: null });
  });
});
