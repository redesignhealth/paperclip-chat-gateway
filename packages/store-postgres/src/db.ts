import { Pool } from "pg";

/** Thin factory so callers don't need to import `pg` directly. */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}
