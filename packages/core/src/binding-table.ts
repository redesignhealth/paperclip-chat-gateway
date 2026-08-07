import { z } from "zod";

/**
 * BindingTable is the security kernel of this whole project: it is the ONLY
 * place that decides which employee may talk to which Paperclip agent.
 *
 * Design constraints (do not relax these without re-reading the threat
 * model in the README):
 *
 * - Deny by default. An employee/agent pair not explicitly present in the
 *   table resolves to `null`, never to a guess, a wildcard, or a "default
 *   agent."
 * - Exactly one binding per employee. This gateway enforces a 1:1
 *   human<->agent relationship; it is not a routing layer. If a future
 *   version needs many-to-many, that is a new, explicitly-reviewed data
 *   model, not a loosening of this one.
 * - Config-driven and validated. Bindings are data (env/file today, a
 *   different store later), validated with zod so a malformed config fails
 *   closed at load time instead of silently granting access.
 */

export const bindingEntrySchema = z.object({
  employeeId: z.string().min(1),
  agentId: z.string().min(1),
});

export const bindingTableConfigSchema = z.object({
  bindings: z.array(bindingEntrySchema),
});

export type BindingEntry = z.infer<typeof bindingEntrySchema>;
export type BindingTableConfig = z.infer<typeof bindingTableConfigSchema>;

export class DuplicateEmployeeBindingError extends Error {
  constructor(employeeId: string) {
    super(
      `Employee "${employeeId}" has more than one binding entry. This gateway enforces a strict ` +
        "1:1 employee-to-agent binding; duplicate entries are rejected at load time rather than " +
        "silently picking one.",
    );
    this.name = "DuplicateEmployeeBindingError";
  }
}

export class DuplicateAgentBindingError extends Error {
  constructor(agentId: string) {
    super(
      `Agent "${agentId}" is bound to more than one employee. This gateway enforces a strict 1:1 ` +
        "employee-to-agent binding in both directions; duplicate entries are rejected at load time " +
        "rather than silently letting one agent serve multiple employees.",
    );
    this.name = "DuplicateAgentBindingError";
  }
}

export class BindingTable {
  private readonly byEmployeeId: ReadonlyMap<string, string>;

  private constructor(byEmployeeId: ReadonlyMap<string, string>) {
    this.byEmployeeId = byEmployeeId;
  }

  /**
   * Parses and validates raw config (e.g. `JSON.parse`d env var or file
   * contents) into a BindingTable. Throws on malformed shape or duplicate
   * employee/agent entries — fail closed, never fail open. The 1:1
   * invariant is enforced in both directions: no employee may have two
   * bindings, and no agent may be bound to two employees.
   */
  static fromConfig(raw: unknown): BindingTable {
    const parsed = bindingTableConfigSchema.parse(raw);
    const map = new Map<string, string>();
    const seenAgentIds = new Set<string>();
    for (const entry of parsed.bindings) {
      if (map.has(entry.employeeId)) {
        throw new DuplicateEmployeeBindingError(entry.employeeId);
      }
      if (seenAgentIds.has(entry.agentId)) {
        throw new DuplicateAgentBindingError(entry.agentId);
      }
      seenAgentIds.add(entry.agentId);
      map.set(entry.employeeId, entry.agentId);
    }
    return new BindingTable(map);
  }

  static empty(): BindingTable {
    return new BindingTable(new Map());
  }

  /**
   * Returns the single agentId this employee is bound to, or `null` if
   * there is no binding. There is intentionally no "list all agents this
   * employee can reach" method — 1:1 is enforced by the shape of this API,
   * not just by convention.
   */
  resolveAgentFor(employeeId: string): string | null {
    return this.byEmployeeId.get(employeeId) ?? null;
  }

  /**
   * Explicit authorization check: may this employee send to this agent?
   * Prefer this over comparing `resolveAgentFor` yourself so the deny path
   * is centralized and easy to audit.
   */
  isAuthorized(employeeId: string, agentId: string): boolean {
    return this.resolveAgentFor(employeeId) === agentId;
  }

  size(): number {
    return this.byEmployeeId.size;
  }
}
