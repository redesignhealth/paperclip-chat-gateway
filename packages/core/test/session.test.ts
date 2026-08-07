import { describe, expect, it } from "vitest";
import { InMemorySessionStore, sessionKeyFor } from "../src/session.js";

describe("sessionKeyFor", () => {
  it("is stable for the same pair", () => {
    expect(sessionKeyFor("emp-alice", "agent-alice-cfo")).toBe(sessionKeyFor("emp-alice", "agent-alice-cfo"));
  });

  it("never collides two distinct (employeeId, agentId) pairs, even when ids embed the delimiter text", () => {
    // Before percent-encoding, these adversarial pairs would have produced
    // the identical naively-interpolated string "employee:a:agent:b".
    const pairs: Array<[string, string]> = [
      ["a", "b"],
      ["a:agent", "b"],
      ["a", "agent:b"],
      ["a:agent:", "b"],
      ["employee:a", "agent:agent:b"],
    ];

    const keys = pairs.map(([employeeId, agentId]) => sessionKeyFor(employeeId, agentId));
    expect(new Set(keys).size).toBe(pairs.length);
  });
});

describe("InMemorySessionStore", () => {
  it("keeps distinct sessions for pairs that would collide under naive string interpolation", async () => {
    const store = new InMemorySessionStore();
    await store.put({ employeeId: "a:agent", agentId: "b", issueId: "issue-1" });
    await store.put({ employeeId: "a", agentId: "agent:b", issueId: "issue-2" });

    await expect(store.get("a:agent", "b")).resolves.toEqual({ employeeId: "a:agent", agentId: "b", issueId: "issue-1" });
    await expect(store.get("a", "agent:b")).resolves.toEqual({ employeeId: "a", agentId: "agent:b", issueId: "issue-2" });
  });
});
