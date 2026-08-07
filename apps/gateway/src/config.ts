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
    throw new GatewayConfigError(`Could not read gateway config file at "${filePath}": ${(error as Error).message}`);
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
   * Fastify `trustProxy` setting, forwarded verbatim to `buildServer`.
   * Leave unset (defaults to not trusting forwarded headers) unless this
   * gateway sits behind a reverse proxy you control that strips
   * client-supplied `X-Forwarded-*` headers before setting its own.
   * Accepts a boolean ("true"/"false"), a single IP/CIDR, a comma-separated
   * list of them, or a hop count (an integer).
   */
  TRUST_PROXY?: string;
}

const appEnvSchema = z.object({
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
});

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

export function loadAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = appEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new GatewayConfigError(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
