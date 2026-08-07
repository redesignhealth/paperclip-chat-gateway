import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./testdb.js";

/**
 * Proves the *schema itself* is future-proofed for many-to-many
 * employee<->agent grants, independent of the application-level 1:1 rule
 * tested in admin.test.ts. This test intentionally bypasses AdminStore and
 * inserts directly via raw SQL — if someone "tidies up" agent_grants by
 * adding a UNIQUE constraint on employee_id later, this test (not just the
 * app-level rule test) will fail, which is the point.
 */
describe("agent_grants schema permits multiple active grants for one employee", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await db.close();
  }, 60_000);

  beforeEach(async () => {
    await db.pool.query("TRUNCATE agent_grants, agent_credentials, agents, employees RESTART IDENTITY CASCADE");
  });

  it("accepts two active grant rows for the same employee, raw insert, no app-layer guard", async () => {
    await db.pool.query("INSERT INTO employees (employee_id, email) VALUES ($1, $2)", [
      "emp-multi",
      "emp-multi@example.com",
    ]);
    await db.pool.query("INSERT INTO agents (agent_id, kind) VALUES ($1, 'personal'), ($2, 'shared')", [
      "agent-one",
      "agent-two",
    ]);

    await db.pool.query(
      "INSERT INTO agent_grants (employee_id, agent_id, role, granted_by) VALUES ($1, $2, 'owner', $3)",
      ["emp-multi", "agent-one", "admin@example.com"],
    );
    await db.pool.query(
      "INSERT INTO agent_grants (employee_id, agent_id, role, granted_by) VALUES ($1, $2, 'member', $3)",
      ["emp-multi", "agent-two", "admin@example.com"],
    );

    const { rows } = await db.pool.query<{ agent_id: string }>(
      "SELECT agent_id FROM agent_grants WHERE employee_id = $1 AND revoked_at IS NULL ORDER BY agent_id",
      ["emp-multi"],
    );
    expect(rows.map((r) => r.agent_id)).toEqual(["agent-one", "agent-two"]);
  });

  it("has no unique constraint on employee_id alone (information_schema check)", async () => {
    const { rows } = await db.pool.query<{ constraint_type: string; column_name: string }>(
      `SELECT tc.constraint_type, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_name = 'agent_grants' AND tc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')`,
    );
    const uniqueOnEmployeeIdAlone = rows.some(
      (r) => r.constraint_type === "UNIQUE" && r.column_name === "employee_id",
    );
    expect(uniqueOnEmployeeIdAlone).toBe(false);
  });
});
