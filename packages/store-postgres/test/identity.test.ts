import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DbIdentityResolver, normalizeEmail } from "../src/identity.js";
import { startTestDb, type TestDb } from "./testdb.js";

describe("DbIdentityResolver (real Postgres via testcontainers)", () => {
  let db: TestDb;
  let resolver: DbIdentityResolver;

  beforeAll(async () => {
    db = await startTestDb();
    resolver = new DbIdentityResolver(db.pool);
  }, 120_000);

  afterAll(async () => {
    await db.close();
  }, 60_000);

  beforeEach(async () => {
    await db.pool.query("TRUNCATE agent_grants, agent_credentials, agents, employees RESTART IDENTITY CASCADE");
  });

  it("resolves a known employee by verified email, case-insensitively", async () => {
    await db.pool.query("INSERT INTO employees (employee_id, email, name) VALUES ($1, $2, $3)", [
      "emp-alice",
      "alice@example.com",
      "Alice",
    ]);

    const result = await resolver.resolve({ subject: "sub-1", email: "Alice@Example.com" });
    expect(result).toEqual({ employeeId: "emp-alice", email: "alice@example.com", name: "Alice" });
  });

  it("denies by default for an unknown email", async () => {
    const result = await resolver.resolve({ subject: "sub-2", email: "mallory@example.com" });
    expect(result).toBeNull();
  });

  it("denies by default when no email claim is present", async () => {
    const result = await resolver.resolve({ subject: "sub-3" });
    expect(result).toBeNull();
  });

  it("normalizeEmail mirrors ConfigIdentityResolver's lowercase normalization", () => {
    expect(normalizeEmail("Alice@Example.COM")).toBe("alice@example.com");
  });
});
