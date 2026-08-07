import { beforeEach, describe, expect, it } from "vitest";
import {
  BindingTable,
  EnvAgentCredentialStore,
  HttpPaperclipClient,
  InMemorySessionStore,
  type PaperclipClient,
} from "@paperclip-chat-gateway/core";
import { OidcAdapter, type OidcPort } from "@paperclip-chat-gateway/auth-oidc";
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
  constructor(private readonly claims: { sub: string; email?: string; name?: string } | null) {}

  async buildAuthorizationUrl(input: { redirectUri: string; state: string; codeVerifier: string; nonce: string }) {
    return { url: `https://issuer.example/authorize?state=${input.state}&nonce=${input.nonce}`, codeChallenge: "cc" };
  }

  async handleCallback() {
    if (!this.claims) throw new Error("mock issuer rejected code");
    return { ...this.claims, raw: { ...this.claims } };
  }
}

function makeDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  const bindings = BindingTable.fromConfig({
    bindings: [{ employeeId: "emp-alice", agentId: "agent-alice-cfo" }],
  });
  return {
    oidc: new OidcAdapter(OIDC_CONFIG, new MockIssuerPort({ sub: "sub-1", email: "alice@redesignhealth.com" })),
    bindings,
    credentials: new EnvAgentCredentialStore({
      [EnvAgentCredentialStore.envVarNameFor("agent-alice-cfo")]: "key-alice",
    } as NodeJS.ProcessEnv),
    sessions: new InMemorySessionStore(),
    paperclipClientFor: (_agentId: string, apiKey: string): PaperclipClient =>
      new HttpPaperclipClient({ baseUrl: "https://paperclip.example/api", apiKey, fetchImpl: (async () => {
        throw new Error("network not available in this test");
      }) as unknown as typeof fetch }),
    paperclipApiBaseUrl: "https://paperclip.example/api",
    cookieSecret: "test-cookie-secret-test-cookie-secret",
    resolveEmployeeId: async (claims) => (claims.email === "alice@redesignhealth.com" ? "emp-alice" : null),
    isAdminEmail: () => false,
    ...overrides,
  };
}

describe("transport-web server", () => {
  let deps: GatewayDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("GET /health responds ok without auth", async () => {
    const app = await buildServer({ deps });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET /auth/login redirects to the OIDC authorization URL and sets a transaction cookie", async () => {
    const app = await buildServer({ deps });
    const res = await app.inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("https://issuer.example/authorize");
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("OIDC callback happy path: known employee gets a session cookie and is redirected home", async () => {
    const app = await buildServer({ deps });
    const login = await app.inject({ method: "GET", url: "/auth/login" });
    const cookieHeader = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const callback = await app.inject({
      method: "GET",
      url: "/auth/callback?code=abc&state=whatever",
      headers: { cookie: cookieHeader },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/");
    const sessionCookie = callback.cookies.find((c) => c.name === "pcg_session");
    expect(sessionCookie).toBeDefined();
  });

  it("OIDC callback sad path: missing transaction cookie is rejected with 400", async () => {
    const app = await buildServer({ deps });
    const res = await app.inject({ method: "GET", url: "/auth/callback?code=abc&state=whatever" });
    expect(res.statusCode).toBe(400);
  });

  it("OIDC callback sad path: an identity with no gateway binding is rejected with 403", async () => {
    deps = makeDeps({ resolveEmployeeId: async () => null });
    const app = await buildServer({ deps });
    const login = await app.inject({ method: "GET", url: "/auth/login" });
    const cookieHeader = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const callback = await app.inject({
      method: "GET",
      url: "/auth/callback?code=abc&state=whatever",
      headers: { cookie: cookieHeader },
    });
    expect(callback.statusCode).toBe(403);
  });

  it("chat routes require authentication", async () => {
    const app = await buildServer({ deps });
    const res = await app.inject({ method: "GET", url: "/api/chat/messages" });
    expect(res.statusCode).toBe(401);
  });

  it("chat routes deny an authenticated employee with no agent binding (deny-by-default)", async () => {
    const bindings = BindingTable.empty();
    deps = makeDeps({ bindings });
    const app = await buildServer({ deps });

    const login = await app.inject({ method: "GET", url: "/auth/login" });
    const cookieHeader = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const callback = await app.inject({
      method: "GET",
      url: "/auth/callback?code=abc&state=whatever",
      headers: { cookie: cookieHeader },
    });
    const sessionCookie = callback.cookies.find((c) => c.name === "pcg_session")!;

    const res = await app.inject({
      method: "GET",
      url: "/api/chat/messages",
      headers: { cookie: `${sessionCookie.name}=${sessionCookie.value}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("OIDC callback error taxonomy: an unexpected (non-policy) error maps to 502, not a misleading 403", async () => {
    class ThrowingIssuerPort implements OidcPort {
      async buildAuthorizationUrl(input: { redirectUri: string; state: string; codeVerifier: string; nonce: string }) {
        return { url: `https://issuer.example/authorize?state=${input.state}`, codeChallenge: "cc" };
      }
      async handleCallback(): Promise<never> {
        throw new Error("discovery endpoint unreachable");
      }
    }
    deps = makeDeps({ oidc: new OidcAdapter(OIDC_CONFIG, new ThrowingIssuerPort()) });
    const app = await buildServer({ deps });
    const login = await app.inject({ method: "GET", url: "/auth/login" });
    const cookieHeader = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const callback = await app.inject({
      method: "GET",
      url: "/auth/callback?code=abc&state=whatever",
      headers: { cookie: cookieHeader },
    });
    expect(callback.statusCode).toBe(502);
  });

  it("does not trust forwarded headers by default (trustProxy unset)", async () => {
    const app = await buildServer({ deps });
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
    });
    // Fastify only exposes req.hostname/protocol from forwarded headers when
    // trustProxy is configured; this is an indirect but effective way to
    // confirm the default posture is "don't trust them" without reaching
    // into Fastify internals.
    expect(app.initialConfig.trustProxy).toBeFalsy();
    expect(res.statusCode).toBe(200);
  });
});
