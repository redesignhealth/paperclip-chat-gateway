import type { Pool } from "pg";
import type { AgentCredentialStore } from "@paperclip-chat-gateway/core";
import { decryptAgentKey } from "./crypto.js";

/**
 * Postgres-backed AgentCredentialStore. Each agent's encrypted key lives in
 * its own row in `agent_credentials`, keyed by `agent_id` — one row per
 * agent regardless of how many people are granted access to it (see
 * migrations/0001_init.sql). Decryption happens here, at read time; the
 * plaintext key never touches the database and is never logged (see
 * ../crypto.ts).
 */
export class DbAgentCredentialStore implements AgentCredentialStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: Buffer,
  ) {}

  async getKeyFor(agentId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ encrypted_key: string }>(
      "SELECT encrypted_key FROM agent_credentials WHERE agent_id = $1",
      [agentId],
    );
    const row = rows[0];
    if (!row) return null;
    return decryptAgentKey(row.encrypted_key, this.encryptionKey);
  }
}
