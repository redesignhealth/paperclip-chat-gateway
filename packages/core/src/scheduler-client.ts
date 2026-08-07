/**
 * SchedulerClient is the downstream counterpart of PaperclipClient: it's the
 * ONLY interface the agent-facing broker route talks to when forwarding a
 * verified agent call to the external scheduler service. Kept behind an
 * interface for the same reason PaperclipClient is — the scheduler is
 * swappable and testable without the broker route knowing anything about
 * its real transport.
 *
 * Deliberately, the scheduler never receives the HS256 secret this gateway
 * uses to verify agent run tokens (see agent-token.ts / README "Trust
 * model"): the scheduler trusts the gateway's resolved `employeeId`, not a
 * token it could itself misverify or leak. Keeping that secret out of the
 * downstream service is the whole point of brokering through this gateway
 * instead of handing agents a way to call the scheduler directly.
 */

import { NotImplementedError } from "./paperclip-client.js";

export interface SchedulerForwardInput {
  /** Resolved by BindingTable.resolveEmployeeFor — never client-supplied. */
  employeeId: string;
  /** The verified agent identity (JWT `sub`) that made this call. */
  agentId: string;
  /** The verified run identity (JWT `run_id`) that made this call. */
  runId: string;
  /** Caller-specified action name; scheduler-defined vocabulary, not gateway-defined. */
  action: string;
  payload?: unknown;
}

export interface SchedulerClient {
  forward(input: SchedulerForwardInput): Promise<unknown>;
}

export interface HttpSchedulerClientOptions {
  /** Base URL of the downstream scheduler service. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * Real (HTTP) scheduler client scaffold. `forward` deliberately throws
 * `NotImplementedError` rather than guessing at a request shape: the
 * scheduler's actual API (endpoint path, request/response schema, its own
 * auth) is not known from source and needs a live instance to pin down. See
 * the README's "Open transport question" — wire the real request here once
 * that's answered, following the same "one file owns the whole downstream
 * HTTP surface, validated with zod" pattern as `HttpPaperclipClient`.
 */
export class HttpSchedulerClient implements SchedulerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpSchedulerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async forward(input: SchedulerForwardInput): Promise<unknown> {
    // `this.fetchImpl` / `this.options.baseUrl` are threaded through so a
    // real implementation is a small, local change once the scheduler's API
    // is known — not a signature change to this class or its callers.
    void this.fetchImpl;
    throw new NotImplementedError(
      `HttpSchedulerClient.forward(action="${input.action}") is not implemented: the downstream ` +
        `scheduler's real request/response shape and auth are unresolved against a live instance ` +
        `(configured baseUrl: "${this.options.baseUrl}"). See README's "Open transport question."`,
    );
  }
}

/** Default when no downstream base URL is configured at all. */
export class StubSchedulerClient implements SchedulerClient {
  async forward(input: SchedulerForwardInput): Promise<unknown> {
    throw new NotImplementedError(
      `No downstream scheduler is configured (SCHEDULER_BASE_URL unset). Forwarded action was "${input.action}".`,
    );
  }
}
