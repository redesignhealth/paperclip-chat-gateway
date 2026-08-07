/**
 * IdentityResolver turns a verified set of auth claims (from whatever auth
 * adapter is in play — OIDC today, anything else later) into a
 * gateway-internal `Employee` identity. Core has no opinion about *how*
 * those claims were verified; that's the auth adapter's job. Core only
 * cares that, once verified, they resolve deterministically to exactly one
 * employee or to nothing.
 */

export interface EmployeeClaims {
  /** Stable subject identifier from the auth provider (e.g. OIDC `sub`). */
  subject: string;
  /** Verified email address, if the provider asserts one. */
  email?: string;
  /** Human-readable display name, if available. */
  name?: string;
  /** Raw provider-specific claims, kept for audit/debugging only. */
  raw?: Record<string, unknown>;
}

export interface Employee {
  /** Gateway-internal employee id. This is what BindingTable keys on. */
  employeeId: string;
  email?: string;
  name?: string;
}

/**
 * Resolves verified auth claims to a gateway Employee. Implementations must
 * be pure lookups (config, database, directory API) — no side effects, no
 * implicit provisioning of new employees on first sight. An unknown subject
 * resolves to `null`, not a freshly minted identity.
 */
export interface IdentityResolver {
  resolve(claims: EmployeeClaims): Promise<Employee | null>;
}

export interface ConfigEmployee extends Employee {
  /** Verified email this employee is expected to authenticate with. */
  email: string;
}

/**
 * v1 implementation: employees are a small, explicit, config-driven list
 * (env/file), keyed by verified email. This is intentionally not an LDAP
 * or SCIM integration — the gateway is meant to sit in front of a handful
 * of narrowly-bound agents, and an explicit list keeps "who can possibly
 * reach an agent at all" auditable in one place, upstream of BindingTable.
 */
export class DuplicateEmployeeEmailError extends Error {
  constructor(email: string) {
    super(
      `The employee roster has more than one entry for email "${email}" (case-insensitive). ` +
        "Refusing to load: silently picking one would make it ambiguous which employee a login " +
        "resolves to, which is exactly the kind of identity ambiguity this gateway is built to avoid.",
    );
    this.name = "DuplicateEmployeeEmailError";
  }
}

export class ConfigIdentityResolver implements IdentityResolver {
  private readonly byEmail: ReadonlyMap<string, ConfigEmployee>;

  constructor(employees: readonly ConfigEmployee[]) {
    const map = new Map<string, ConfigEmployee>();
    for (const employee of employees) {
      const key = employee.email.toLowerCase();
      if (map.has(key)) {
        throw new DuplicateEmployeeEmailError(employee.email);
      }
      map.set(key, employee);
    }
    this.byEmail = map;
  }

  async resolve(claims: EmployeeClaims): Promise<Employee | null> {
    if (!claims.email) return null;
    const match = this.byEmail.get(claims.email.toLowerCase());
    if (!match) return null;
    return { employeeId: match.employeeId, email: match.email, name: match.name ?? claims.name };
  }
}
