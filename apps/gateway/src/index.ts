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
import { loadAppEnv, loadGatewayConfigFile, parseTrustProxy, toConfigEmployees } from "./config.js";
import { assertUiDistExists, resolveUiDistPath } from "./ui-dist.js";

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

  // Fail closed at boot, not at request time: a bound agentId with no
  // configured credential would otherwise surface as a confusing 503 on
  // whichever employee happens to message it first.
  const distinctAgentIds = [...new Set(gatewayConfig.bindings.map((b) => b.agentId))];
  const missingCredentialAgentIds: string[] = [];
  for (const agentId of distinctAgentIds) {
    const key = await credentials.getKeyFor(agentId);
    if (!key) missingCredentialAgentIds.push(agentId);
  }
  if (missingCredentialAgentIds.length > 0) {
    throw new Error(
      `No credential is configured for bound agent(s): ${missingCredentialAgentIds.join(", ")}. Configure ` +
        "PAPERCLIP_AGENT_KEY__<encoded agentId> (env store) or add them to the credential file (file store) " +
        "before starting.",
    );
  }

  // loadOidcConfigFromEnv re-validates a subset of the same env vars
  // appEnvSchema already validated; passing the already-loaded `env` object
  // (rather than raw `process.env`) at least ensures both validations see
  // the exact same values, instead of two independently-evolving schemas
  // that could silently diverge if `env` is ever transformed before this
  // point.
  const oidcConfig = loadOidcConfigFromEnv({ env: env as unknown as NodeJS.ProcessEnv });
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

  const uiDistPath = resolveUiDistPath({ override: env.UI_DIST_PATH });
  await assertUiDistExists(uiDistPath);

  const app = await buildServer({ deps, uiDistPath, trustProxy: parseTrustProxy(env.TRUST_PROXY) });

  const port = Number(env.PORT);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info({ port, agents: bindings.size() }, "paperclip-chat-gateway listening");
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exitCode = 1;
});
