import {
  BindingTable,
  ConfigIdentityResolver,
  EnvAgentCredentialStore,
  FileAgentCredentialStore,
  HttpPaperclipClient,
  HttpSchedulerClient,
  InMemorySessionStore,
  StubSchedulerClient,
  type AgentCredentialStore,
  type AgentTokenConfig,
  type SchedulerClient,
} from "@paperclip-chat-gateway/core";
import { loadOidcConfigFromEnv, OidcAdapter, RealOidcPort } from "@paperclip-chat-gateway/auth-oidc";
import { buildServer, type GatewayDeps } from "@paperclip-chat-gateway/transport-web";
import {
  isAgentBrokerEnabled,
  loadAppEnv,
  loadGatewayConfigFile,
  parseBooleanEnv,
  parseCompanyIdAllowlist,
  parseRequireVerifiedEmailEnv,
  parseTrustProxy,
  toConfigEmployees,
} from "./config.js";
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
  const requireVerifiedEmail = parseRequireVerifiedEmailEnv(env.OIDC_REQUIRE_VERIFIED_EMAIL);
  const oidc = new OidcAdapter(
    oidcConfig,
    new RealOidcPort({
      issuerUrl: oidcConfig.issuerUrl,
      clientId: oidcConfig.clientId,
      clientSecret: oidcConfig.clientSecret,
      requireVerifiedEmail,
    }),
  );

  // The agent-facing identity broker is opt-in: absent AGENT_JWT_SECRET
  // means this deployment doesn't broker for any agents, and the gateway
  // starts normally with /api/agent/scheduler simply not registered (see
  // registerAgentRoutes). loadAppEnv() has already strictly validated every
  // AGENT_JWT_*/SCHEDULER_BASE_URL setting together when the secret IS set.
  const brokerEnabled = isAgentBrokerEnabled(env);
  const agentTokenConfig: AgentTokenConfig | undefined = brokerEnabled
    ? {
        secret: env.AGENT_JWT_SECRET!,
        expectedCompanyIds: parseCompanyIdAllowlist(env.AGENT_JWT_COMPANY_ID),
        instanceId: env.AGENT_JWT_INSTANCE_ID,
        issuer: env.AGENT_JWT_ISSUER,
        audience: env.AGENT_JWT_AUDIENCE,
        enableLegacyFallback: parseBooleanEnv(env.AGENT_JWT_ENABLE_LEGACY_FALLBACK),
        clockToleranceSeconds: env.AGENT_JWT_CLOCK_TOLERANCE_SECONDS
          ? Number(env.AGENT_JWT_CLOCK_TOLERANCE_SECONDS)
          : undefined,
        maxTokenAgeSeconds: env.AGENT_JWT_MAX_TOKEN_AGE_SECONDS
          ? Number(env.AGENT_JWT_MAX_TOKEN_AGE_SECONDS)
          : undefined,
      }
    : undefined;

  // Only wired to an HTTP client (which still throws NotImplementedError —
  // see HttpSchedulerClient) once a base URL is actually configured;
  // otherwise the broker route responds 501 via StubSchedulerClient rather
  // than this composition root guessing at an endpoint that doesn't exist.
  // Irrelevant when the broker itself is disabled, but harmless to build.
  const schedulerClient: SchedulerClient = env.SCHEDULER_BASE_URL
    ? new HttpSchedulerClient({ baseUrl: env.SCHEDULER_BASE_URL })
    : new StubSchedulerClient();

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
    agentTokenConfig,
    schedulerClient,
  };

  const uiDistPath = resolveUiDistPath({ override: env.UI_DIST_PATH });
  await assertUiDistExists(uiDistPath);

  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  const app = await buildServer({ deps, uiDistPath, trustProxy });

  const port = Number(env.PORT);
  await app.listen({ port, host: "0.0.0.0" });
  // Logged explicitly (not just implied by TRUST_PROXY being set) so a
  // misconfigured reverse-proxy deployment — e.g. OIDC redirects coming
  // back with the wrong scheme/host because forwarded headers aren't being
  // trusted — is diagnosable from the logs without having to go re-check
  // env vars by hand. See README's "Reverse proxies and TRUST_PROXY".
  app.log.info(
    { port, agents: bindings.size(), trustProxy: trustProxy ?? false, requireVerifiedEmail },
    "paperclip-chat-gateway listening",
  );
  // requireVerifiedEmail is a security-relevant setting (see
  // RealOidcPortOptions.requireVerifiedEmail and README's "Reverse proxies
  // and TRUST_PROXY" section) that defaults to strict/true — call out the
  // relaxed case explicitly so it can't be missed by only reading env vars.
  if (!requireVerifiedEmail) {
    app.log.warn(
      "OIDC_REQUIRE_VERIFIED_EMAIL=false — this gateway trusts whatever email address the identity " +
        "provider asserts, even without email_verified === true. Only acceptable when you fully control " +
        "the IdP and it is your sole identity source.",
    );
  }
  // Explicit, unmissable startup line for which trust-boundary mode this
  // deployment is in — the agent broker is opt-in (see AppEnv.AGENT_JWT_SECRET),
  // so an operator scanning logs should never have to infer this from the
  // absence of a route-registration log line alone.
  app.log.info(
    brokerEnabled
      ? { expectedCompanyIds: agentTokenConfig?.expectedCompanyIds }
      : {},
    brokerEnabled
      ? "agent identity broker ENABLED — /api/agent/scheduler is live"
      : "agent identity broker DISABLED (AGENT_JWT_SECRET not set) — /api/agent/scheduler is not registered",
  );
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exitCode = 1;
});
