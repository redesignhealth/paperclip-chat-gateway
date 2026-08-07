import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayConfigError, loadGatewayConfigFile, parseTrustProxy } from "../src/config.js";

describe("loadGatewayConfigFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pcg-gateway-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(contents: unknown): Promise<string> {
    const filePath = path.join(dir, "gateway.json");
    await writeFile(filePath, JSON.stringify(contents));
    return filePath;
  }

  it("loads a valid config", async () => {
    const filePath = await writeConfig({
      employees: [{ employeeId: "emp-alice", email: "alice@example.com" }],
      bindings: [{ employeeId: "emp-alice", agentId: "agent-alice-cfo" }],
    });
    const config = await loadGatewayConfigFile(filePath);
    expect(config.employees).toHaveLength(1);
  });

  it("fails closed at load time when a binding references an employeeId not in the roster", async () => {
    const filePath = await writeConfig({
      employees: [{ employeeId: "emp-alice", email: "alice@example.com" }],
      bindings: [{ employeeId: "emp-bob-typo", agentId: "agent-alice-cfo" }],
    });
    await expect(loadGatewayConfigFile(filePath)).rejects.toThrow(GatewayConfigError);
  });

  it("rejects a file that isn't valid JSON with a clear error instead of an unhandled SyntaxError", async () => {
    const filePath = path.join(dir, "gateway.json");
    await writeFile(filePath, "{ not valid json");
    await expect(loadGatewayConfigFile(filePath)).rejects.toThrow(GatewayConfigError);
  });

  it("rejects a missing file with a clear error", async () => {
    await expect(loadGatewayConfigFile(path.join(dir, "does-not-exist.json"))).rejects.toThrow(GatewayConfigError);
  });
});

describe("parseTrustProxy", () => {
  it("returns undefined for unset/empty values (defaults to not trusting forwarded headers)", () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy("")).toBeUndefined();
  });

  it("parses boolean-ish strings", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("parses a bare integer as a hop count", () => {
    expect(parseTrustProxy("2")).toBe(2);
  });

  it("parses a single IP/CIDR as a string", () => {
    expect(parseTrustProxy("127.0.0.1")).toBe("127.0.0.1");
  });

  it("parses a comma-separated list as an array", () => {
    expect(parseTrustProxy("10.0.0.1, 10.0.0.2")).toEqual(["10.0.0.1", "10.0.0.2"]);
  });
});
