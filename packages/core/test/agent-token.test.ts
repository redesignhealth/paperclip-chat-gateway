import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentTokenVerificationError, verifyAgentRunToken, type AgentTokenConfig } from "../src/agent-token.js";

/**
 * Test-local re-implementation of Paperclip's own signing scheme (see
 * agent-token.ts's module docstring for the source reference). Deliberately
 * NOT imported from anywhere — this suite must prove our verifier is
 * compatible with the *algorithm*, not merely with our own mirror of it.
 */
function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function deriveCompanySigningKey(masterSecret: string, companyId: string, instanceId: string): string {
  return createHmac("sha256", masterSecret).update(`jwt:${instanceId}:${companyId}`).digest("hex");
}

function signHs256(signingInput: string, secret: string): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

interface MintOptions {
  sub?: string;
  companyId?: string;
  runId?: string;
  responsibleUserId?: string | null;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string | string[];
  nbf?: number;
  alg?: string;
  /** Sign with the raw master secret instead of the per-company derived key (legacy path). */
  legacySigning?: boolean;
  signingSecretOverride?: string;
}

const MASTER_SECRET = "unit-test-master-secret-unit-test-master-secret";
const INSTANCE_ID = "default";

function mintToken(masterSecret: string, instanceId: string, opts: MintOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const companyId = opts.companyId ?? "company-1";
  const header = { alg: opts.alg ?? "HS256", typ: "JWT" };
  const claims: Record<string, unknown> = {
    sub: opts.sub ?? "agent-alice-cfo",
    company_id: companyId,
    adapter_type: "local",
    run_id: opts.runId ?? "run-123",
    ...(opts.responsibleUserId !== undefined ? { responsible_user_id: opts.responsibleUserId } : {}),
    iat: opts.iat ?? now,
    exp: opts.exp ?? now + 3600,
    ...(opts.iss ? { iss: opts.iss } : {}),
    ...(opts.aud ? { aud: opts.aud } : {}),
    ...(opts.nbf !== undefined ? { nbf: opts.nbf } : {}),
  };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`;
  const signingKey =
    opts.signingSecretOverride ??
    (opts.legacySigning ? masterSecret : deriveCompanySigningKey(masterSecret, companyId, instanceId));
  const signature = signHs256(signingInput, signingKey);
  return `${signingInput}.${signature}`;
}

const baseConfig: AgentTokenConfig = {
  secret: MASTER_SECRET,
  instanceId: INSTANCE_ID,
  expectedCompanyIds: ["company-1"],
};

describe("verifyAgentRunToken — happy path", () => {
  it("resolves agentId and runId for a validly-signed token", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { sub: "agent-alice-cfo", runId: "run-abc" });
    const result = await verifyAgentRunToken(token, baseConfig);
    expect(result).toEqual({ agentId: "agent-alice-cfo", runId: "run-abc" });
  });

  it("does NOT verify via the legacy raw-master-secret fallback by default (fail closed)", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { legacySigning: true });
    await expect(verifyAgentRunToken(token, baseConfig)).rejects.toThrow(AgentTokenVerificationError);
  });

  it("verifies via the legacy raw-master-secret fallback only when enableLegacyFallback is explicitly set", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { legacySigning: true });
    const result = await verifyAgentRunToken(token, { ...baseConfig, enableLegacyFallback: true });
    expect(result.agentId).toBe("agent-alice-cfo");
  });

  it("accepts an aud claim that is an array containing the configured audience (RFC 7519)", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { aud: ["paperclip-api", "something-else"] });
    const result = await verifyAgentRunToken(token, { ...baseConfig, audience: "paperclip-api" });
    expect(result.agentId).toBe("agent-alice-cfo");
  });

  it("rejects an aud array that does not contain the configured audience", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { aud: ["someone-elses-api"] });
    await expect(verifyAgentRunToken(token, { ...baseConfig, audience: "paperclip-api" })).rejects.toThrow(
      AgentTokenVerificationError,
    );
  });
});

describe("verifyAgentRunToken — nbf, max age, and clock skew", () => {
  it("rejects a token whose nbf is in the future beyond the clock tolerance", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { nbf: now + 3600 });
    await expect(verifyAgentRunToken(token, baseConfig)).rejects.toThrow(AgentTokenVerificationError);
  });

  it("accepts a token whose nbf is in the past", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { nbf: now - 60 });
    const result = await verifyAgentRunToken(token, baseConfig);
    expect(result.agentId).toBe("agent-alice-cfo");
  });

  it("accepts an exp slightly in the past within the configured clock tolerance", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { iat: now - 10, exp: now - 2 });
    const result = await verifyAgentRunToken(token, { ...baseConfig, clockToleranceSeconds: 5 });
    expect(result.agentId).toBe("agent-alice-cfo");
  });

  it("still rejects an exp further in the past than the configured clock tolerance", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { iat: now - 3600, exp: now - 30 });
    await expect(verifyAgentRunToken(token, { ...baseConfig, clockToleranceSeconds: 5 })).rejects.toThrow(
      AgentTokenVerificationError,
    );
  });

  it("rejects a token older than maxTokenAgeSeconds even though exp hasn't passed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { iat: now - 7200, exp: now + 3600 });
    await expect(
      verifyAgentRunToken(token, { ...baseConfig, maxTokenAgeSeconds: 3600 }),
    ).rejects.toThrow(AgentTokenVerificationError);
  });

  it("accepts a token within maxTokenAgeSeconds", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { iat: now - 60, exp: now + 3600 });
    const result = await verifyAgentRunToken(token, { ...baseConfig, maxTokenAgeSeconds: 3600 });
    expect(result.agentId).toBe("agent-alice-cfo");
  });
});

describe("verifyAgentRunToken — company scoping", () => {
  it("rejects a validly-signed token for a company not on this gateway's allowlist", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { companyId: "company-evil" });
    await expect(verifyAgentRunToken(token, { ...baseConfig, expectedCompanyIds: ["company-1"] })).rejects.toThrow(
      AgentTokenVerificationError,
    );
  });

  it("accepts a validly-signed token for a company on this gateway's allowlist", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { companyId: "company-2" });
    const result = await verifyAgentRunToken(token, { ...baseConfig, expectedCompanyIds: ["company-1", "company-2"] });
    expect(result.agentId).toBe("agent-alice-cfo");
  });

  it("fails closed when the gateway itself has no expectedCompanyIds configured", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { companyId: "company-1" });
    await expect(verifyAgentRunToken(token, { ...baseConfig, expectedCompanyIds: [] })).rejects.toThrow(
      AgentTokenVerificationError,
    );
  });
});

describe("verifyAgentRunToken — responsible_user_id is never trusted", () => {
  it("resolves the same agentId/runId regardless of a responsible_user_id claim naming a different person", async () => {
    const honestToken = mintToken(MASTER_SECRET, INSTANCE_ID, {
      sub: "agent-alice-cfo",
      runId: "run-1",
      responsibleUserId: "emp-alice",
    });
    const spoofedToken = mintToken(MASTER_SECRET, INSTANCE_ID, {
      sub: "agent-alice-cfo",
      runId: "run-1",
      responsibleUserId: "emp-mallory",
    });

    const honestResult = await verifyAgentRunToken(honestToken, baseConfig);
    const spoofedResult = await verifyAgentRunToken(spoofedToken, baseConfig);

    expect(honestResult).toEqual({ agentId: "agent-alice-cfo", runId: "run-1" });
    expect(spoofedResult).toEqual({ agentId: "agent-alice-cfo", runId: "run-1" });
    expect(honestResult).toEqual(spoofedResult);
    // The result type doesn't even carry the field.
    expect(Object.keys(spoofedResult)).not.toContain("responsible_user_id");
  });
});

describe("verifyAgentRunToken — fails closed", () => {
  it("rejects a forged signature", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID);
    const tampered = token.slice(0, -4) + "abcd";
    await expect(verifyAgentRunToken(tampered, baseConfig)).rejects.toThrow(AgentTokenVerificationError);
  });

  it("rejects a signature produced with the wrong secret entirely", async () => {
    const token = mintToken("a-completely-different-secret-value", INSTANCE_ID, { legacySigning: true });
    await expect(verifyAgentRunToken(token, baseConfig)).rejects.toThrow(AgentTokenVerificationError);
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { iat: now - 7200, exp: now - 3600 });
    await expect(verifyAgentRunToken(token, baseConfig)).rejects.toThrow(AgentTokenVerificationError);
  });

  it('rejects alg:"none" outright, even with an empty signature', async () => {
    const header = { alg: "none", typ: "JWT" };
    const claims = { sub: "agent-alice-cfo", company_id: "company-1", run_id: "run-1", exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}.`;
    await expect(verifyAgentRunToken(token, baseConfig)).rejects.toThrow(/unsupported algorithm/);
  });

  it("rejects a non-HS256 alg header even if a signature-shaped value is present", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { alg: "RS256" });
    await expect(verifyAgentRunToken(token, baseConfig)).rejects.toThrow(/unsupported algorithm/);
  });

  it("sanitizes an attacker-controlled alg header before it reaches the error message (cap + strip control chars)", async () => {
    const maliciousAlg = `HS256-evil\nINJECTED-LINE-${"x".repeat(100)}`;
    const header = { alg: maliciousAlg, typ: "JWT" };
    const claims = { sub: "agent-alice-cfo", company_id: "company-1", run_id: "run-1", exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}.deadbeef`;
    let thrown: unknown;
    try {
      await verifyAgentRunToken(token, baseConfig);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentTokenVerificationError);
    const message = (thrown as Error).message;
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThan(200);
  });

  it("rejects a token missing the run_id claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const claims = { sub: "agent-alice-cfo", company_id: "company-1", exp: now + 3600 };
    const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`;
    const key = deriveCompanySigningKey(MASTER_SECRET, "company-1", INSTANCE_ID);
    const token = `${signingInput}.${signHs256(signingInput, key)}`;
    await expect(verifyAgentRunToken(token, baseConfig)).rejects.toThrow(/missing required claim/);
  });

  it("rejects a token missing the sub claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const claims = { company_id: "company-1", run_id: "run-1", exp: now + 3600 };
    const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`;
    const key = deriveCompanySigningKey(MASTER_SECRET, "company-1", INSTANCE_ID);
    const token = `${signingInput}.${signHs256(signingInput, key)}`;
    await expect(verifyAgentRunToken(token, baseConfig)).rejects.toThrow(/missing required claim/);
  });

  it("rejects a token missing company_id (cannot even select a candidate key)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const claims = { sub: "agent-alice-cfo", run_id: "run-1", exp: now + 3600 };
    const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`;
    const token = `${signingInput}.${signHs256(signingInput, MASTER_SECRET)}`;
    await expect(verifyAgentRunToken(token, baseConfig)).rejects.toThrow(/company_id/);
  });

  it("rejects an issuer mismatch when an issuer is configured", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { iss: "someone-else" });
    await expect(verifyAgentRunToken(token, { ...baseConfig, issuer: "paperclip" })).rejects.toThrow(
      AgentTokenVerificationError,
    );
  });

  it("fail-closed: rejects a token with NO iss claim at all once an issuer is configured, not just a mismatched one", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID); // no `iss` claim
    await expect(verifyAgentRunToken(token, { ...baseConfig, issuer: "paperclip" })).rejects.toThrow(
      AgentTokenVerificationError,
    );
  });

  it("rejects an audience mismatch when an audience is configured", async () => {
    const token = mintToken(MASTER_SECRET, INSTANCE_ID, { aud: "someone-elses-api" });
    await expect(verifyAgentRunToken(token, { ...baseConfig, audience: "paperclip-api" })).rejects.toThrow(
      AgentTokenVerificationError,
    );
  });

  it("rejects a token signed for a different control-plane instanceId (per-instance isolation)", async () => {
    const token = mintToken(MASTER_SECRET, "some-fork-instance");
    await expect(verifyAgentRunToken(token, baseConfig)).rejects.toThrow(AgentTokenVerificationError);
  });

  it("rejects an empty token", async () => {
    await expect(verifyAgentRunToken("", baseConfig)).rejects.toThrow(AgentTokenVerificationError);
  });

  it("rejects a malformed (non-JWT-shaped) token", async () => {
    await expect(verifyAgentRunToken("not-a-jwt", baseConfig)).rejects.toThrow(AgentTokenVerificationError);
  });
});
