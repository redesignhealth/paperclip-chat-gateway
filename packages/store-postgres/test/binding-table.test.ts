import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { AdminStore } from "../src/admin.js";
import { DbBindingTable } from "../src/binding-table.js";
import { startTestDb, type TestDb } from "./testdb.js";

describe("DbBindingTable (real Postgres via testcontainers)", () => {
  let db: TestDb;
  let admin: AdminStore;
  let bindings: DbBindingTable;

  beforeAll(async () => {
    db = await startTestDb();
    admin = new AdminStore(db.pool, randomBytes(32));
    bindings = new DbBindingTable(db.pool);
  }, 120_000);

  afterAll(async () => {
    await db.close();
  }, 60_000);

  beforeEach(async () => {
    // Full reset between tests so each test's grants/agents/employees don't
    // leak into the next.
    await db.pool.query("TRUNCATE agent_grants, agent_credentials, agents, employees RESTART IDENTITY CASCADE");
  });

  async function seedEmployeeAgentGrant(employeeId: string, agentId: string) {
    await admin.registerEmployee({ employeeId, email: `${employeeId}@example.com` });
    await admin.registerAgent({ agentId, apiKey: "pk_test_key" });
    await admin.grantAccess({ employeeId, agentId, grantedBy: "admin@example.com" });
  }

  it("resolves the bound agent for a known, actively-granted employee", async () => {
    await seedEmployeeAgentGrant("emp-alice", "agent-alice");
    expect(await bindings.resolveAgentFor("emp-alice")).toBe("agent-alice");
    expect(await bindings.resolveEmployeeFor("agent-alice")).toBe("emp-alice");
    expect(await bindings.isAuthorized("emp-alice", "agent-alice")).toBe(true);
  });

  it("denies by default: unknown employee resolves to null", async () => {
    expect(await bindings.resolveAgentFor("emp-does-not-exist")).toBeNull();
  });

  it("denies by default: unknown agent resolves to null", async () => {
    expect(await bindings.resolveEmployeeFor("agent-does-not-exist")).toBeNull();
  });

  it("denies by default: a revoked grant no longer authorizes access", async () => {
    await seedEmployeeAgentGrant("emp-bob", "agent-bob");
    expect(await bindings.resolveAgentFor("emp-bob")).toBe("agent-bob");

    const revoked = await admin.revokeAccess({ employeeId: "emp-bob", agentId: "agent-bob" });
    expect(revoked).toBe(true);

    expect(await bindings.resolveAgentFor("emp-bob")).toBeNull();
    expect(await bindings.resolveEmployeeFor("agent-bob")).toBeNull();
    expect(await bindings.isAuthorized("emp-bob", "agent-bob")).toBe(false);
  });

  it("denies by default: grant to a different agent does not authorize the queried agent", async () => {
    await seedEmployeeAgentGrant("emp-carol", "agent-carol");
    await admin.registerAgent({ agentId: "agent-other", apiKey: "pk_other" });

    expect(await bindings.isAuthorized("emp-carol", "agent-other")).toBe(false);
    expect(await bindings.resolveAgentFor("emp-carol")).toBe("agent-carol");
    expect(await bindings.resolveAgentFor("emp-carol")).not.toBe("agent-other");
  });

  it("revocation leaves the row present with revoked_at set, not deleted", async () => {
    await seedEmployeeAgentGrant("emp-dave", "agent-dave");
    await admin.revokeAccess({ employeeId: "emp-dave", agentId: "agent-dave" });

    const { rows } = await db.pool.query<{ employee_id: string; agent_id: string; revoked_at: Date | null }>(
      "SELECT employee_id, agent_id, revoked_at FROM agent_grants WHERE employee_id = $1 AND agent_id = $2",
      ["emp-dave", "agent-dave"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).not.toBeNull();
    expect(rows[0]!.revoked_at).toBeInstanceOf(Date);
  });
});
