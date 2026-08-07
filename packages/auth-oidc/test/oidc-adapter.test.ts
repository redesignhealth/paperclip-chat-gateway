import { describe, expect, it } from "vitest";
import {
  EmailDomainNotAllowedError,
  MissingEmailClaimError,
  OidcAdapter,
  type OidcConfig,
  type OidcPort,
} from "../src/index.js";

const baseConfig: OidcConfig = {
  issuerUrl: "https://issuer.example",
  clientId: "gateway-client",
  clientSecret: "gateway-secret",
  redirectUri: "https://gateway.example/auth/callback",
  allowedEmailDomains: ["redesignhealth.com"],
};

/**
 * Fake OidcPort standing in for a mock issuer: no network, no real crypto,
 * just enough to exercise OidcAdapter's own logic (domain enforcement,
 * state/verifier plumbing).
 */
class MockIssuerPort implements OidcPort {
  constructor(
    private readonly claims: { sub: string; email?: string; name?: string } | null,
  ) {}

  async buildAuthorizationUrl(input: { redirectUri: string; state: string; codeVerifier: string; nonce: string }) {
    return {
      url: `https://issuer.example/authorize?state=${input.state}&nonce=${input.nonce}&redirect_uri=${encodeURIComponent(input.redirectUri)}`,
      codeChallenge: `challenge-for-${input.codeVerifier}`,
    };
  }

  async handleCallback(_input: { currentUrl: URL; expectedState: string; codeVerifier: string; expectedNonce?: string }) {
    if (!this.claims) {
      throw new Error("mock issuer: invalid code");
    }
    return { ...this.claims, raw: { ...this.claims } };
  }
}

describe("OidcAdapter", () => {
  it("happy path: builds an authorization URL carrying state, nonce, and redirect_uri", async () => {
    const adapter = new OidcAdapter(baseConfig, new MockIssuerPort({ sub: "sub-1", email: "a@redesignhealth.com" }));
    const login = await adapter.startLogin();

    expect(login.authorizationUrl).toContain(`state=${login.state}`);
    expect(login.authorizationUrl).toContain(`nonce=${login.nonce}`);
    expect(login.authorizationUrl).toContain(encodeURIComponent(baseConfig.redirectUri));
    expect(login.codeVerifier).toBeTruthy();
    expect(login.nonce).toBeTruthy();
  });

  it("happy path: callback with an allowed email domain resolves EmployeeClaims", async () => {
    const adapter = new OidcAdapter(
      baseConfig,
      new MockIssuerPort({ sub: "sub-1", email: "person@redesignhealth.com", name: "Person" }),
    );

    const claims = await adapter.handleCallback({
      currentUrl: new URL("https://gateway.example/auth/callback?code=abc&state=xyz"),
      expectedState: "xyz",
      codeVerifier: "verifier",
    });

    expect(claims).toEqual({
      subject: "sub-1",
      email: "person@redesignhealth.com",
      name: "Person",
      raw: { sub: "sub-1", email: "person@redesignhealth.com", name: "Person" },
    });
  });

  it("sad path: rejects a callback for an email on a disallowed domain", async () => {
    const adapter = new OidcAdapter(
      baseConfig,
      new MockIssuerPort({ sub: "sub-evil", email: "person@not-allowed.com" }),
    );

    await expect(
      adapter.handleCallback({
        currentUrl: new URL("https://gateway.example/auth/callback?code=abc&state=xyz"),
        expectedState: "xyz",
        codeVerifier: "verifier",
      }),
    ).rejects.toThrow(EmailDomainNotAllowedError);
  });

  it("sad path: rejects a callback with no email claim at all", async () => {
    const adapter = new OidcAdapter(baseConfig, new MockIssuerPort({ sub: "sub-no-email" }));

    await expect(
      adapter.handleCallback({
        currentUrl: new URL("https://gateway.example/auth/callback?code=abc&state=xyz"),
        expectedState: "xyz",
        codeVerifier: "verifier",
      }),
    ).rejects.toThrow(MissingEmailClaimError);
  });

  it("sad path: propagates the underlying error when the mock issuer rejects the code exchange", async () => {
    const adapter = new OidcAdapter(baseConfig, new MockIssuerPort(null));

    await expect(
      adapter.handleCallback({
        currentUrl: new URL("https://gateway.example/auth/callback?code=bad&state=xyz"),
        expectedState: "xyz",
        codeVerifier: "verifier",
      }),
    ).rejects.toThrow(/invalid code/);
  });
});
