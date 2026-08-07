import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  bindingTableConfigSchema,
  type ConfigEmployee,
} from "@paperclip-chat-gateway/core";

const employeeConfigSchema = z.object({
  employeeId: z.string().min(1),
  email: z.string().email(),
  name: z.string().optional(),
});

export const gatewayConfigFileSchema = z.object({
  employees: z.array(employeeConfigSchema),
  bindings: bindingTableConfigSchema.shape.bindings,
});

export type GatewayConfigFile = z.infer<typeof gatewayConfigFileSchema>;

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

/**
 * Loads the employee list and employee->agent bindings from a single JSON
 * file (path from `GATEWAY_CONFIG_PATH`, default `./config/gateway.json`).
 * Both are deny-by-default: an employee not in this file cannot log in
 * (ConfigIdentityResolver returns null), and an employee with no binding
 * entry cannot reach any agent (BindingTable returns null). See
 * config/gateway.example.json for the shape.
 */
export async function loadGatewayConfigFile(filePath: string): Promise<GatewayConfigFile> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    // This is the config the built Docker image expects to find at
    // runtime; it is deliberately excluded from the build context (see
    // .dockerignore + apps/gateway/Dockerfile) and must be provided at
    // deploy time via a volume mount or a GATEWAY_CONFIG_PATH override.
    // Name both the env var and the resolved path so an operator with a
    // freshly-built image and no mount gets a startup error that tells
    // them exactly what to fix, not a generic ENOENT.
    throw new GatewayConfigError(
      `Could not read gateway config file at "${filePath}" (resolved from GATEWAY_CONFIG_PATH, ` +
        `default "./config/gateway.json"): ${(error as Error).message}. ` +
        "This file is not baked into the Docker image (see config/gateway.example.json for its shape) " +
        "— mount a real config file at this path, or set GATEWAY_CONFIG_PATH to point at one, before starting.",
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (error) {
    throw new GatewayConfigError(`Gateway config file at "${filePath}" is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = gatewayConfigFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new GatewayConfigError(`Invalid gateway config file at "${filePath}": ${parsed.error.message}`);
  }

  // Cross-validation: a binding for an employeeId not in the roster is a
  // config typo that would otherwise surface as a confusing runtime 403
  // instead of failing closed at boot, same as BindingTable's own
  // duplicate-entry checks.
  const employeeIds = new Set(parsed.data.employees.map((e) => e.employeeId));
  const unknownEmployeeIds = [...new Set(parsed.data.bindings.map((b) => b.employeeId).filter((id) => !employeeIds.has(id)))];
  if (unknownEmployeeIds.length > 0) {
    throw new GatewayConfigError(
      `Gateway config file at "${filePath}" has bindings for employeeId(s) not present in "employees": ` +
        `${unknownEmployeeIds.join(", ")}. Every binding must reference a known employee.`,
    );
  }

  return parsed.data;
}

export function toConfigEmployees(config: GatewayConfigFile): ConfigEmployee[] {
  return config.employees.map((e) => ({ employeeId: e.employeeId, email: e.email, name: e.name }));
}

export interface AppEnv {
  PORT: string;
  GATEWAY_CONFIG_PATH: string;
  COOKIE_SECRET: string;
  PAPERCLIP_API_BASE_URL: string;
  OIDC_ISSUER_URL: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  OIDC_REDIRECT_URI: string;
  OIDC_ALLOWED_EMAIL_DOMAINS: string;
  CREDENTIAL_STORE_KIND: "env" | "file";
  CREDENTIAL_STORE_FILE_PATH?: string;
  /** Override for the UI static-assets directory; auto-resolved from the transport-web package when unset. */
  UI_DIST_PATH?: string;
  /**
   * The master secret Paperclip agent run tokens are (indirectly) signed
   * from — i.e. Paperclip's own `PAPERCLIP_AGENT_JWT_SECRET` /
   * `BETTER_AUTH_SECRET`. This gateway and Paperclip must run in the same
   * trust domain and share this value out-of-band via your secret store;
   * there is no default.
   *
   * The agent-facing identity broker (`POST /api/agent/scheduler`) is an
   * OPT-IN feature: leaving this unset disables that route entirely and
   * the gateway starts normally otherwise. Setting it turns the broker on
   * and triggers strict validation of every other AGENT_JWT_ setting (and
   * SCHEDULER_BASE_URL) below — there is still no default secret value.
   * See README "Trust model" for why the downstream scheduler must NEVER
   * be given this value.
   */
  AGENT_JWT_SECRET?: string;
  /**
   * Required whenever AGENT_JWT_SECRET is set. Comma-separated allowlist of
   * Paperclip company ids this gateway accepts agent run tokens for — see
   * `AgentTokenConfig.expectedCompanyIds`. Without this, a validly-signed
   * token minted for a different company on the same Paperclip control
   * plane would verify successfully, defeating company-scoping.
   */
  AGENT_JWT_COMPANY_ID?: string;
  /** Paperclip control-plane instanceId whose tokens this gateway accepts. Defaults to "default" (the live plane). */
  AGENT_JWT_INSTANCE_ID?: string;
  AGENT_JWT_ISSUER?: string;
  AGENT_JWT_AUDIENCE?: string;
  /** Opt-in only; mirrors Paperclip's own flag name and defaults to false (fail closed). */
  AGENT_JWT_ENABLE_LEGACY_FALLBACK?: string;
  /** Clock-skew tolerance (seconds) for exp/nbf checks. Defaults to 5 when unset. */
  AGENT_JWT_CLOCK_TOLERANCE_SECONDS?: string;
  /** Optional additional bound on token age (seconds), independent of `exp`. Unset by default. */
  AGENT_JWT_MAX_TOKEN_AGE_SECONDS?: string;
  /**
   * Base URL of the downstream scheduler service the agent-facing broker
   * route forwards resolved-identity calls to. Left unset in a deployment
   * that hasn't wired up a real scheduler yet — the broker route responds
   * 501 in that case instead of guessing at an endpoint. See README's "Open
   * transport question." Must be `https://` and must not resolve to a
   * link-local/loopback/metadata address unless SCHEDULER_ALLOW_INSECURE_URL
   * is explicitly set (local dev only).
   */
  SCHEDULER_BASE_URL?: string;
  /** Dev-only escape hatch: allows http:// and loopback/link-local SCHEDULER_BASE_URL values. Never set in production. */
  SCHEDULER_ALLOW_INSECURE_URL?: string;
  /**
   * Fastify `trustProxy` setting, forwarded verbatim to `buildServer`.
   * Leave unset (defaults to not trusting forwarded headers) unless this
   * gateway sits behind a reverse proxy you control that strips
   * client-supplied `X-Forwarded-*` headers before setting its own.
   * Accepts a boolean ("true"/"false"), a single IP/CIDR, a comma-separated
   * list of them, or a hop count (an integer).
   */
  TRUST_PROXY?: string;
  /**
   * Controls `RealOidcPortOptions.requireVerifiedEmail`. Leave unset
   * (defaults to strict/`true`) unless your IdP is known to assert
   * `email_verified: false` for legitimate accounts it fully controls (e.g.
   * Okta org authorization servers reflect Okta's own email-verification
   * workflow, not whether the address is real — directory-synced or
   * admin-created users commonly get `email_verified = false` forever even
   * though the address is their actual work identity). Setting this to
   * `false` means the gateway trusts whatever email the IdP asserts with no
   * further check — only acceptable when you fully control the IdP and it
   * is your sole identity source. Accepts only the literal strings "true"
   * or "false"; any other value fails validation at startup rather than
   * silently falling back to either value. See README's "Reverse proxies
   * and TRUST_PROXY" section (documented alongside it).
   */
  OIDC_REQUIRE_VERIFIED_EMAIL?: string;
  /**
   * Postgres connection string for the roster/binding/credential store.
   * When set, this deployment uses the DB-backed store
   * (`@paperclip-chat-gateway/store-postgres`) instead of the file/env
   * store — GATEWAY_CONFIG_PATH and CREDENTIAL_STORE_KIND are then
   * ignored. Leave unset for local dev / the existing file/env path.
   */
  DATABASE_URL?: string;
  /**
   * Required whenever DATABASE_URL is set. The raw AES-256-GCM key (32
   * bytes, hex-encoded — exactly 64 hex characters), used to encrypt/decrypt
   * agent API keys at the application layer before they reach Postgres. See
   * `@paperclip-chat-gateway/store-postgres`'s crypto.ts. There is no
   * default; losing this key makes every stored credential unrecoverable,
   * and it must never be logged or checked into source control.
   */
  AGENT_KEY_ENCRYPTION_KEY?: string;
  /**
   * Comma-separated allowlist of verified emails permitted to call the
   * `/api/admin/*` endpoints, matched case-insensitively. FAILS CLOSED when
   * unset or empty: nobody is admin, never "everybody is admin." Only
   * meaningful when DATABASE_URL is set (the admin API is only registered
   * against the DB-backed store — see registerAdminRoutes).
   */
  GATEWAY_ADMIN_EMAILS?: string;
}

/** Hosts that must never be reachable via SCHEDULER_BASE_URL outside explicit dev opt-in (cloud metadata + loopback). */
const BLOCKED_SCHEDULER_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "localhost"]);

function isIpv4LoopbackOrLinkLocal(hostname: string): boolean {
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!ipv4Match) return false;
  const first = Number(ipv4Match[1]);
  const second = Number(ipv4Match[2]);
  if (first === 127) return true;
  if (first === 169 && second === 254) return true;
  return false;
}

function isLoopbackOrLinkLocal(hostname: string): boolean {
  if (BLOCKED_SCHEDULER_HOSTS.has(hostname.toLowerCase())) return true;
  // IPv4 loopback (127.0.0.0/8) and link-local (169.254.0.0/16), including
  // the cloud-metadata address, which falls inside link-local.
  if (isIpv4LoopbackOrLinkLocal(hostname)) return true;

  // `URL.hostname` serializes IPv6 hosts WITH brackets (e.g. "[::1]"), so
  // strip them before doing any IPv6 comparison below.
  const bracketMatch = /^\[(.+)\]$/.exec(hostname);
  const host = (bracketMatch ? bracketMatch[1]! : hostname).toLowerCase();

  if (host === "::1") return true;

  // IPv4-mapped IPv6 loopback, e.g. "::ffff:127.0.0.1". Node's `URL` parser
  // normalizes the embedded IPv4 octets into two hex hextets rather than
  // keeping the dotted-decimal form (e.g. "::ffff:127.0.0.1" serializes as
  // "[::ffff:7f00:1]"), so match both the dotted and the hex-hextet forms.
  const ipv4MappedDottedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (ipv4MappedDottedMatch && isIpv4LoopbackOrLinkLocal(ipv4MappedDottedMatch[1]!)) return true;
  const ipv4MappedHexMatch = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host);
  if (ipv4MappedHexMatch) {
    // The IPv4 address's first two octets live entirely in the first of
    // the two trailing hextets (e.g. "7f00" -> 127.0.x.x); the second
    // hextet only carries the third/fourth octets, irrelevant to the
    // loopback/link-local checks below.
    const highHextet = Number.parseInt(ipv4MappedHexMatch[1]!, 16);
    const first = (highHextet >> 8) & 0xff;
    const second = highHextet & 0xff;
    if (first === 127) return true;
    if (first === 169 && second === 254) return true;
  }

  // Link-local unicast (fe80::/10): first 10 bits are 1111111010, i.e. the
  // first hextet is in the range fe80-febf.
  const firstHextetMatch = /^([0-9a-f]{1,4}):/.exec(host);
  if (firstHextetMatch) {
    const firstHextet = Number.parseInt(firstHextetMatch[1]!, 16);
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;
    // Unique local addresses (fc00::/7): first 7 bits are 1111110, i.e. the
    // first hextet's top byte is 0xfc or 0xfd.
    if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true;
  }

  return false;
}

/**
 * Validates SCHEDULER_BASE_URL beyond bare `.url()` shape-checking: no live
 * SSRF exists today (HttpSchedulerClient.forward throws
 * NotImplementedError), but this guard belongs with parsing, not with the
 * eventual caller, so it can't be forgotten when forward() is implemented.
 */
export function validateSchedulerBaseUrl(value: string, allowInsecure: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "SCHEDULER_BASE_URL must be a valid URL";
  }
  if (!allowInsecure && url.protocol !== "https:") {
    return "SCHEDULER_BASE_URL must use https:// (set SCHEDULER_ALLOW_INSECURE_URL=true for local dev only)";
  }
  if (!allowInsecure && isLoopbackOrLinkLocal(url.hostname)) {
    return (
      "SCHEDULER_BASE_URL must not point at a loopback/link-local/metadata address " +
      "(set SCHEDULER_ALLOW_INSECURE_URL=true for local dev only)"
    );
  }
  return null;
}

const appEnvSchema = z
  .object({
    PORT: z.string().default("3000"),
    GATEWAY_CONFIG_PATH: z.string().default("./config/gateway.json"),
    COOKIE_SECRET: z.string().min(32, "COOKIE_SECRET must be at least 32 characters"),
    PAPERCLIP_API_BASE_URL: z.string().url(),
    OIDC_ISSUER_URL: z.string().url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    OIDC_REDIRECT_URI: z.string().url(),
    OIDC_ALLOWED_EMAIL_DOMAINS: z.string().min(1),
    CREDENTIAL_STORE_KIND: z.enum(["env", "file"]).default("env"),
    CREDENTIAL_STORE_FILE_PATH: z.string().optional(),
    UI_DIST_PATH: z.string().optional(),
    TRUST_PROXY: z.string().optional(),
    OIDC_REQUIRE_VERIFIED_EMAIL: z.string().optional(),
    // The agent-facing identity broker is opt-in: no default, and unset
    // means the broker route is disabled rather than a boot-time failure.
    // When set, every AGENT_JWT_*/SCHEDULER_BASE_URL setting is validated
    // strictly below (see the top-level .superRefine) — there is still no
    // default secret value.
    AGENT_JWT_SECRET: z.string().optional(),
    AGENT_JWT_COMPANY_ID: z.string().optional(),
    AGENT_JWT_INSTANCE_ID: z.string().optional(),
    AGENT_JWT_ISSUER: z.string().optional(),
    AGENT_JWT_AUDIENCE: z.string().optional(),
    AGENT_JWT_ENABLE_LEGACY_FALLBACK: z.string().optional(),
    AGENT_JWT_CLOCK_TOLERANCE_SECONDS: z.string().optional(),
    AGENT_JWT_MAX_TOKEN_AGE_SECONDS: z.string().optional(),
    SCHEDULER_BASE_URL: z.string().optional(),
    SCHEDULER_ALLOW_INSECURE_URL: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    AGENT_KEY_ENCRYPTION_KEY: z.string().optional(),
    GATEWAY_ADMIN_EMAILS: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.DATABASE_URL !== undefined) {
      if (!val.AGENT_KEY_ENCRYPTION_KEY || !/^[0-9a-fA-F]{64}$/.test(val.AGENT_KEY_ENCRYPTION_KEY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AGENT_KEY_ENCRYPTION_KEY"],
          message:
            "AGENT_KEY_ENCRYPTION_KEY is required and must be exactly 64 hex characters (32 bytes, for " +
            "AES-256-GCM) when DATABASE_URL (the Postgres-backed store) is set.",
        });
      }
    }
    const brokerEnabled = val.AGENT_JWT_SECRET !== undefined;
    if (brokerEnabled) {
      if (val.AGENT_JWT_SECRET!.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AGENT_JWT_SECRET"],
          message: "AGENT_JWT_SECRET must be at least 32 characters",
        });
      }
      if (parseCompanyIdAllowlist(val.AGENT_JWT_COMPANY_ID).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AGENT_JWT_COMPANY_ID"],
          message:
            "AGENT_JWT_COMPANY_ID is required when AGENT_JWT_SECRET (the agent broker) is set, and must parse " +
            "to at least one non-empty, comma-separated company id (e.g. \",\" or \" \" is rejected)",
        });
      }
      if (!val.AGENT_JWT_ISSUER || !val.AGENT_JWT_AUDIENCE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AGENT_JWT_ISSUER"],
          message:
            "Both AGENT_JWT_ISSUER and AGENT_JWT_AUDIENCE are required when the agent broker is enabled " +
            "— this is a two-dimensional binding (issuer AND audience), and requiring only one of them " +
            "would collapse that defense-in-depth to a single claim",
        });
      }
      if (val.AGENT_JWT_CLOCK_TOLERANCE_SECONDS !== undefined && !/^\d+$/.test(val.AGENT_JWT_CLOCK_TOLERANCE_SECONDS)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AGENT_JWT_CLOCK_TOLERANCE_SECONDS"],
          message: "AGENT_JWT_CLOCK_TOLERANCE_SECONDS must be a non-negative integer",
        });
      }
      if (val.AGENT_JWT_MAX_TOKEN_AGE_SECONDS !== undefined && !/^\d+$/.test(val.AGENT_JWT_MAX_TOKEN_AGE_SECONDS)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AGENT_JWT_MAX_TOKEN_AGE_SECONDS"],
          message: "AGENT_JWT_MAX_TOKEN_AGE_SECONDS must be a non-negative integer",
        });
      }
    } else {
      const otherAgentJwtVarsSet =
        val.AGENT_JWT_COMPANY_ID !== undefined ||
        val.AGENT_JWT_INSTANCE_ID !== undefined ||
        val.AGENT_JWT_ISSUER !== undefined ||
        val.AGENT_JWT_AUDIENCE !== undefined ||
        val.AGENT_JWT_ENABLE_LEGACY_FALLBACK !== undefined ||
        val.AGENT_JWT_CLOCK_TOLERANCE_SECONDS !== undefined ||
        val.AGENT_JWT_MAX_TOKEN_AGE_SECONDS !== undefined;
      if (otherAgentJwtVarsSet) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AGENT_JWT_SECRET"],
          message: "AGENT_JWT_SECRET is required whenever any other AGENT_JWT_* setting is set",
        });
      }
    }
    if (val.SCHEDULER_BASE_URL !== undefined) {
      const allowInsecure = parseBooleanEnv(val.SCHEDULER_ALLOW_INSECURE_URL);
      const error = validateSchedulerBaseUrl(val.SCHEDULER_BASE_URL, allowInsecure);
      if (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SCHEDULER_BASE_URL"], message: error });
      }
    }
    if (
      val.OIDC_REQUIRE_VERIFIED_EMAIL !== undefined &&
      val.OIDC_REQUIRE_VERIFIED_EMAIL !== "true" &&
      val.OIDC_REQUIRE_VERIFIED_EMAIL !== "false"
    ) {
      // Fail closed at boot rather than guessing: this flag defaults to the
      // strict/safe behavior, so silently coercing an unrecognized value
      // (typo, "1", "yes", stray whitespace, ...) to `false` would be the
      // one outcome that must never happen by accident.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OIDC_REQUIRE_VERIFIED_EMAIL"],
        message: 'OIDC_REQUIRE_VERIFIED_EMAIL must be exactly "true" or "false" (or unset, which defaults to "true")',
      });
    }
  });

/** Parses a "1"/"true"/"yes"/"on" (case-insensitive) style boolean env var. Anything else, including unset, is false. */
export function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** True when the agent-facing identity broker is configured (AGENT_JWT_SECRET set) for this deployment. */
export function isAgentBrokerEnabled(env: Pick<AppEnv, "AGENT_JWT_SECRET">): boolean {
  return env.AGENT_JWT_SECRET !== undefined && env.AGENT_JWT_SECRET.length > 0;
}

/** Parses AGENT_JWT_COMPANY_ID's comma-separated allowlist into a trimmed, non-empty string array. */
export function parseCompanyIdAllowlist(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Parses AppEnv.TRUST_PROXY into the shape Fastify's trustProxy option expects. */
export function parseTrustProxy(value: string | undefined): boolean | string | string[] | number | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  const items = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return items.length === 1 ? items[0] : items;
}

/**
 * Parses AppEnv.OIDC_REQUIRE_VERIFIED_EMAIL into RealOidcPortOptions.requireVerifiedEmail.
 * Only meant to be called on a value that has already passed appEnvSchema's
 * validation (unset, "true", or "false") — anything else is a bug upstream,
 * not a value this function should ever need to guess about, so it falls
 * back to the strict/safe default rather than throwing again.
 */
export function parseRequireVerifiedEmailEnv(value: string | undefined): boolean {
  if (value === "false") return false;
  return true;
}

/**
 * Parses GATEWAY_ADMIN_EMAILS's comma-separated allowlist into a lowercased
 * Set. Unset or empty input yields an empty Set — the caller
 * (`isAdminEmailAllowed`) must treat an empty Set as "nobody is admin,"
 * never "everybody is admin," which is what makes this fail closed.
 */
export function parseAdminEmailAllowlist(value: string | undefined): ReadonlySet<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0),
  );
}

/** Case-insensitive membership check against the parsed GATEWAY_ADMIN_EMAILS allowlist. */
export function isAdminEmailAllowed(allowlist: ReadonlySet<string>, email: string): boolean {
  return allowlist.has(email.toLowerCase());
}

/** True when this deployment is configured to use the Postgres-backed store (see DATABASE_URL). */
export function isDbStoreEnabled(env: Pick<AppEnv, "DATABASE_URL">): boolean {
  return env.DATABASE_URL !== undefined && env.DATABASE_URL.length > 0;
}

export function loadAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = appEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new GatewayConfigError(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
