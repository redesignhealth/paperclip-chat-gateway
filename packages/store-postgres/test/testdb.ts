import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/migrate.js";

/**
 * Spins up a real, ephemeral Postgres via testcontainers (requires a local
 * Docker daemon) and applies every migration. Used by every test in this
 * package that needs the DB-backed store — deliberately NOT a fake/mock,
 * per the task's instruction to test against real Postgres where feasible.
 */
export interface TestDb {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  close(): Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
  return {
    container,
    pool,
    async close() {
      await pool.end();
      await container.stop();
    },
  };
}
