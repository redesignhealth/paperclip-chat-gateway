import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BindingTable,
  ConfigIdentityResolver,
  EnvAgentCredentialStore,
  FileAgentCredentialStore,
  HttpPaperclipClient,
  InMemorySessionStore,
  type AgentCredentialStore,
} from "@paperclip-chat-gateway/core";
import { loadOidcConfigFromEnv, OidcAdapter, RealOidcPort } from "@paperclip-chat-gateway/auth-oidc";
import { buildServer, type GatewayDeps } from "@paperclip-chat-gateway/transport-web";
import { loadAppEnv, loadGatewayConfigFile, toConfigEmployees } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const env = loadAppEnv();
  const gatewayConfig = await loadGatewayConfigFile(env.GATEWAY_CONFIG_PATH);

  const bindings = BindingTable.fromConfig({ bindings: gatewayConfig.bindings });
  const identityResolver = new ConfigIdentityResolver(toConfigEmployees(gatewayConfig));

  const credentials: AgentCredentialStore =
    env.CREDENTIAL_STORE_KIND === "file"
      ? await FileAgentCredentialStore.load(
          env.CREDENTIAL_STORE_FILE_PATH ?? (() => {
            throw new Error("CREDENTIAL_STORE_FILE_PATH is required when CREDENTIAL_STORE_KIND=file");
          })(),
        )
      : new EnvAgentCredentialStore();

  const oidcConfig = loadOidcConfigFromEnv({ env: process.env });
  const oidc = new OidcAdapter(
    oidcConfig,
    new RealOidcPort({
      issuerUrl: oidcConfig.issuerUrl,
      clientId: oidcConfig.clientId,
      clientSecret: oidcConfig.clientSecret,
    }),
  );

  const deps: GatewayDeps = {
    oidc,
    bindings,
    credentials,
    sessions: new InMemorySessionStore(),
    paperclipClientFor: (_agentId, apiKey) =>
      new HttpPaperclipClient({ baseUrl: env.PAPERCLIP_API_BASE_URL, apiKey }),
    paperclipApiBaseUrl: env.PAPERCLIP_API_BASE_URL,
    cookieSecret: env.COOKIE_SECRET,
    resolveEmployeeId: async (claims) => {
      const employee = await identityResolver.resolve({ subject: claims.subject, email: claims.email });
      return employee?.employeeId ?? null;
    },
  };

  const uiDistPath = path.resolve(__dirname, "../../transport-web/ui/dist");
  const app = await buildServer({ deps, uiDistPath });

  const port = Number(env.PORT);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info({ port, agents: bindings.size() }, "paperclip-chat-gateway listening");
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exitCode = 1;
});
