import { beforeEach, describe, expect, it } from "vitest";
import { BindingTable, EnvAgentCredentialStore, InMemorySessionStore } from "@paperclip-chat-gateway/core";
import { OidcAdapter, type OidcPort } from "@paperclip-chat-gateway/auth-oidc";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import type { AdminBackend, GatewayDeps } from "../src/types.js";

const OIDC_CONFIG = {
  issuerUrl: "https://issuer.example",
  clientId: "gateway-client",
  clientSecret: "gateway-secret",
  redirectUri: "https://gateway.example/auth/callback",
  allowedEmailDomains: ["redesignhealth.com"],
};

class MockIssuerPort implements OidcPort {
  constructor(private readonly claims: { sub: string; email: string }) {}
  async buildAuthorizationUrl(input: { state: string; nonce: string }) {
    return { url: `https://issuer.example/authorize?state=${input.state}&nonce=${input.nonce}`, codeChallenge: "cc" };
  }
  async handleCallback() {
    return { ...this.claims, raw: { ...this.claims } };
  }
}

/** Records every call so tests can assert admin writes never reach the backend when auth/allowlist checks should have blocked them. */
class FakeAdminBackend implements AdminBackend {
  public registerAgentCalls: Array<{ agentId: string; apiKey: string; kind?: "personal" | "shared" }> = [];
  public grantAccessCalls: Array<{ employeeId: string; agentId: string; grantedBy: string; role?: "owner" | "member" }> = [];
  public revokeAccessCalls: Array<{ employeeId: string; agentId: string }> = [];

  async registerAgent(params: { agentId: string; apiKey: string; kind?: "personal" | "shared" }): Promise<void> {
    this.registerAgentCalls.push(params);
  }
  async listAgents() {
    return [{ agentId: "agent-1", kind: "personal" as const, hasCredential: true, createdAt: new Date() }];
  }
  async grantAccess(params: { employeeId: string; agentId: string; grantedBy: string; role?: "owner" | "member" }): Promise<void> {
    this.grantAccessCalls.push(params);
  }
  async revokeAccess(params: { employeeId: string; agentId: string }): Promise<boolean> {
    this.revokeAccessCalls.push(params);
    return true;
  }
}

function makeDeps(overrides: Partial<GatewayDeps> = {}, email = "alice@redesignhealth.com"): GatewayDeps {
  const bindings = BindingTable.fromConfig({ bindings: [] });
  return {
    oidc: new OidcAdapter(OIDC_CONFIG, new MockIssuerPort({ sub: "sub-1", email })),
    bindings,
    credentials: new EnvAgentCredentialStore({} as NodeJS.ProcessEnv),
    sessions: new InMemorySessionStore(),
    paperclipClientFor: () => {
      throw new Error("not used in these tests");
    },
    paperclipApiBaseUrl: "https://paperclip.example/api",
    cookieSecret: "test-cookie-secret-test-cookie-secret",
    resolveEmployeeId: async () => "emp-alice",
    isAdminEmail: () => false,
    ...overrides,
  };
}

/** Logs in via the OIDC happy path and returns the session + CSRF cookie header pair. */
async function login(app: FastifyInstance): Promise<{ cookieHeader: string; csrfToken: string }> {
  const loginResp = await app.inject({ method: "GET", url: "/auth/login" });
  const txnCookieHeader = loginResp.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

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

describe("admin API", () => {
  let admin: FakeAdminBackend;

  beforeEach(() => {
    admin = new FakeAdminBackend();
  });

  it("is not registered at all when deps.admin is unset (file/env store active)", async () => {
    const app = await buildServer({ deps: makeDeps({ admin: undefined, isAdminEmail: () => true }) });
    const { cookieHeader } = await login(app);
    const resp = await app.inject({ method: "GET", url: "/api/admin/agents", headers: { cookie: cookieHeader } });
    expect(resp.statusCode).toBe(404);
  });

  it("rejects an unauthenticated caller with 401, before the allowlist is even consulted", async () => {
    const app = await buildServer({ deps: makeDeps({ admin, isAdminEmail: () => true }) });
    const resp = await app.inject({ method: "GET", url: "/api/admin/agents" });
    expect(resp.statusCode).toBe(401);
  });

  it("rejects an authenticated non-admin with a clean 403, and never touches the backend", async () => {
    const app = await buildServer({ deps: makeDeps({ admin, isAdminEmail: () => false }) });
    const { cookieHeader } = await login(app);
    const resp = await app.inject({ method: "GET", url: "/api/admin/agents", headers: { cookie: cookieHeader } });
    expect(resp.statusCode).toBe(403);
  });

  it("fails closed: GATEWAY_ADMIN_EMAILS unset (isAdminEmail always false) means literally nobody is admin, even the one authenticated user", async () => {
    const app = await buildServer({ deps: makeDeps({ admin, isAdminEmail: () => false }, "alice@redesignhealth.com") });
    const { cookieHeader, csrfToken } = await login(app);

    const getResp = await app.inject({ method: "GET", url: "/api/admin/agents", headers: { cookie: cookieHeader } });
    expect(getResp.statusCode).toBe(403);

    const postResp = await app.inject({
      method: "POST",
      url: "/api/admin/agents",
      headers: { cookie: cookieHeader, "x-csrf-token": csrfToken, "content-type": "application/json" },
      payload: { agentId: "agent-new", apiKey: "pk_new" },
    });
    expect(postResp.statusCode).toBe(403);
    expect(admin.registerAgentCalls).toHaveLength(0);
  });

  it("allows an allowlisted admin to list agents", async () => {
    const app = await buildServer({ deps: makeDeps({ admin, isAdminEmail: (email) => email === "alice@redesignhealth.com" }) });
    const { cookieHeader } = await login(app);
    const resp = await app.inject({ method: "GET", url: "/api/admin/agents", headers: { cookie: cookieHeader } });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ agents: [{ agentId: "agent-1", kind: "personal", hasCredential: true, createdAt: expect.any(String) }] });
  });

  it("matches the admin allowlist case-insensitively", async () => {
    const app = await buildServer({
      deps: makeDeps(
        { admin, isAdminEmail: (email) => email === "alice@redesignhealth.com" },
        "Alice@RedesignHealth.com",
      ),
    });
    const { cookieHeader } = await login(app);
    const resp = await app.inject({ method: "GET", url: "/api/admin/agents", headers: { cookie: cookieHeader } });
    expect(resp.statusCode).toBe(200);
  });

  it("admin write routes require CSRF like chat's write route does", async () => {
    const app = await buildServer({ deps: makeDeps({ admin, isAdminEmail: () => true }) });
    const { cookieHeader } = await login(app);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/agents",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { agentId: "agent-new", apiKey: "pk_new" },
    });
    expect(resp.statusCode).toBe(403);
    expect(admin.registerAgentCalls).toHaveLength(0);
  });

  it("registers an agent and never echoes the submitted key back in the response", async () => {
    const app = await buildServer({ deps: makeDeps({ admin, isAdminEmail: () => true }) });
    const { cookieHeader, csrfToken } = await login(app);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/agents",
      headers: { cookie: cookieHeader, "x-csrf-token": csrfToken, "content-type": "application/json" },
      payload: { agentId: "agent-new", apiKey: "pk_super_secret" },
    });
    expect(resp.statusCode).toBe(201);
    expect(resp.body).not.toContain("pk_super_secret");
    expect(admin.registerAgentCalls).toEqual([{ agentId: "agent-new", apiKey: "pk_super_secret" }]);
  });

  it("grants access, attributing grantedBy to the admin's own session email", async () => {
    const app = await buildServer({ deps: makeDeps({ admin, isAdminEmail: () => true }) });
    const { cookieHeader, csrfToken } = await login(app);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/grants",
      headers: { cookie: cookieHeader, "x-csrf-token": csrfToken, "content-type": "application/json" },
      payload: { employeeId: "emp-bob", agentId: "agent-1" },
    });
    expect(resp.statusCode).toBe(201);
    expect(admin.grantAccessCalls).toEqual([{ employeeId: "emp-bob", agentId: "agent-1", grantedBy: "alice@redesignhealth.com" }]);
  });

  it("revokes access", async () => {
    const app = await buildServer({ deps: makeDeps({ admin, isAdminEmail: () => true }) });
    const { cookieHeader, csrfToken } = await login(app);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/revocations",
      headers: { cookie: cookieHeader, "x-csrf-token": csrfToken, "content-type": "application/json" },
      payload: { employeeId: "emp-bob", agentId: "agent-1" },
    });
    expect(resp.statusCode).toBe(200);
    expect(admin.revokeAccessCalls).toEqual([{ employeeId: "emp-bob", agentId: "agent-1" }]);
  });
});
