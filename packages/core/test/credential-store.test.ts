import { describe, expect, it } from "vitest";
import { EnvAgentCredentialStore, FileAgentCredentialStore, UnknownAgentCredentialError } from "../src/credential-store.js";

describe("EnvAgentCredentialStore", () => {
  it("returns the key for the exact agent it was set for", async () => {
    const store = new EnvAgentCredentialStore({
      PAPERCLIP_AGENT_KEY__agent_alice: "key-for-alice",
      PAPERCLIP_AGENT_KEY__agent_bob: "key-for-bob",
    } as NodeJS.ProcessEnv);

    await expect(store.getKeyFor("agent-alice")).resolves.toBe("key-for-alice");
    await expect(store.getKeyFor("agent-bob")).resolves.toBe("key-for-bob");
  });

  it("never leaks one agent's key when asked for a different, unconfigured agent", async () => {
    const store = new EnvAgentCredentialStore({
      PAPERCLIP_AGENT_KEY__agent_alice: "key-for-alice",
    } as NodeJS.ProcessEnv);

    await expect(store.getKeyFor("agent-mallory")).resolves.toBeNull();
    await expect(store.getKeyFor("agent_alice_evil_twin")).resolves.toBeNull();
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

describe("UnknownAgentCredentialError", () => {
  it("carries the agent id in its message for debuggability", () => {
    const error = new UnknownAgentCredentialError("agent-alice");
    expect(error.message).toContain("agent-alice");
  });
});
