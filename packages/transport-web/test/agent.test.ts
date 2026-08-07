import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BindingTable,
  EnvAgentCredentialStore,
  InMemorySessionStore,
  NotImplementedError,
  type AgentTokenConfig,
  type SchedulerClient,
  type SchedulerForwardInput,
} from "@paperclip-chat-gateway/core";
import { OidcAdapter, type OidcPort } from "@paperclip-chat-gateway/auth-oidc";
import { buildServer } from "../src/server.js";
import type { GatewayDeps } from "../src/types.js";

const MASTER_SECRET = "agent-route-test-master-secret-agent-route-test";
const INSTANCE_ID = "default";

function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function deriveCompanySigningKey(masterSecret: string, companyId: string, instanceId: string): string {
  return createHmac("sha256", masterSecret).update(`jwt:${instanceId}:${companyId}`).digest("hex");
}

function signHs256(signingInput: string, secret: string): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function mintAgentToken(opts: {
  sub: string;
  runId: string;
  companyId?: string;
  responsibleUserId?: string | null;
  exp?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const companyId = opts.companyId ?? "company-1";
  const header = { alg: "HS256", typ: "JWT" };
  const claims: Record<string, unknown> = {
    sub: opts.sub,
    company_id: companyId,
    adapter_type: "local",
    run_id: opts.runId,
    ...(opts.responsibleUserId !== undefined ? { responsible_user_id: opts.responsibleUserId } : {}),
    iat: now,
    exp: opts.exp ?? now + 3600,
  };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`;
  const key = deriveCompanySigningKey(MASTER_SECRET, companyId, INSTANCE_ID);
  return `${signingInput}.${signHs256(signingInput, key)}`;
}

class RecordingSchedulerClient implements SchedulerClient {
  public readonly calls: SchedulerForwardInput[] = [];
  constructor(private readonly behavior?: () => Promise<unknown>) {}
  async forward(input: SchedulerForwardInput): Promise<unknown> {
    this.calls.push(input);
    if (this.behavior) return this.behavior();
    return { ok: true };
  }
}

class UnimplementedSchedulerClient implements SchedulerClient {
  async forward(input: SchedulerForwardInput): Promise<unknown> {
    throw new NotImplementedError(`not implemented: ${input.action}`);
  }
}

class MockIssuerPort implements OidcPort {
  async buildAuthorizationUrl(input: { redirectUri: string; state: string; codeVerifier: string; nonce: string }) {
    return { url: `https://issuer.example/authorize?state=${input.state}&nonce=${input.nonce}`, codeChallenge: "cc" };
  }
  async handleCallback() {
    return { sub: "sub-1", email: "alice@redesignhealth.com", raw: {} };
  }
}

const OIDC_CONFIG = {
  issuerUrl: "https://issuer.example",
  clientId: "gateway-client",
  clientSecret: "gateway-secret",
  redirectUri: "https://gateway.example/auth/callback",
  allowedEmailDomains: ["redesignhealth.com"],
};

const agentTokenConfig: AgentTokenConfig = {
  secret: MASTER_SECRET,
  instanceId: INSTANCE_ID,
  expectedCompanyIds: ["company-1"],
};

function makeDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  const bindings = BindingTable.fromConfig({
    bindings: [{ employeeId: "emp-alice", agentId: "agent-alice-cfo" }],
  });
  return {
    oidc: new OidcAdapter(OIDC_CONFIG, new MockIssuerPort()),
    bindings,
    credentials: new EnvAgentCredentialStore({} as NodeJS.ProcessEnv),
    sessions: new InMemorySessionStore(),
    paperclipClientFor: () => {
      throw new Error("not used in these tests");
    },
    paperclipApiBaseUrl: "https://paperclip.example/api",
    cookieSecret: "test-cookie-secret-test-cookie-secret",
    resolveEmployeeId: async () => null,
    isAdminEmail: () => false,
    agentTokenConfig,
    schedulerClient: new RecordingSchedulerClient(),
    ...overrides,
  };
}

describe("POST /api/agent/scheduler — authentication", () => {
  it("rejects a request with no bearer token", async () => {
    const app = await buildServer({ deps: makeDeps() });
    const res = await app.inject({ method: "POST", url: "/api/agent/scheduler", payload: { action: "ping" } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a forged token", async () => {
    const token = mintAgentToken({ sub: "agent-alice-cfo", runId: "run-1" });
    const forged = token.slice(0, -4) + "abcd";
    const app = await buildServer({ deps: makeDeps() });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${forged}` },
      payload: { action: "ping" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintAgentToken({ sub: "agent-alice-cfo", runId: "run-1", exp: now - 60 });
    const app = await buildServer({ deps: makeDeps() });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "ping" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects alg:none tokens", async () => {
    const header = { alg: "none", typ: "JWT" };
    const claims = { sub: "agent-alice-cfo", company_id: "company-1", run_id: "run-1", exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}.`;
    const app = await buildServer({ deps: makeDeps() });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "ping" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("denies an agentId that has no binding, even with a validly-signed token (deny-by-default)", async () => {
    const token = mintAgentToken({ sub: "agent-unbound", runId: "run-1" });
    const app = await buildServer({ deps: makeDeps() });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "ping" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a validly-signed token for a company_id not on this gateway's allowlist", async () => {
    const token = mintAgentToken({ sub: "agent-alice-cfo", runId: "run-1", companyId: "company-not-allowed" });
    const app = await buildServer({ deps: makeDeps() });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "ping" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/agent/scheduler — opt-in broker", () => {
  it("is not registered at all when agentTokenConfig is unset (404, gateway otherwise unaffected)", async () => {
    const app = await buildServer({
      deps: makeDeps({ agentTokenConfig: undefined, schedulerClient: undefined }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      payload: { action: "ping" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("still serves other routes normally when the agent broker is disabled", async () => {
    const app = await buildServer({
      deps: makeDeps({ agentTokenConfig: undefined, schedulerClient: undefined }),
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/agent/scheduler — identity resolution and forwarding", () => {
  it("resolves the bound employeeId and forwards the call, ignoring responsible_user_id entirely", async () => {
    const scheduler = new RecordingSchedulerClient();
    const token = mintAgentToken({
      sub: "agent-alice-cfo",
      runId: "run-42",
      responsibleUserId: "emp-mallory", // must have zero effect
    });
    const app = await buildServer({ deps: makeDeps({ schedulerClient: scheduler }) });

    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "reschedule", payload: { when: "tomorrow" } },
    });

    expect(res.statusCode).toBe(200);
    expect(scheduler.calls).toEqual([
      {
        employeeId: "emp-alice",
        agentId: "agent-alice-cfo",
        runId: "run-42",
        action: "reschedule",
        payload: { when: "tomorrow" },
      },
    ]);
  });

  it("rejects a malformed body (missing action)", async () => {
    const token = mintAgentToken({ sub: "agent-alice-cfo", runId: "run-1" });
    const app = await buildServer({ deps: makeDeps() });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("maps an unimplemented downstream scheduler to 501, not a 500", async () => {
    const token = mintAgentToken({ sub: "agent-alice-cfo", runId: "run-1" });
    const app = await buildServer({ deps: makeDeps({ schedulerClient: new UnimplementedSchedulerClient() }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "reschedule" },
    });
    expect(res.statusCode).toBe(501);
  });

  it("forwards a non-default forward() result verbatim", async () => {
    const scheduler = new RecordingSchedulerClient(async () => ({ scheduled: true, slot: "2026-08-10T09:00:00Z" }));
    const token = mintAgentToken({ sub: "agent-alice-cfo", runId: "run-1" });
    const app = await buildServer({ deps: makeDeps({ schedulerClient: scheduler }) });

    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "reschedule" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scheduled: true, slot: "2026-08-10T09:00:00Z" });
  });

  it("accepts a lowercase \"bearer\" auth scheme (RFC 7235 scheme names are case-insensitive)", async () => {
    const token = mintAgentToken({ sub: "agent-alice-cfo", runId: "run-1" });
    const app = await buildServer({ deps: makeDeps() });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `bearer ${token}` },
      payload: { action: "ping" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/agent/scheduler — request body bounds", () => {
  it("rejects an action longer than 8000 characters", async () => {
    const token = mintAgentToken({ sub: "agent-alice-cfo", runId: "run-1" });
    const app = await buildServer({ deps: makeDeps() });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "a".repeat(8001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts an action of exactly 8000 characters", async () => {
    const scheduler = new RecordingSchedulerClient();
    const token = mintAgentToken({ sub: "agent-alice-cfo", runId: "run-1" });
    const app = await buildServer({ deps: makeDeps({ schedulerClient: scheduler }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "a".repeat(8000) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a payload that serializes over the size bound", async () => {
    const token = mintAgentToken({ sub: "agent-alice-cfo", runId: "run-1" });
    const app = await buildServer({ deps: makeDeps() });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "ping", payload: { blob: "x".repeat(40 * 1024) } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a payload comfortably under the size bound", async () => {
    const scheduler = new RecordingSchedulerClient();
    const token = mintAgentToken({ sub: "agent-alice-cfo", runId: "run-1" });
    const app = await buildServer({ deps: makeDeps({ schedulerClient: scheduler }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/scheduler",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "ping", payload: { when: "tomorrow" } },
    });
    expect(res.statusCode).toBe(200);
  });
});
