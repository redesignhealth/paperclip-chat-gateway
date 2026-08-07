import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GatewayConfigError,
  isAdminEmailAllowed,
  isAgentBrokerEnabled,
  isDbStoreEnabled,
  loadAppEnv,
  loadGatewayConfigFile,
  parseAdminEmailAllowlist,
  parseBooleanEnv,
  parseCompanyIdAllowlist,
  parseRequireVerifiedEmailEnv,
  parseTrustProxy,
  validateSchedulerBaseUrl,
} from "../src/config.js";

describe("loadGatewayConfigFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pcg-gateway-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(contents: unknown): Promise<string> {
    const filePath = path.join(dir, "gateway.json");
    await writeFile(filePath, JSON.stringify(contents));
    return filePath;
  }

  it("loads a valid config", async () => {
    const filePath = await writeConfig({
      employees: [{ employeeId: "emp-alice", email: "alice@example.com" }],
      bindings: [{ employeeId: "emp-alice", agentId: "agent-alice-cfo" }],
    });
    const config = await loadGatewayConfigFile(filePath);
    expect(config.employees).toHaveLength(1);
  });

  it("fails closed at load time when a binding references an employeeId not in the roster", async () => {
    const filePath = await writeConfig({
      employees: [{ employeeId: "emp-alice", email: "alice@example.com" }],
      bindings: [{ employeeId: "emp-bob-typo", agentId: "agent-alice-cfo" }],
    });
    await expect(loadGatewayConfigFile(filePath)).rejects.toThrow(GatewayConfigError);
  });

  it("rejects a file that isn't valid JSON with a clear error instead of an unhandled SyntaxError", async () => {
    const filePath = path.join(dir, "gateway.json");
    await writeFile(filePath, "{ not valid json");
    await expect(loadGatewayConfigFile(filePath)).rejects.toThrow(GatewayConfigError);
  });

  it("rejects a missing file with a clear error", async () => {
    await expect(loadGatewayConfigFile(path.join(dir, "does-not-exist.json"))).rejects.toThrow(GatewayConfigError);
  });

  it("names GATEWAY_CONFIG_PATH and the resolved path when the config is missing, so a container built without a mounted config fails fast with an actionable message", async () => {
    const missingPath = path.join(dir, "does-not-exist.json");
    let thrown: unknown;
    try {
      await loadGatewayConfigFile(missingPath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayConfigError);
    const message = (thrown as Error).message;
    expect(message).toContain("GATEWAY_CONFIG_PATH");
    expect(message).toContain(missingPath);
  });
});

describe("parseTrustProxy", () => {
  it("returns undefined for unset/empty values (defaults to not trusting forwarded headers)", () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy("")).toBeUndefined();
  });

  it("parses boolean-ish strings", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("parses a bare integer as a hop count", () => {
    expect(parseTrustProxy("2")).toBe(2);
  });

  it("parses a single IP/CIDR as a string", () => {
    expect(parseTrustProxy("127.0.0.1")).toBe("127.0.0.1");
  });

  it("parses a comma-separated list as an array", () => {
    expect(parseTrustProxy("10.0.0.1, 10.0.0.2")).toEqual(["10.0.0.1", "10.0.0.2"]);
  });
});

describe("parseBooleanEnv", () => {
  it("treats unset/empty and anything but a truthy token as false", () => {
    expect(parseBooleanEnv(undefined)).toBe(false);
    expect(parseBooleanEnv("")).toBe(false);
    expect(parseBooleanEnv("nope")).toBe(false);
  });

  it("parses common truthy tokens case-insensitively", () => {
    expect(parseBooleanEnv("1")).toBe(true);
    expect(parseBooleanEnv("true")).toBe(true);
    expect(parseBooleanEnv("TRUE")).toBe(true);
    expect(parseBooleanEnv("yes")).toBe(true);
    expect(parseBooleanEnv("on")).toBe(true);
  });
});

describe("parseRequireVerifiedEmailEnv", () => {
  it("defaults to strict (true) when unset", () => {
    expect(parseRequireVerifiedEmailEnv(undefined)).toBe(true);
  });

  it("is strict (true) for the literal string \"true\"", () => {
    expect(parseRequireVerifiedEmailEnv("true")).toBe(true);
  });

  it("is relaxed (false) only for the literal string \"false\"", () => {
    expect(parseRequireVerifiedEmailEnv("false")).toBe(false);
  });
});

describe("parseCompanyIdAllowlist", () => {
  it("returns an empty array for unset/empty values", () => {
    expect(parseCompanyIdAllowlist(undefined)).toEqual([]);
    expect(parseCompanyIdAllowlist("")).toEqual([]);
  });

  it("splits, trims, and drops empty entries", () => {
    expect(parseCompanyIdAllowlist("company-1, company-2 ,, company-3")).toEqual([
      "company-1",
      "company-2",
      "company-3",
    ]);
  });
});

describe("validateSchedulerBaseUrl", () => {
  it("accepts an https URL with a normal hostname", () => {
    expect(validateSchedulerBaseUrl("https://scheduler.example.com", false)).toBeNull();
  });

  it("rejects a plain http URL by default", () => {
    expect(validateSchedulerBaseUrl("http://scheduler.example.com", false)).toMatch(/https/);
  });

  it("rejects the cloud-metadata address by default", () => {
    expect(validateSchedulerBaseUrl("https://169.254.169.254/latest/meta-data", false)).toMatch(
      /loopback\/link-local\/metadata/,
    );
  });

  it("rejects loopback addresses and localhost by default", () => {
    expect(validateSchedulerBaseUrl("https://127.0.0.1:8080", false)).not.toBeNull();
    expect(validateSchedulerBaseUrl("https://localhost:8080", false)).not.toBeNull();
  });

  it("allows http and loopback when explicitly opted into for dev", () => {
    expect(validateSchedulerBaseUrl("http://127.0.0.1:8080", true)).toBeNull();
  });

  it("rejects a malformed URL", () => {
    expect(validateSchedulerBaseUrl("not-a-url", false)).not.toBeNull();
  });

  it("rejects the metadata.google.internal hostname by default", () => {
    expect(validateSchedulerBaseUrl("https://metadata.google.internal/", false)).not.toBeNull();
  });

  describe("IPv6 loopback/link-local/unique-local coverage", () => {
    it("rejects ::1 (IPv6 loopback) — URL.hostname serializes this as \"[::1]\", brackets included", () => {
      expect(validateSchedulerBaseUrl("https://[::1]:8080", false)).not.toBeNull();
    });

    it("rejects ::ffff:127.0.0.1 (IPv4-mapped IPv6 loopback)", () => {
      expect(validateSchedulerBaseUrl("https://[::ffff:127.0.0.1]:8080", false)).not.toBeNull();
    });

    it("rejects fe80::/10 link-local addresses", () => {
      expect(validateSchedulerBaseUrl("https://[fe80::1]:8080", false)).not.toBeNull();
      expect(validateSchedulerBaseUrl("https://[febf::1]:8080", false)).not.toBeNull();
    });

    it("rejects fc00::/7 unique-local addresses", () => {
      expect(validateSchedulerBaseUrl("https://[fc00::1]:8080", false)).not.toBeNull();
      expect(validateSchedulerBaseUrl("https://[fd12:3456::1]:8080", false)).not.toBeNull();
    });

    it("allows a normal global-unicast IPv6 address", () => {
      expect(validateSchedulerBaseUrl("https://[2001:db8::1]:8080", false)).toBeNull();
    });

    it("allows IPv6 loopback when explicitly opted into for dev", () => {
      expect(validateSchedulerBaseUrl("http://[::1]:8080", true)).toBeNull();
    });
  });
});

describe("isAgentBrokerEnabled", () => {
  it("is false when AGENT_JWT_SECRET is unset", () => {
    expect(isAgentBrokerEnabled({ AGENT_JWT_SECRET: undefined })).toBe(false);
  });

  it("is true when AGENT_JWT_SECRET is set", () => {
    expect(isAgentBrokerEnabled({ AGENT_JWT_SECRET: "a-secret-at-least-32-characters-long" })).toBe(true);
  });
});

describe("loadAppEnv — agent broker is opt-in", () => {
  const BASE_ENV = {
    COOKIE_SECRET: "a-cookie-secret-at-least-32-characters",
    PAPERCLIP_API_BASE_URL: "https://paperclip.example/api",
    OIDC_ISSUER_URL: "https://issuer.example",
    OIDC_CLIENT_ID: "client-id",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_REDIRECT_URI: "https://gateway.example/auth/callback",
    OIDC_ALLOWED_EMAIL_DOMAINS: "example.com",
  };

  it("starts successfully with the agent broker unconfigured (no AGENT_JWT_* set)", () => {
    const env = loadAppEnv(BASE_ENV as unknown as NodeJS.ProcessEnv);
    expect(env.AGENT_JWT_SECRET).toBeUndefined();
    expect(isAgentBrokerEnabled(env)).toBe(false);
  });

  it("rejects a broker secret shorter than 32 characters when the broker is being enabled", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        AGENT_JWT_SECRET: "too-short",
        AGENT_JWT_COMPANY_ID: "company-1",
        AGENT_JWT_AUDIENCE: "paperclip-api",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("rejects an enabled broker with no AGENT_JWT_COMPANY_ID allowlist", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        AGENT_JWT_SECRET: "a-secret-at-least-32-characters-long",
        AGENT_JWT_AUDIENCE: "paperclip-api",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("rejects an enabled broker with neither AGENT_JWT_ISSUER nor AGENT_JWT_AUDIENCE set", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        AGENT_JWT_SECRET: "a-secret-at-least-32-characters-long",
        AGENT_JWT_COMPANY_ID: "company-1",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("rejects an enabled broker with only AGENT_JWT_AUDIENCE set (AGENT_JWT_ISSUER missing) — both are required", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        AGENT_JWT_SECRET: "a-secret-at-least-32-characters-long",
        AGENT_JWT_COMPANY_ID: "company-1",
        AGENT_JWT_AUDIENCE: "paperclip-api",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("rejects an enabled broker with only AGENT_JWT_ISSUER set (AGENT_JWT_AUDIENCE missing) — both are required", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        AGENT_JWT_SECRET: "a-secret-at-least-32-characters-long",
        AGENT_JWT_COMPANY_ID: "company-1",
        AGENT_JWT_ISSUER: "paperclip",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("rejects an enabled broker whose AGENT_JWT_COMPANY_ID parses to an empty allowlist (e.g. a bare comma)", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        AGENT_JWT_SECRET: "a-secret-at-least-32-characters-long",
        AGENT_JWT_COMPANY_ID: ",",
        AGENT_JWT_ISSUER: "paperclip",
        AGENT_JWT_AUDIENCE: "paperclip-api",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("rejects AGENT_JWT_COMPANY_ID/ISSUER/AUDIENCE being set without AGENT_JWT_SECRET", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        AGENT_JWT_COMPANY_ID: "company-1",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("rejects AGENT_JWT_INSTANCE_ID being set alone without AGENT_JWT_SECRET", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        AGENT_JWT_INSTANCE_ID: "some-instance",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("rejects AGENT_JWT_ENABLE_LEGACY_FALLBACK being set alone without AGENT_JWT_SECRET", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        AGENT_JWT_ENABLE_LEGACY_FALLBACK: "true",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("rejects AGENT_JWT_CLOCK_TOLERANCE_SECONDS being set alone without AGENT_JWT_SECRET", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        AGENT_JWT_CLOCK_TOLERANCE_SECONDS: "10",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("rejects AGENT_JWT_MAX_TOKEN_AGE_SECONDS being set alone without AGENT_JWT_SECRET", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        AGENT_JWT_MAX_TOKEN_AGE_SECONDS: "3600",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("accepts a fully and correctly configured broker", () => {
    const env = loadAppEnv({
      ...BASE_ENV,
      AGENT_JWT_SECRET: "a-secret-at-least-32-characters-long",
      AGENT_JWT_COMPANY_ID: "company-1,company-2",
      AGENT_JWT_ISSUER: "paperclip",
      AGENT_JWT_AUDIENCE: "paperclip-api",
    } as unknown as NodeJS.ProcessEnv);
    expect(isAgentBrokerEnabled(env)).toBe(true);
    expect(parseCompanyIdAllowlist(env.AGENT_JWT_COMPANY_ID)).toEqual(["company-1", "company-2"]);
  });

  it("rejects an insecure SCHEDULER_BASE_URL by default", () => {
    expect(() =>
      loadAppEnv({
        ...BASE_ENV,
        SCHEDULER_BASE_URL: "http://169.254.169.254/",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(GatewayConfigError);
  });

  it("accepts an insecure SCHEDULER_BASE_URL when SCHEDULER_ALLOW_INSECURE_URL is set (dev escape hatch)", () => {
    const env = loadAppEnv({
      ...BASE_ENV,
      SCHEDULER_BASE_URL: "http://127.0.0.1:4000",
      SCHEDULER_ALLOW_INSECURE_URL: "true",
    } as unknown as NodeJS.ProcessEnv);
    expect(env.SCHEDULER_BASE_URL).toBe("http://127.0.0.1:4000");
  });

  describe("OIDC_REQUIRE_VERIFIED_EMAIL", () => {
    it("is strict by default when unset — absent env var must behave exactly as before this option existed", () => {
      const env = loadAppEnv(BASE_ENV as unknown as NodeJS.ProcessEnv);
      expect(env.OIDC_REQUIRE_VERIFIED_EMAIL).toBeUndefined();
      expect(parseRequireVerifiedEmailEnv(env.OIDC_REQUIRE_VERIFIED_EMAIL)).toBe(true);
    });

    it("accepts the literal string \"false\" to disable the check", () => {
      const env = loadAppEnv({
        ...BASE_ENV,
        OIDC_REQUIRE_VERIFIED_EMAIL: "false",
      } as unknown as NodeJS.ProcessEnv);
      expect(parseRequireVerifiedEmailEnv(env.OIDC_REQUIRE_VERIFIED_EMAIL)).toBe(false);
    });

    it("accepts the literal string \"true\" explicitly", () => {
      const env = loadAppEnv({
        ...BASE_ENV,
        OIDC_REQUIRE_VERIFIED_EMAIL: "true",
      } as unknown as NodeJS.ProcessEnv);
      expect(parseRequireVerifiedEmailEnv(env.OIDC_REQUIRE_VERIFIED_EMAIL)).toBe(true);
    });

    it("fails closed at startup on a malformed value instead of silently becoming permissive", () => {
      expect(() =>
        loadAppEnv({
          ...BASE_ENV,
          OIDC_REQUIRE_VERIFIED_EMAIL: "nope",
        } as unknown as NodeJS.ProcessEnv),
      ).toThrow(GatewayConfigError);
    });

    it("rejects common near-miss truthy/falsy tokens rather than guessing (\"1\", \"False\", trailing whitespace)", () => {
      for (const value of ["1", "0", "False", "TRUE", "false ", " false"]) {
        expect(() =>
          loadAppEnv({
            ...BASE_ENV,
            OIDC_REQUIRE_VERIFIED_EMAIL: value,
          } as unknown as NodeJS.ProcessEnv),
        ).toThrow(GatewayConfigError);
      }
    });
  });

  describe("DATABASE_URL / AGENT_KEY_ENCRYPTION_KEY — DB-backed store is opt-in, but fails closed once opted in", () => {
    it("starts successfully with DATABASE_URL unset (file/env store)", () => {
      const env = loadAppEnv(BASE_ENV as unknown as NodeJS.ProcessEnv);
      expect(isDbStoreEnabled(env)).toBe(false);
    });

    it("requires AGENT_KEY_ENCRYPTION_KEY when DATABASE_URL is set", () => {
      expect(() =>
        loadAppEnv({
          ...BASE_ENV,
          DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        } as unknown as NodeJS.ProcessEnv),
      ).toThrow(GatewayConfigError);
    });

    it("rejects an AGENT_KEY_ENCRYPTION_KEY that isn't exactly 64 hex characters", () => {
      expect(() =>
        loadAppEnv({
          ...BASE_ENV,
          DATABASE_URL: "postgres://user:pass@localhost:5432/db",
          AGENT_KEY_ENCRYPTION_KEY: "not-hex-and-way-too-short",
        } as unknown as NodeJS.ProcessEnv),
      ).toThrow(GatewayConfigError);
    });

    it("accepts a valid 64-hex-character AGENT_KEY_ENCRYPTION_KEY alongside DATABASE_URL", () => {
      const env = loadAppEnv({
        ...BASE_ENV,
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        AGENT_KEY_ENCRYPTION_KEY: "a".repeat(64),
      } as unknown as NodeJS.ProcessEnv);
      expect(isDbStoreEnabled(env)).toBe(true);
    });
  });

  describe("GATEWAY_ADMIN_EMAILS — fails closed when unset/empty", () => {
    it("parses an unset allowlist to an empty set (nobody is admin)", () => {
      expect(parseAdminEmailAllowlist(undefined).size).toBe(0);
      expect(isAdminEmailAllowed(parseAdminEmailAllowlist(undefined), "anyone@example.com")).toBe(false);
    });

    it("parses an empty/whitespace-only allowlist to an empty set", () => {
      expect(parseAdminEmailAllowlist("").size).toBe(0);
      expect(parseAdminEmailAllowlist(" , ,").size).toBe(0);
    });

    it("parses a comma-separated allowlist and matches case-insensitively", () => {
      const allowlist = parseAdminEmailAllowlist("Alice@Example.com, bob@example.com");
      expect(isAdminEmailAllowed(allowlist, "alice@example.com")).toBe(true);
      expect(isAdminEmailAllowed(allowlist, "ALICE@EXAMPLE.COM")).toBe(true);
      expect(isAdminEmailAllowed(allowlist, "bob@example.com")).toBe(true);
      expect(isAdminEmailAllowed(allowlist, "mallory@example.com")).toBe(false);
    });
  });
});
