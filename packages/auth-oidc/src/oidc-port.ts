import { createCachedAsync } from "./cached-async.js";

/**
 * Thin seam around `openid-client` so OidcAdapter's login/callback logic is
 * testable against a mock issuer without real network discovery or crypto.
 * The real implementation (RealOidcPort) is a near-literal wrapper of
 * openid-client v6's functional API
 * (https://github.com/panva/openid-client) — discovery, authorization URL
 * construction with PKCE + nonce, and authorization-code-grant token
 * exchange.
 */
export interface OidcPort {
  buildAuthorizationUrl(input: {
    redirectUri: string;
    state: string;
    codeVerifier: string;
    nonce: string;
    scope?: string;
  }): Promise<{ url: string; codeChallenge: string }>;

  /**
   * Exchanges the callback URL (containing `code` + `state`) for tokens and
   * returns verified ID token claims. Implementations must verify `state`,
   * PKCE `code_verifier`, `nonce` (when provided), and — critically — that
   * the provider actually verified the email address before returning it
   * as `email`. This method's return value is trusted as already-verified
   * by callers.
   */
  handleCallback(input: {
    currentUrl: URL;
    expectedState: string;
    codeVerifier: string;
    expectedNonce?: string;
  }): Promise<{ sub: string; email?: string; name?: string; raw: Record<string, unknown> }>;
}

export class EmailNotVerifiedError extends Error {
  constructor(email: string) {
    super(
      `Identity provider asserted email "${email}" without email_verified === true. Refusing to ` +
        "trust an unverified email for authentication — an IdP that can be configured (or tricked) " +
        "into asserting an unverified email on an allowed domain would otherwise let an attacker " +
        "impersonate a real employee and inherit their agent binding.",
    );
    this.name = "EmailNotVerifiedError";
  }
}

export interface RealOidcPortOptions {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /**
   * When true (the default), a returned `email` claim is used only if the
   * ID token also asserts `email_verified === true`; otherwise the
   * callback throws `EmailNotVerifiedError`. Set to `false` only if your
   * IdP is known to never assert `email_verified` and you've verified
   * email ownership some other way — this is a foot-gun, so it defaults
   * strict.
   */
  requireVerifiedEmail?: boolean;
}

/**
 * Wraps openid-client's certified OIDC client. Discovery happens lazily on
 * first use and is cached for the process lifetime — but a *failed*
 * discovery is never cached (see `cached-async.ts`), so a transient IdP
 * outage during the first login attempt doesn't permanently break every
 * subsequent login until process restart. Call `refresh()` to force
 * re-discovery on demand (e.g. after known key rotation).
 */
export class RealOidcPort implements OidcPort {
  private readonly requireVerifiedEmail: boolean;
  private readonly discoveryCache = createCachedAsync(() =>
    import("openid-client").then((client) =>
      client.discovery(new URL(this.options.issuerUrl), this.options.clientId, this.options.clientSecret),
    ),
  );

  constructor(private readonly options: RealOidcPortOptions) {
    this.requireVerifiedEmail = options.requireVerifiedEmail ?? true;
  }

  private async getConfig() {
    return this.discoveryCache.get();
  }

  async refresh(): Promise<void> {
    this.discoveryCache.reset();
  }

  async buildAuthorizationUrl(input: {
    redirectUri: string;
    state: string;
    codeVerifier: string;
    nonce: string;
    scope?: string;
  }): Promise<{ url: string; codeChallenge: string }> {
    const client = await import("openid-client");
    const config = await this.getConfig();
    const codeChallenge = await client.calculatePKCECodeChallenge(input.codeVerifier);
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: input.redirectUri,
      scope: input.scope ?? "openid email profile",
      state: input.state,
      nonce: input.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return { url: url.toString(), codeChallenge };
  }

  async handleCallback(input: {
    currentUrl: URL;
    expectedState: string;
    codeVerifier: string;
    expectedNonce?: string;
  }): Promise<{ sub: string; email?: string; name?: string; raw: Record<string, unknown> }> {
    const client = await import("openid-client");
    const config = await this.getConfig();
    const tokens = await client.authorizationCodeGrant(config, input.currentUrl, {
      pkceCodeVerifier: input.codeVerifier,
      expectedState: input.expectedState,
      ...(input.expectedNonce ? { expectedNonce: input.expectedNonce } : {}),
    });
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== "string") {
      throw new Error("OIDC provider did not return a valid `sub` claim.");
    }

    let email: string | undefined = typeof claims.email === "string" ? claims.email : undefined;
    if (email && this.requireVerifiedEmail && claims.email_verified !== true) {
      throw new EmailNotVerifiedError(email);
    }

    return {
      sub: claims.sub,
      email,
      name: typeof claims.name === "string" ? claims.name : undefined,
      raw: claims as Record<string, unknown>,
    };
  }
}
