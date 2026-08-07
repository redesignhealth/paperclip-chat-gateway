import type {
  AgentCredentialStore,
  AgentTokenConfig,
  PaperclipClient,
  SchedulerClient,
  SessionStore,
} from "@paperclip-chat-gateway/core";
import type { OidcAdapter } from "@paperclip-chat-gateway/auth-oidc";

/**
 * Structurally identical to `core.BindingTable`'s public surface
 * (`resolveAgentFor`/`resolveEmployeeFor`/`isAuthorized`, same
 * deny-by-default semantics — see that class's header comment) but
 * `Promise`-returning. `core.BindingTable` is not modified: a DB-backed
 * binding table (see `@paperclip-chat-gateway/store-postgres`'s
 * `DbBindingTable`) is inherently asynchronous, so this is the one
 * unavoidable interface widening this feature required. `core.BindingTable`
 * already satisfies this interface structurally — `await`ing an
 * already-resolved synchronous value is a no-op — so the existing file/env
 * composition root code needs no changes beyond adding `await` at call
 * sites (see routes/chat.ts, routes/agent.ts).
 */
export interface BindingResolver {
  resolveAgentFor(employeeId: string): Promise<string | null> | string | null;
  resolveEmployeeFor(agentId: string): Promise<string | null> | string | null;
  isAuthorized(employeeId: string, agentId: string): Promise<boolean> | boolean;
}

/**
 * Structural mirror of `@paperclip-chat-gateway/store-postgres`'s
 * `AdminStore` public surface — transport-web depends only on this shape,
 * not on the store-postgres package itself, keeping the same
 * "transport-web declares interfaces, apps/gateway wires concrete
 * implementations" boundary used everywhere else in this file.
 */
export interface AdminBackend {
  registerAgent(params: { agentId: string; apiKey: string; kind?: "personal" | "shared" }): Promise<void>;
  listAgents(): Promise<
    Array<{ agentId: string; kind: "personal" | "shared"; hasCredential: boolean; createdAt: Date }>
  >;
  grantAccess(params: {
    employeeId: string;
    agentId: string;
    grantedBy: string;
    role?: "owner" | "member";
  }): Promise<void>;
  revokeAccess(params: { employeeId: string; agentId: string }): Promise<boolean>;
}

/**
 * Everything the fastify server needs, injected by the composition root
 * (apps/gateway). transport-web owns HTTP/session-cookie concerns only —
 * it has no idea how any of these were constructed.
 */
export interface GatewayDeps {
  oidc: OidcAdapter;
  bindings: BindingResolver;
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
  /**
   * Admin write backend for the `/api/admin/*` routes (register an agent +
   * its already-claimed key, list agents, grant/revoke a person's access).
   * OPT-IN, same pattern as `agentTokenConfig`/`schedulerClient`: when
   * `undefined` (e.g. the file/env store is active, with nothing to
   * administer via API), `registerAdminRoutes` does not register any
   * `/api/admin/*` route at all.
   */
  admin?: AdminBackend;
  /**
   * Fail-closed admin allowlist check, matched case-insensitively against
   * the caller's verified email (see `GATEWAY_ADMIN_EMAILS`). MUST return
   * `false` for every email when the allowlist is unset/empty — "nobody is
   * admin" is the only safe default, never "everybody is admin."
   */
  isAdminEmail(email: string): boolean;
}
