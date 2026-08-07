import { describe, expect, it } from "vitest";
import { isEmailDomainAllowed, loadOidcConfigFromEnv, OidcConfigError } from "../src/config.js";

describe("isEmailDomainAllowed", () => {
  it("allows exact domain matches, case-insensitively", () => {
    expect(isEmailDomainAllowed("a@Example.com", ["example.com"])).toBe(true);
  });

  it("denies subdomains and unrelated domains by default", () => {
    expect(isEmailDomainAllowed("a@evil.example.com", ["example.com"])).toBe(false);
    expect(isEmailDomainAllowed("a@example.org", ["example.com"])).toBe(false);
  });

  it("denies malformed email input", () => {
    expect(isEmailDomainAllowed("not-an-email", ["example.com"])).toBe(false);
  });
});

describe("loadOidcConfigFromEnv", () => {
  const validEnv = {
    OIDC_ISSUER_URL: "https://issuer.example",
    OIDC_CLIENT_ID: "client",
    OIDC_CLIENT_SECRET: "secret",
    OIDC_REDIRECT_URI: "https://gateway.example/auth/callback",
    OIDC_ALLOWED_EMAIL_DOMAINS: "redesignhealth.com, other.com",
  } as NodeJS.ProcessEnv;

  it("parses a valid, fully-specified env", () => {
    const config = loadOidcConfigFromEnv({ env: validEnv });
    expect(config.allowedEmailDomains).toEqual(["redesignhealth.com", "other.com"]);
  });

  it("refuses to start with an unrestricted (empty) domain allow-list by default", () => {
    const env = { ...validEnv, OIDC_ALLOWED_EMAIL_DOMAINS: "" };
    expect(() => loadOidcConfigFromEnv({ env })).toThrow(OidcConfigError);
  });

  it("permits an empty allow-list only with explicit local-dev opt-in", () => {
    const env = { ...validEnv, OIDC_ALLOWED_EMAIL_DOMAINS: "" };
    const config = loadOidcConfigFromEnv({ env, allowUnrestrictedDomains: true });
    expect(config.allowedEmailDomains).toEqual([]);
  });

  it("rejects missing required fields", () => {
    const env = { ...validEnv, OIDC_ISSUER_URL: undefined } as unknown as NodeJS.ProcessEnv;
    expect(() => loadOidcConfigFromEnv({ env })).toThrow(OidcConfigError);
  });
});
