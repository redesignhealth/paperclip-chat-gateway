/**
 * AgentCredentialStore holds one narrowly-scoped Paperclip agent API key
 * per agent — never a shared board/company key. This mirrors the Hermes
 * gateway credential model: the gateway claims and holds a per-agent key,
 * and that key is the only thing that authenticates gateway->Paperclip
 * traffic for that agent (see `PAPERCLIP_API_KEY` in
 * paperclip's doc/HERMES_GATEWAY_ONBOARDING.md).
 *
 * A store implementation must never let a lookup for one agent leak or
 * fall back to another agent's key. Getting this wrong turns a
 * single-agent credential leak into an every-agent credential leak.
 */
export interface AgentCredentialStore {
  /** Returns the scoped Paperclip API key for this agent, or null if unset. */
  getKeyFor(agentId: string): Promise<string | null>;
}

/**
 * v1 implementation: keys come from environment variables, one per agent,
 * named `PAPERCLIP_AGENT_KEY__<encoded agentId>`.
 *
 * The encoding is an injective (collision-free) escape, not a blanket
 * "replace every non-alphanumeric character with `_`" normalization: every
 * alphanumeric character in `agentId` passes through unchanged, and every
 * other character — including a literal `_` — is escaped to `_XX` where
 * `XX` is its lowercase hex char code. Because alphanumeric characters
 * never start with `_`, the escaped form is unambiguously decodable, which
 * means the encoding is provably injective: two distinct agentIds can
 * never map to the same env var name. (A naive "collapse everything to
 * `_`" scheme let `agent-alice`, `agent.alice`, and `agent_alice` all
 * collide on `PAPERCLIP_AGENT_KEY__agent_alice` — i.e. it could hand one
 * agent's key to a lookup for a completely different agent.)
 */
export class EnvAgentCredentialStore implements AgentCredentialStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  static envVarNameFor(agentId: string): string {
    let encoded = "";
    for (const char of agentId) {
      if (/[a-zA-Z0-9]/.test(char)) {
        encoded += char;
      } else {
        encoded += `_${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
      }
    }
    return `PAPERCLIP_AGENT_KEY__${encoded}`;
  }

  async getKeyFor(agentId: string): Promise<string | null> {
    const value = this.env[EnvAgentCredentialStore.envVarNameFor(agentId)];
    return value && value.length > 0 ? value : null;
  }
}

/**
 * File-backed implementation for local dev / single-box deployments: a
 * JSON file mapping `agentId -> apiKey`. Loaded once at construction; call
 * `reload()` to pick up changes (e.g. after a credential rotation) without
 * restarting the process.
 */
export class FileAgentCredentialStore implements AgentCredentialStore {
  private keys: Map<string, string> = new Map();

  private constructor(
    private readonly filePath: string,
    private readonly readFile: (path: string) => Promise<string>,
  ) {}

  static async load(
    filePath: string,
    readFile: (path: string) => Promise<string> = defaultReadFile,
  ): Promise<FileAgentCredentialStore> {
    const store = new FileAgentCredentialStore(filePath, readFile);
    await store.reload();
    return store;
  }

  async reload(): Promise<void> {
    const contents = await this.readFile(this.filePath);
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Credential file "${this.filePath}" must contain a JSON object of agentId -> apiKey.`);
    }
    const next = new Map<string, string>();
    for (const [agentId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Credential file "${this.filePath}" has a non-string or empty key for agent "${agentId}".`);
      }
      next.set(agentId, value);
    }
    this.keys = next;
  }

  async getKeyFor(agentId: string): Promise<string | null> {
    return this.keys.get(agentId) ?? null;
  }
}

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
