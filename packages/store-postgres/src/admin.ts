import type { Pool, PoolClient } from "pg";
import { encryptAgentKey } from "./crypto.js";
import { normalizeEmail } from "./identity.js";

export class OneOwnerPerAgentError extends Error {
  constructor(agentId: string) {
    super(
      `Agent "${agentId}" already has an active owner. This is the MVP's application-level "exactly one ` +
        "owner per agent" +
        `" rule (see grantAccess in packages/store-postgres/src/admin.ts) — the schema itself permits ` +
        "multiple owner rows per agent so a future self-serve co-ownership feature needs no migration.",
    );
    this.name = "OneOwnerPerAgentError";
  }
}

export class OnePersonalAgentPerEmployeeError extends Error {
  constructor(employeeId: string, existingAgentId: string) {
    super(
      `Employee "${employeeId}" already owns personal agent "${existingAgentId}". This is the MVP's ` +
        "application-level \"one personal agent per person\" rule (see grantAccess in " +
        "packages/store-postgres/src/admin.ts) — the schema itself permits multiple grant rows per " +
        "employee so a future multi-agent-per-person feature needs no migration.",
    );
    this.name = "OnePersonalAgentPerEmployeeError";
  }
}

export class UnknownAgentError extends Error {
  constructor(agentId: string) {
    super(`No agent registered with id "${agentId}". Register it first via registerAgent.`);
    this.name = "UnknownAgentError";
  }
}

export class UnknownEmployeeError extends Error {
  constructor(employeeId: string) {
    super(`No employee registered with id "${employeeId}".`);
    this.name = "UnknownEmployeeError";
  }
}

export interface AgentSummary {
  agentId: string;
  kind: "personal" | "shared";
  hasCredential: boolean;
  createdAt: Date;
}

/**
 * Admin-facing application service backing the transport-web admin
 * endpoints. Every write here is the single place the MVP's "one owner per
 * agent" / "one personal agent per person" rules are enforced — see
 * `README.md` for why those rules live here and not as schema constraints.
 */
export class AdminStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: Buffer,
  ) {}

  /**
   * Registers a new agent and its already-claimed Paperclip API key
   * (claiming the key via the Paperclip CLI is a manual, out-of-scope
   * step — see README). The key is encrypted before it is written; the
   * plaintext never touches a log line or a returned value.
   */
  async registerAgent(params: { agentId: string; apiKey: string; kind?: "personal" | "shared" }): Promise<void> {
    const kind = params.kind ?? "personal";
    const encrypted = encryptAgentKey(params.apiKey, this.encryptionKey);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO agents (agent_id, kind) VALUES ($1, $2)", [params.agentId, kind]);
      await client.query("INSERT INTO agent_credentials (agent_id, encrypted_key) VALUES ($1, $2)", [
        params.agentId,
        encrypted,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAgents(): Promise<AgentSummary[]> {
    const { rows } = await this.pool.query<{
      agent_id: string;
      kind: "personal" | "shared";
      created_at: Date;
      has_credential: boolean;
    }>(
      `SELECT a.agent_id, a.kind, a.created_at, (c.agent_id IS NOT NULL) AS has_credential
       FROM agents a
       LEFT JOIN agent_credentials c ON c.agent_id = a.agent_id
       ORDER BY a.created_at ASC`,
    );
    // Deliberately excludes any key material — see AgentCredentialStore's
    // doc comment: a key must never be returned from any endpoint/response.
    return rows.map((r) => ({ agentId: r.agent_id, kind: r.kind, hasCredential: r.has_credential, createdAt: r.created_at }));
  }

  /**
   * Binds a person to an agent. Enforces the MVP 1:1 rule in application
   * code (NOT via a schema unique constraint — see README):
   *   - an agent may not have more than one active 'owner' grant
   *   - an employee may not own more than one active 'personal' agent
   * The underlying `agent_grants` table has no unique constraint on
   * `employee_id` and permits multiple rows per employee; a separate test
   * (`grants-schema-permits-multiple.test.ts`) proves this at the raw-SQL
   * layer, independent of this method's guard.
   */
  async grantAccess(params: {
    employeeId: string;
    agentId: string;
    grantedBy: string;
    role?: "owner" | "member";
  }): Promise<void> {
    const role = params.role ?? "owner";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const agent = await this.getAgentForUpdate(client, params.agentId);
      if (!agent) throw new UnknownAgentError(params.agentId);
      const employeeExists = await this.employeeExists(client, params.employeeId);
      if (!employeeExists) throw new UnknownEmployeeError(params.employeeId);

      if (role === "owner") {
        const { rows: existingOwnerRows } = await client.query<{ employee_id: string }>(
          "SELECT employee_id FROM agent_grants WHERE agent_id = $1 AND role = 'owner' AND revoked_at IS NULL",
          [params.agentId],
        );
        const existingOwner = existingOwnerRows[0];
        if (existingOwner && existingOwner.employee_id !== params.employeeId) {
          throw new OneOwnerPerAgentError(params.agentId);
        }

        if (agent.kind === "personal") {
          const { rows: existingPersonalRows } = await client.query<{ agent_id: string }>(
            `SELECT g.agent_id FROM agent_grants g
             JOIN agents a ON a.agent_id = g.agent_id
             WHERE g.employee_id = $1 AND g.role = 'owner' AND g.revoked_at IS NULL AND a.kind = 'personal'`,
            [params.employeeId],
          );
          const existingPersonal = existingPersonalRows[0];
          if (existingPersonal && existingPersonal.agent_id !== params.agentId) {
            throw new OnePersonalAgentPerEmployeeError(params.employeeId, existingPersonal.agent_id);
          }
        }
      }

      await client.query(
        "INSERT INTO agent_grants (employee_id, agent_id, role, granted_by) VALUES ($1, $2, $3, $4)",
        [params.employeeId, params.agentId, role, params.grantedBy],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Revokes an active grant by setting `revoked_at`. The row is NEVER deleted — see README on provenance. */
  async revokeAccess(params: { employeeId: string; agentId: string }): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "UPDATE agent_grants SET revoked_at = now() WHERE employee_id = $1 AND agent_id = $2 AND revoked_at IS NULL",
      [params.employeeId, params.agentId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Registers an employee by (already-verified) email, lowercased to match ConfigIdentityResolver's normalization. */
  async registerEmployee(params: { employeeId: string; email: string; name?: string }): Promise<void> {
    await this.pool.query("INSERT INTO employees (employee_id, email, name) VALUES ($1, $2, $3)", [
      params.employeeId,
      normalizeEmail(params.email),
      params.name ?? null,
    ]);
  }

  private async getAgentForUpdate(client: PoolClient, agentId: string): Promise<{ kind: "personal" | "shared" } | null> {
    const { rows } = await client.query<{ kind: "personal" | "shared" }>(
      "SELECT kind FROM agents WHERE agent_id = $1 FOR UPDATE",
      [agentId],
    );
    return rows[0] ?? null;
  }

  private async employeeExists(client: PoolClient, employeeId: string): Promise<boolean> {
    const { rows } = await client.query("SELECT 1 FROM employees WHERE employee_id = $1", [employeeId]);
    return rows.length > 0;
  }
}
