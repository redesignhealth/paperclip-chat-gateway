import type {
  AgentCredentialStore,
  AgentTokenConfig,
  BindingTable,
  PaperclipClient,
  SchedulerClient,
  SessionStore,
} from "@paperclip-chat-gateway/core";
import type { OidcAdapter } from "@paperclip-chat-gateway/auth-oidc";

/**
 * Everything the fastify server needs, injected by the composition root
 * (apps/gateway). transport-web owns HTTP/session-cookie concerns only —
 * it has no idea how any of these were constructed.
 */
export interface GatewayDeps {
  oidc: OidcAdapter;
  bindings: BindingTable;
  credentials: AgentCredentialStore;
  sessions: SessionStore;
  /** Builds a PaperclipClient scoped to one agent's credential. */
  paperclipClientFor(agentId: string, apiKey: string): PaperclipClient;
  paperclipApiBaseUrl: string;
  /** Cookie signing secret; also used to sign the short-lived OIDC state cookie. */
  cookieSecret: string;
  /** Resolves verified OIDC claims to a gateway employee id, or null if unknown. */
  resolveEmployeeId(claims: { subject: string; email?: string }): Promise<string | null>;
  /**
   * Verification config for inbound Paperclip agent run tokens (see
   * `packages/core/src/agent-token.ts`). Used by the agent-facing broker
   * route (`/api/agent/scheduler`) — the reverse direction of every other
   * route in this package, which authenticate a human and reach out to
   * Paperclip.
   *
   * OPT-IN: the agent-facing broker is a whole separate feature from the
   * rest of this gateway. When this is `undefined`, `registerAgentRoutes`
   * does not register `/api/agent/scheduler` at all, and every other route
   * in this package works exactly as if the agent broker didn't exist.
   */
  agentTokenConfig?: AgentTokenConfig;
  /** Downstream scheduler client the broker route forwards resolved-identity calls to. Only used when `agentTokenConfig` is set. */
  schedulerClient?: SchedulerClient;
}
