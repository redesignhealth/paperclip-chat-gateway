import type { AgentCredentialStore, BindingTable, PaperclipClient, SessionStore } from "@paperclip-chat-gateway/core";
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
}
