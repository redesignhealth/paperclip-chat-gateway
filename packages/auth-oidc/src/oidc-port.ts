/**
 * Thin seam around `openid-client` so OidcAdapter's login/callback logic is
 * testable against a mock issuer without real network discovery or crypto.
 * The real implementation (RealOidcPort) is a near-literal wrapper of
 * openid-client v6's functional API
 * (https://github.com/panva/openid-client) — discovery, authorization URL
 * construction with PKCE, and authorization-code-grant token exchange.
 */
export interface OidcPort {
  buildAuthorizationUrl(input: {
    redirectUri: string;
    state: string;
    codeVerifier: string;
    scope?: string;
  }): Promise<{ url: string; codeChallenge: string }>;

  /**
   * Exchanges the callback URL (containing `code` + `state`) for tokens and
   * returns verified ID token claims. Implementations must verify `state`
   * and PKCE `code_verifier` themselves — this method's return value is
   * trusted as already-verified by callers.
   */
  handleCallback(input: {
    currentUrl: URL;
    expectedState: string;
    codeVerifier: string;
  }): Promise<{ sub: string; email?: string; name?: string; raw: Record<string, unknown> }>;
}

export interface RealOidcPortOptions {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Wraps openid-client's certified OIDC client. Discovery happens lazily on
 * first use and is cached for the process lifetime; call `refresh()` if the
 * issuer's metadata needs to be re-fetched (e.g. after key rotation).
 */
export class RealOidcPort implements OidcPort {
  private configPromise: Promise<import("openid-client").Configuration> | null = null;

  constructor(private readonly options: RealOidcPortOptions) {}

  private async getConfig() {
    if (!this.configPromise) {
      this.configPromise = import("openid-client").then((client) =>
        client.discovery(new URL(this.options.issuerUrl), this.options.clientId, this.options.clientSecret),
      );
    }
    return this.configPromise;
  }

  async refresh(): Promise<void> {
    this.configPromise = null;
  }

  async buildAuthorizationUrl(input: {
    redirectUri: string;
    state: string;
    codeVerifier: string;
    scope?: string;
  }): Promise<{ url: string; codeChallenge: string }> {
    const client = await import("openid-client");
    const config = await this.getConfig();
    const codeChallenge = await client.calculatePKCECodeChallenge(input.codeVerifier);
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: input.redirectUri,
      scope: input.scope ?? "openid email profile",
      state: input.state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return { url: url.toString(), codeChallenge };
  }

  async handleCallback(input: {
    currentUrl: URL;
    expectedState: string;
    codeVerifier: string;
  }): Promise<{ sub: string; email?: string; name?: string; raw: Record<string, unknown> }> {
    const client = await import("openid-client");
    const config = await this.getConfig();
    const tokens = await client.authorizationCodeGrant(config, input.currentUrl, {
      pkceCodeVerifier: input.codeVerifier,
      expectedState: input.expectedState,
    });
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== "string") {
      throw new Error("OIDC provider did not return a valid `sub` claim.");
    }
    return {
      sub: claims.sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
      name: typeof claims.name === "string" ? claims.name : undefined,
      raw: claims as Record<string, unknown>,
    };
  }
}
