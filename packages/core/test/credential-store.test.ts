import { describe, expect, it } from "vitest";
import { EnvAgentCredentialStore, FileAgentCredentialStore } from "../src/credential-store.js";

describe("EnvAgentCredentialStore.envVarNameFor", () => {
  it("is injective: no two distinct agentIds it's ever plausible to configure map to the same env var", () => {
    // Every one of these was chosen because a naive "collapse non-alphanumerics
    // to `_`" scheme (the pre-fix behavior) collapses at least two of them onto
    // the same env var name — which would hand one agent's credential to a
    // lookup for a completely different agent.
    const agentIds = [
      "agent-alice",
      "agent.alice",
      "agent_alice",
      "agent alice",
      "agent--alice",
      "agent__alice",
      "agent_2dalice", // deliberately shaped to look like an already-encoded hyphen
      "agent-bob",
      "agent.bob",
      "",
      "agent",
    ];

    const names = agentIds.map((id) => EnvAgentCredentialStore.envVarNameFor(id));
    expect(new Set(names).size).toBe(agentIds.length);
  });

  it("passes alphanumeric agentIds through unchanged", () => {
    expect(EnvAgentCredentialStore.envVarNameFor("agentalice123")).toBe("PAPERCLIP_AGENT_KEY__agentalice123");
  });
});

describe("EnvAgentCredentialStore", () => {
  it("returns the key for the exact agent it was set for", async () => {
    const env = {
      [EnvAgentCredentialStore.envVarNameFor("agent-alice")]: "key-for-alice",
      [EnvAgentCredentialStore.envVarNameFor("agent-bob")]: "key-for-bob",
    } as NodeJS.ProcessEnv;
    const store = new EnvAgentCredentialStore(env);

    await expect(store.getKeyFor("agent-alice")).resolves.toBe("key-for-alice");
    await expect(store.getKeyFor("agent-bob")).resolves.toBe("key-for-bob");
  });

  it("never leaks one agent's key to a lookup for a different agentId, even one that collided under the old scheme", async () => {
    const env = {
      [EnvAgentCredentialStore.envVarNameFor("agent-alice")]: "key-for-alice",
    } as NodeJS.ProcessEnv;
    const store = new EnvAgentCredentialStore(env);

    await expect(store.getKeyFor("agent-mallory")).resolves.toBeNull();
    // Would have collided with "agent-alice" under the pre-fix normalization.
    await expect(store.getKeyFor("agent.alice")).resolves.toBeNull();
    await expect(store.getKeyFor("agent_alice")).resolves.toBeNull();
  });

  it("returns null, not empty string, for an unset key", async () => {
    const store = new EnvAgentCredentialStore({} as NodeJS.ProcessEnv);
    await expect(store.getKeyFor("agent-anything")).resolves.toBeNull();
  });
});

describe("FileAgentCredentialStore", () => {
  it("scopes lookups to the exact agent id in the file", async () => {
    const fakeFile = JSON.stringify({ "agent-alice": "key-a", "agent-bob": "key-b" });
    const store = await FileAgentCredentialStore.load("fake-path.json", async () => fakeFile);

    await expect(store.getKeyFor("agent-alice")).resolves.toBe("key-a");
    await expect(store.getKeyFor("agent-bob")).resolves.toBe("key-b");
    await expect(store.getKeyFor("agent-carol")).resolves.toBeNull();
  });

  it("rejects a malformed credential file instead of silently returning nothing", async () => {
    await expect(FileAgentCredentialStore.load("bad.json", async () => "not json")).rejects.toThrow();
    await expect(FileAgentCredentialStore.load("bad.json", async () => JSON.stringify([1, 2, 3]))).rejects.toThrow();
    await expect(
      FileAgentCredentialStore.load("bad.json", async () => JSON.stringify({ "agent-a": 12345 })),
    ).rejects.toThrow();
  });

  it("reload() picks up rotated credentials without leaking the old ones", async () => {
    let contents = JSON.stringify({ "agent-alice": "old-key" });
    const store = await FileAgentCredentialStore.load("rotating.json", async () => contents);
    await expect(store.getKeyFor("agent-alice")).resolves.toBe("old-key");

    contents = JSON.stringify({ "agent-alice": "new-key" });
    await store.reload();
    await expect(store.getKeyFor("agent-alice")).resolves.toBe("new-key");
  });
});
