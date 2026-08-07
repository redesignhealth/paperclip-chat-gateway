import { beforeEach, describe, expect, it, vi } from "vitest";

const discovery = vi.fn();
const calculatePKCECodeChallenge = vi.fn();
const buildAuthorizationUrl = vi.fn();
const authorizationCodeGrant = vi.fn();

vi.mock("openid-client", () => ({
  discovery: (...args: unknown[]) => discovery(...args),
  calculatePKCECodeChallenge: (...args: unknown[]) => calculatePKCECodeChallenge(...args),
  buildAuthorizationUrl: (...args: unknown[]) => buildAuthorizationUrl(...args),
  authorizationCodeGrant: (...args: unknown[]) => authorizationCodeGrant(...args),
}));

// Imported after the mock is registered so RealOidcPort's dynamic
// `import("openid-client")` resolves to the mock above.
const { EmailNotVerifiedError, RealOidcPort } = await import("../src/oidc-port.js");

function makePort(options: Partial<{ requireVerifiedEmail: boolean }> = {}) {
  return new RealOidcPort({
    issuerUrl: "https://issuer.example",
    clientId: "client",
    clientSecret: "secret",
    ...options,
  });
}

const CALLBACK_INPUT = {
  currentUrl: new URL("https://gateway.example/auth/callback?code=abc&state=s"),
  expectedState: "s",
  codeVerifier: "cv",
};

beforeEach(() => {
  discovery.mockReset().mockResolvedValue({ configured: true });
  calculatePKCECodeChallenge.mockReset().mockResolvedValue("challenge");
  buildAuthorizationUrl.mockReset().mockReturnValue(new URL("https://issuer.example/authorize?state=s"));
  authorizationCodeGrant.mockReset();
});

describe("RealOidcPort.buildAuthorizationUrl", () => {
  it("passes nonce, state, and PKCE challenge through to the underlying client call", async () => {
    const port = makePort();
    await port.buildAuthorizationUrl({ redirectUri: "https://gateway.example/auth/callback", state: "s", codeVerifier: "cv", nonce: "n1" });

    expect(buildAuthorizationUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "s", nonce: "n1", code_challenge: "challenge", code_challenge_method: "S256" }),
    );
  });
});

describe("RealOidcPort.handleCallback — email_verified enforcement", () => {
  it("rejects an email claim with email_verified === false (fail closed against IdP-supplied unverified email)", async () => {
    authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ sub: "sub-1", email: "person@example.com", email_verified: false }),
    });
    const port = makePort();
    await expect(port.handleCallback(CALLBACK_INPUT)).rejects.toThrow(EmailNotVerifiedError);
  });

  it("rejects an email claim where email_verified is absent entirely (fail closed, not fail open)", async () => {
    authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ sub: "sub-1", email: "person@example.com" }),
    });
    const port = makePort();
    await expect(port.handleCallback(CALLBACK_INPUT)).rejects.toThrow(EmailNotVerifiedError);
  });

  it("accepts an email claim with email_verified === true", async () => {
    authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ sub: "sub-1", email: "person@example.com", email_verified: true, name: "Person" }),
    });
    const port = makePort();
    const result = await port.handleCallback(CALLBACK_INPUT);
    expect(result).toEqual({ sub: "sub-1", email: "person@example.com", name: "Person", raw: expect.anything() });
  });

  it("has no email to verify when the provider returns none — not this port's job to invent MissingEmailClaimError", async () => {
    authorizationCodeGrant.mockResolvedValue({ claims: () => ({ sub: "sub-1" }) });
    const port = makePort();
    const result = await port.handleCallback(CALLBACK_INPUT);
    expect(result.email).toBeUndefined();
  });

  it("allows opting out of strict verification only via explicit configuration", async () => {
    authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ sub: "sub-1", email: "person@example.com", email_verified: false }),
    });
    const port = makePort({ requireVerifiedEmail: false });
    const result = await port.handleCallback(CALLBACK_INPUT);
    expect(result.email).toBe("person@example.com");
  });
});

describe("RealOidcPort.handleCallback — nonce forwarding", () => {
  it("forwards expectedNonce into the authorization code grant checks when provided", async () => {
    authorizationCodeGrant.mockResolvedValue({ claims: () => ({ sub: "sub-1" }) });
    const port = makePort();
    await port.handleCallback({ ...CALLBACK_INPUT, expectedNonce: "n1" });

    expect(authorizationCodeGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expectedNonce: "n1", expectedState: "s", pkceCodeVerifier: "cv" }),
    );
  });

  it("does not send an expectedNonce check when none was provided", async () => {
    authorizationCodeGrant.mockResolvedValue({ claims: () => ({ sub: "sub-1" }) });
    const port = makePort();
    await port.handleCallback(CALLBACK_INPUT);

    const checks = authorizationCodeGrant.mock.calls[0][2];
    expect(checks).not.toHaveProperty("expectedNonce");
  });
});

describe("RealOidcPort discovery caching", () => {
  it("does not permanently cache a discovery rejection: a later call retries and can recover", async () => {
    discovery.mockRejectedValueOnce(new Error("transient IdP outage")).mockResolvedValueOnce({ configured: true });
    const port = makePort();

    await expect(
      port.buildAuthorizationUrl({ redirectUri: "https://gateway.example/auth/callback", state: "s", codeVerifier: "cv", nonce: "n" }),
    ).rejects.toThrow("transient IdP outage");

    await expect(
      port.buildAuthorizationUrl({ redirectUri: "https://gateway.example/auth/callback", state: "s", codeVerifier: "cv", nonce: "n" }),
    ).resolves.toBeDefined();

    expect(discovery).toHaveBeenCalledTimes(2);
  });

  it("caches a successful discovery across calls", async () => {
    const port = makePort();
    await port.buildAuthorizationUrl({ redirectUri: "https://gateway.example/auth/callback", state: "s", codeVerifier: "cv", nonce: "n" });
    await port.buildAuthorizationUrl({ redirectUri: "https://gateway.example/auth/callback", state: "s2", codeVerifier: "cv2", nonce: "n2" });
    expect(discovery).toHaveBeenCalledTimes(1);
  });

  it("refresh() forces re-discovery on the next call", async () => {
    const port = makePort();
    await port.buildAuthorizationUrl({ redirectUri: "https://gateway.example/auth/callback", state: "s", codeVerifier: "cv", nonce: "n" });
    await port.refresh();
    await port.buildAuthorizationUrl({ redirectUri: "https://gateway.example/auth/callback", state: "s", codeVerifier: "cv", nonce: "n" });
    expect(discovery).toHaveBeenCalledTimes(2);
  });
});
