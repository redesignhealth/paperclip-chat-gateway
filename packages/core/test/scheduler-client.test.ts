import { describe, expect, it } from "vitest";
import { HttpSchedulerClient, NotImplementedError, StubSchedulerClient } from "../src/index.js";

describe("StubSchedulerClient", () => {
  it("throws NotImplementedError naming the attempted action when no scheduler is configured", async () => {
    const client = new StubSchedulerClient();
    await expect(
      client.forward({ employeeId: "emp-alice", agentId: "agent-alice-cfo", runId: "run-1", action: "reschedule" }),
    ).rejects.toThrow(NotImplementedError);
    await expect(
      client.forward({ employeeId: "emp-alice", agentId: "agent-alice-cfo", runId: "run-1", action: "reschedule" }),
    ).rejects.toThrow(/reschedule/);
  });
});

describe("HttpSchedulerClient", () => {
  it("throws NotImplementedError naming the action and configured baseUrl", async () => {
    const client = new HttpSchedulerClient({ baseUrl: "https://scheduler.example.com" });
    await expect(
      client.forward({ employeeId: "emp-alice", agentId: "agent-alice-cfo", runId: "run-1", action: "reschedule" }),
    ).rejects.toThrow(NotImplementedError);
    await expect(
      client.forward({ employeeId: "emp-alice", agentId: "agent-alice-cfo", runId: "run-1", action: "reschedule" }),
    ).rejects.toThrow(/scheduler\.example\.com/);
  });
});
