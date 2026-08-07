import type { Pool } from "pg";
import type { Employee, EmployeeClaims, IdentityResolver } from "@paperclip-chat-gateway/core";

/** Lowercases an email the same way `ConfigIdentityResolver` does (packages/core/src/identity.ts). */
export function normalizeEmail(email: string): string {
  return email.toLowerCase();
}

/**
 * Postgres-backed IdentityResolver: employees are keyed by verified email,
 * lowercased (see `employees.email`'s `CHECK (email = lower(email))` in
 * migrations/0001_init.sql). Like `ConfigIdentityResolver`, this is a pure
 * lookup — no implicit provisioning of new employees on first sight. An
 * unrecognized email resolves to `null`.
 */
export class DbIdentityResolver implements IdentityResolver {
  constructor(private readonly pool: Pool) {}

  async resolve(claims: EmployeeClaims): Promise<Employee | null> {
    if (!claims.email) return null;
    const { rows } = await this.pool.query<{ employee_id: string; email: string; name: string | null }>(
      "SELECT employee_id, email, name FROM employees WHERE email = $1",
      [normalizeEmail(claims.email)],
    );
    const row = rows[0];
    if (!row) return null;
    return { employeeId: row.employee_id, email: row.email, name: row.name ?? claims.name };
  }
}
