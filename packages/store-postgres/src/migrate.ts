import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Deliberately hand-rolled instead of pulling in an ORM/migration framework
 * (no Prisma/TypeORM/Drizzle/Knex — see README): plain numbered `.sql`
 * files applied in ascending filename order, each one tracked by name in a
 * `schema_migrations` table so re-running `migrate()` is a no-op once a
 * migration has been applied. Every migration file runs inside its own
 * transaction, so a failing migration cannot leave a half-applied schema
 * change committed.
 */
export async function migrate(pool: Pool, migrationsDir: string = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows: appliedRows } = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(appliedRows.map((r) => r.name));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      newlyApplied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration "${file}" failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}
