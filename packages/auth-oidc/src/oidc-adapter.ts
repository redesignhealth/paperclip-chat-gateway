import { randomBytes } from "node:crypto";
import type { EmployeeClaims } from "@paperclip-chat-gateway/core";
import { isEmailDomainAllowed, type OidcConfig } from "./config.js";
import type { OidcPort } from "./oidc-port.js";

export class EmailDomainNotAllowedError extends Error {
  constructor(email: string) {
    super(`Email "${email}" is not on an allowed domain for this gateway.`);
    this.name = "EmailDomainNotAllowedError";
  }
}

export class MissingEmailClaimError extends Error {
  constructor() {
    super("OIDC provider did not return an email claim, and this gateway requires one for domain enforcement.");
    this.name = "MissingEmailClaimError";
  }
}

export interface LoginStart {
  authorizationUrl: string;
  /** Opaque values the transport adapter must persist (e.g. in a signed cookie) and echo back on callback. */
  state: string;
  codeVerifier: string;
  /** ID-token replay defense-in-depth, alongside state+PKCE. Must be echoed back into handleCallback. */
  nonce: string;
}

/**
 * Generic OIDC login adapter. Knows nothing about HTTP framework, cookies,
 * or sessions — transport-web owns wiring this into routes and a session
 * cookie. This class only does the OIDC dance and the one piece of policy
 * that's genuinely an auth concern: rejecting logins from disallowed email
 * domains before they ever reach IdentityResolver.
 */
export class OidcAdapter {
  constructor(
    private readonly config: OidcConfig,
    private readonly port: OidcPort,
  ) {}

  /**
   * Starts a login: generates `state` + PKCE `code_verifier` and returns
   * the authorization URL to redirect the user to. The transport adapter
   * must persist `state` and `codeVerifier` (e.g. in a short-lived signed
   * cookie) and pass them back into `handleCallback`.
   */
  async startLogin(): Promise<LoginStart> {
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const { url } = await this.port.buildAuthorizationUrl({
      redirectUri: this.config.redirectUri,
      state,
      codeVerifier,
      nonce,
    });
    return { authorizationUrl: url, state, codeVerifier, nonce };
  }

  /**
   * Completes the callback and returns verified, domain-checked claims
   * ready for IdentityResolver. Throws EmailDomainNotAllowedError /
   * MissingEmailClaimError / EmailNotVerifiedError on the sad paths —
   * callers should map those to 403s, not 500s (everything else is an
   * infrastructure failure and should map to a 5xx instead, see
   * routes/auth.ts).
   */
  async handleCallback(input: {
    currentUrl: URL;
    expectedState: string;
    codeVerifier: string;
    expectedNonce?: string;
  }): Promise<EmployeeClaims> {
    const result = await this.port.handleCallback(input);

    if (!result.email) {
      throw new MissingEmailClaimError();
    }
    if (!isEmailDomainAllowed(result.email, this.config.allowedEmailDomains)) {
      throw new EmailDomainNotAllowedError(result.email);
    }

    return {
      subject: result.sub,
      email: result.email,
      name: result.name,
      raw: result.raw,
    };
  }
}
