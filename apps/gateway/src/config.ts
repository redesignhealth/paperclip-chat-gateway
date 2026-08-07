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
  const parsed = gatewayConfigFileSchema.safeParse(JSON.parse(contents));
  if (!parsed.success) {
    throw new GatewayConfigError(`Invalid gateway config file at "${filePath}": ${parsed.error.message}`);
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
});

export function loadAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = appEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new GatewayConfigError(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
