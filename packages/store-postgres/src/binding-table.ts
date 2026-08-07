import type { Pool } from "pg";

/**
 * `packages/core`'s `BindingTable` (the "security kernel" — see its own
 * header comment) exposes `resolveAgentFor`/`resolveEmployeeFor`/
 * `isAuthorized` as *synchronous* methods, because its v1 implementation is
 * an in-memory map built once from config at startup. A DB-backed
 * implementation cannot honor that exact signature — a lookup against
 * Postgres is inherently asynchronous — so this interface is the one
 * unavoidable contract change this feature introduces: it is
 * structurally identical to core's `BindingTable` (same method names, same
 * meaning, same deny-by-default semantics) but returns `Promise`s.
 *
 * `core.BindingTable` itself is NOT modified. Because every method here is
 * `Promise<T> | T`, `core.BindingTable`'s existing synchronous
 * implementation already satisfies this interface structurally with zero
 * changes — callers just need to `await` the result (which is a no-op for
 * an already-resolved value). See `packages/transport-web/src/types.ts`
 * for where `GatewayDeps.bindings` was widened from the concrete
 * `BindingTable` class to this interface, and the route files that now
 * `await` these calls.
 */
export interface BindingResolver {
  resolveAgentFor(employeeId: string): Promise<string | null> | string | null;
  resolveEmployeeFor(agentId: string): Promise<string | null> | string | null;
  isAuthorized(employeeId: string, agentId: string): Promise<boolean> | boolean;
}

interface ActiveGrantRow {
  employee_id: string;
  agent_id: string;
}

/**
 * Postgres-backed BindingResolver. The MVP 1:1 rule ("one owner per agent",
 * "one personal agent per person") is enforced on the *write* path (see
 * `admin.ts`'s `grantAccess`), not here — but this read path still treats
 * "more than one active grant matched" as a deny, not a guess, in case that
 * invariant is ever violated (e.g. a manual DB edit, or a future bug in the
 * write path). Deny-by-default survives exactly as `core.BindingTable`
 * documents: an employee/agent pair with no active grant row resolves to
 * `null`, never a fallback or wildcard.
 */
export class DbBindingTable implements BindingResolver {
  constructor(private readonly pool: Pool) {}

  async resolveAgentFor(employeeId: string): Promise<string | null> {
    const { rows } = await this.pool.query<ActiveGrantRow>(
      "SELECT employee_id, agent_id FROM agent_grants WHERE employee_id = $1 AND revoked_at IS NULL",
      [employeeId],
    );
    if (rows.length !== 1) return null;
    return rows[0]!.agent_id;
  }

  async resolveEmployeeFor(agentId: string): Promise<string | null> {
    const { rows } = await this.pool.query<ActiveGrantRow>(
      "SELECT employee_id, agent_id FROM agent_grants WHERE agent_id = $1 AND role = 'owner' AND revoked_at IS NULL",
      [agentId],
    );
    if (rows.length !== 1) return null;
    return rows[0]!.employee_id;
  }

  async isAuthorized(employeeId: string, agentId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT count(*) FROM agent_grants WHERE employee_id = $1 AND agent_id = $2 AND revoked_at IS NULL",
      [employeeId, agentId],
    );
    return Number(rows[0]!.count) > 0;
  }
}
