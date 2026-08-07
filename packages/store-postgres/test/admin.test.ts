import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { AdminStore, OneOwnerPerAgentError, OnePersonalAgentPerEmployeeError } from "../src/admin.js";
import { DbAgentCredentialStore } from "../src/credential-store.js";
import { startTestDb, type TestDb } from "./testdb.js";

describe("AdminStore (real Postgres via testcontainers)", () => {
  let db: TestDb;
  let admin: AdminStore;
  const encryptionKey = randomBytes(32);

  beforeAll(async () => {
    db = await startTestDb();
    admin = new AdminStore(db.pool, encryptionKey);
  }, 120_000);

  afterAll(async () => {
    await db.close();
  }, 60_000);

  beforeEach(async () => {
    await db.pool.query("TRUNCATE agent_grants, agent_credentials, agents, employees RESTART IDENTITY CASCADE");
  });

  describe("MVP 1:1 owner-per-agent rule (application code, not schema)", () => {
    it("rejects granting a second owner to an agent that already has one", async () => {
      await admin.registerEmployee({ employeeId: "emp-alice", email: "alice@example.com" });
      await admin.registerEmployee({ employeeId: "emp-bob", email: "bob@example.com" });
      await admin.registerAgent({ agentId: "agent-shared", apiKey: "pk_shared" });

      await admin.grantAccess({ employeeId: "emp-alice", agentId: "agent-shared", grantedBy: "admin@example.com" });

      await expect(
        admin.grantAccess({ employeeId: "emp-bob", agentId: "agent-shared", grantedBy: "admin@example.com" }),
      ).rejects.toThrow(OneOwnerPerAgentError);
    });

    it("allows re-granting the SAME employee as owner (idempotent-ish, not a conflict)", async () => {
      await admin.registerEmployee({ employeeId: "emp-alice", email: "alice@example.com" });
      await admin.registerAgent({ agentId: "agent-alice", apiKey: "pk_alice" });
      await admin.grantAccess({ employeeId: "emp-alice", agentId: "agent-alice", grantedBy: "admin@example.com" });

      await expect(
        admin.grantAccess({ employeeId: "emp-alice", agentId: "agent-alice", grantedBy: "admin@example.com" }),
      ).resolves.toBeUndefined();
    });

    it("allows granting a new owner once the previous owner's grant was revoked", async () => {
      await admin.registerEmployee({ employeeId: "emp-alice", email: "alice@example.com" });
      await admin.registerEmployee({ employeeId: "emp-bob", email: "bob@example.com" });
      await admin.registerAgent({ agentId: "agent-x", apiKey: "pk_x" });

      await admin.grantAccess({ employeeId: "emp-alice", agentId: "agent-x", grantedBy: "admin@example.com" });
      await admin.revokeAccess({ employeeId: "emp-alice", agentId: "agent-x" });

      await expect(
        admin.grantAccess({ employeeId: "emp-bob", agentId: "agent-x", grantedBy: "admin@example.com" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("MVP one-personal-agent-per-employee rule (application code, not schema)", () => {
    it("rejects granting a second personal agent to an employee who already owns one", async () => {
      await admin.registerEmployee({ employeeId: "emp-alice", email: "alice@example.com" });
      await admin.registerAgent({ agentId: "agent-1", apiKey: "pk_1", kind: "personal" });
      await admin.registerAgent({ agentId: "agent-2", apiKey: "pk_2", kind: "personal" });

      await admin.grantAccess({ employeeId: "emp-alice", agentId: "agent-1", grantedBy: "admin@example.com" });

      await expect(
        admin.grantAccess({ employeeId: "emp-alice", agentId: "agent-2", grantedBy: "admin@example.com" }),
      ).rejects.toThrow(OnePersonalAgentPerEmployeeError);
    });
  });

  describe("revocation", () => {
    it("leaves the grant row present with revoked_at set (not a hard delete)", async () => {
      await admin.registerEmployee({ employeeId: "emp-alice", email: "alice@example.com" });
      await admin.registerAgent({ agentId: "agent-alice", apiKey: "pk_alice" });
      await admin.grantAccess({ employeeId: "emp-alice", agentId: "agent-alice", grantedBy: "admin@example.com" });

      const revoked = await admin.revokeAccess({ employeeId: "emp-alice", agentId: "agent-alice" });
      expect(revoked).toBe(true);

      const { rows } = await db.pool.query(
        "SELECT revoked_at FROM agent_grants WHERE employee_id = $1 AND agent_id = $2",
        ["emp-alice", "agent-alice"],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].revoked_at).not.toBeNull();
    });

    it("revoking a grant that doesn't exist returns false", async () => {
      const revoked = await admin.revokeAccess({ employeeId: "emp-nobody", agentId: "agent-nobody" });
      expect(revoked).toBe(false);
    });
  });

  describe("listAgents never exposes credential material", () => {
    it("only reports hasCredential, never the key", async () => {
      await admin.registerAgent({ agentId: "agent-secret", apiKey: "pk_super_secret_value" });
      const agents = await admin.listAgents();
      const summary = agents.find((a) => a.agentId === "agent-secret");
      expect(summary?.hasCredential).toBe(true);
      expect(JSON.stringify(agents)).not.toContain("pk_super_secret_value");
    });
  });

  describe("credential round-trip through encryption, with a log-leak guard", () => {
    it("never surfaces the plaintext key in captured logs across register + retrieve", async () => {
      const plaintextKey = "pk_live_do_not_leak_this_value_12345";
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      try {
        await admin.registerAgent({ agentId: "agent-roundtrip", apiKey: plaintextKey });
        const credentialStore = new DbAgentCredentialStore(db.pool, encryptionKey);
        const retrieved = await credentialStore.getKeyFor("agent-roundtrip");
        expect(retrieved).toBe(plaintextKey);

        const { rows } = await db.pool.query<{ encrypted_key: string }>(
          "SELECT encrypted_key FROM agent_credentials WHERE agent_id = $1",
          ["agent-roundtrip"],
        );
        expect(rows[0]!.encrypted_key).not.toContain(plaintextKey);

        const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...infoSpy.mock.calls]
          .flat()
          .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
          .join("\n");
        expect(allLoggedText).not.toContain(plaintextKey);
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        infoSpy.mockRestore();
      }
    });
  });
});
