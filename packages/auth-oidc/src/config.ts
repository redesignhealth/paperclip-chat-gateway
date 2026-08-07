import { z } from "zod";

/**
 * Generic OIDC adapter config, read from env by the composition root
 * (apps/gateway). Deliberately provider-agnostic: any standards-compliant
 * OIDC issuer works, so this package has no vendor-specific branching.
 */
export const oidcConfigSchema = z.object({
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(),
  /**
   * Only emails on these domains may complete login. Empty means "no
   * domain restriction," which the loader will refuse in production-like
   * environments — see loadOidcConfigFromEnv.
   */
  allowedEmailDomains: z.array(z.string().min(1)),
});

export type OidcConfig = z.infer<typeof oidcConfigSchema>;

export interface LoadOidcConfigFromEnvOptions {
  env?: NodeJS.ProcessEnv;
  /** Set true only for local dev — allows an empty allow-list. */
  allowUnrestrictedDomains?: boolean;
}

export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcConfigError";
  }
}

export function loadOidcConfigFromEnv(options: LoadOidcConfigFromEnvOptions = {}): OidcConfig {
  const env = options.env ?? process.env;
  const domainsRaw = env.OIDC_ALLOWED_EMAIL_DOMAINS?.trim() ?? "";
  const allowedEmailDomains = domainsRaw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);

  if (allowedEmailDomains.length === 0 && !options.allowUnrestrictedDomains) {
    throw new OidcConfigError(
      "OIDC_ALLOWED_EMAIL_DOMAINS must be set to a comma-separated list of domains. Refusing to " +
        "start with an unrestricted allow-list outside of explicit local-dev opt-in.",
    );
  }

  const parsed = oidcConfigSchema.safeParse({
    issuerUrl: env.OIDC_ISSUER_URL,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: env.OIDC_REDIRECT_URI,
    allowedEmailDomains,
  });

  if (!parsed.success) {
    throw new OidcConfigError(`Invalid OIDC configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function isEmailDomainAllowed(email: string, allowedEmailDomains: readonly string[]): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedEmailDomains.includes(domain);
}
