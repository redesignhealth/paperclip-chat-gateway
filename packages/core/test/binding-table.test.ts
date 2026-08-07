import { describe, expect, it } from "vitest";
import { BindingTable, DuplicateAgentBindingError, DuplicateEmployeeBindingError } from "../src/binding-table.js";

describe("BindingTable", () => {
  const table = BindingTable.fromConfig({
    bindings: [
      { employeeId: "emp-alice", agentId: "agent-alice-cfo" },
      { employeeId: "emp-bob", agentId: "agent-bob-eng" },
    ],
  });

  it("resolves the bound agent for a known employee", () => {
    expect(table.resolveAgentFor("emp-alice")).toBe("agent-alice-cfo");
    expect(table.resolveAgentFor("emp-bob")).toBe("agent-bob-eng");
  });

  it("denies by default for an unknown employee", () => {
    expect(table.resolveAgentFor("emp-mallory")).toBeNull();
  });

  // Property-style table: no employee may ever resolve to an agent that
  // isn't explicitly theirs. This is the single most important invariant
  // in the whole codebase.
  const employees = ["emp-alice", "emp-bob", "emp-mallory", "emp-unknown"];
  const agents = ["agent-alice-cfo", "agent-bob-eng", "agent-other", "agent-does-not-exist"];
  const expected: Record<string, string> = {
    "emp-alice": "agent-alice-cfo",
    "emp-bob": "agent-bob-eng",
  };

  for (const employeeId of employees) {
    for (const agentId of agents) {
      const shouldBeAuthorized = expected[employeeId] === agentId;
      it(`isAuthorized(${employeeId}, ${agentId}) === ${shouldBeAuthorized}`, () => {
        expect(table.isAuthorized(employeeId, agentId)).toBe(shouldBeAuthorized);
      });
    }
  }

  it("rejects config with duplicate employee bindings at load time", () => {
    expect(() =>
      BindingTable.fromConfig({
        bindings: [
          { employeeId: "emp-alice", agentId: "agent-1" },
          { employeeId: "emp-alice", agentId: "agent-2" },
        ],
      }),
    ).toThrow(DuplicateEmployeeBindingError);
  });

  it("rejects config with duplicate agent bindings at load time (1:1 must hold in both directions)", () => {
    expect(() =>
      BindingTable.fromConfig({
        bindings: [
          { employeeId: "emp-alice", agentId: "agent-shared" },
          { employeeId: "emp-bob", agentId: "agent-shared" },
        ],
      }),
    ).toThrow(DuplicateAgentBindingError);
  });

  it("rejects malformed config shape", () => {
    expect(() => BindingTable.fromConfig({ bindings: [{ employeeId: "x" }] })).toThrow();
    expect(() => BindingTable.fromConfig({ notBindings: [] })).toThrow();
    expect(() => BindingTable.fromConfig(null)).toThrow();
  });

  it("empty table denies everything", () => {
    const empty = BindingTable.empty();
    expect(empty.size()).toBe(0);
    expect(empty.resolveAgentFor("emp-alice")).toBeNull();
    expect(empty.isAuthorized("emp-alice", "agent-alice-cfo")).toBe(false);
  });

  describe("resolveEmployeeFor — reverse lookup (agent -> employee)", () => {
    it("resolves the bound employee for a known agentId", () => {
      expect(table.resolveEmployeeFor("agent-alice-cfo")).toBe("emp-alice");
      expect(table.resolveEmployeeFor("agent-bob-eng")).toBe("emp-bob");
    });

    it("denies by default for an unknown agentId", () => {
      expect(table.resolveEmployeeFor("agent-does-not-exist")).toBeNull();
    });

    it("is a true inverse of resolveAgentFor for every bound pair", () => {
      for (const [employeeId, agentId] of [
        ["emp-alice", "agent-alice-cfo"],
        ["emp-bob", "agent-bob-eng"],
      ] as const) {
        expect(table.resolveAgentFor(employeeId)).toBe(agentId);
        expect(table.resolveEmployeeFor(agentId)).toBe(employeeId);
      }
    });

    it("empty table denies every reverse lookup too", () => {
      const empty = BindingTable.empty();
      expect(empty.resolveEmployeeFor("agent-alice-cfo")).toBeNull();
    });

    it("an ambiguous agent binding (two employees, one agent) is rejected at load time, so reverse lookup can never be ambiguous", () => {
      expect(() =>
        BindingTable.fromConfig({
          bindings: [
            { employeeId: "emp-alice", agentId: "agent-shared" },
            { employeeId: "emp-bob", agentId: "agent-shared" },
          ],
        }),
      ).toThrow(DuplicateAgentBindingError);
    });
  });
});
