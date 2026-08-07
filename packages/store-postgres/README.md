# @paperclip-chat-gateway/store-postgres

Postgres-backed implementations of `packages/core`'s `AgentCredentialStore`,
`IdentityResolver`, and (a necessarily-async variant of) `BindingTable`,
plus the admin write path (`AdminStore`) that backs the gateway's admin
HTTP endpoints. This replaces the "edit an EFS JSON file + write an SSM
param + terraform apply + restart" onboarding flow with two API calls.

## Why the 1:1 rules live in application code, not the schema

The MVP behavior is: one owner per agent, one personal agent per person.
It would be tempting to "harden" that with a `UNIQUE` constraint on
`agent_grants.employee_id`, or a unique partial index on
`(agent_id) WHERE role = 'owner' AND revoked_at IS NULL`. **Don't.** Both
would work for the MVP and both would actively block the features already
specified as coming next:

- a person owning multiple agents,
- an agent shared with multiple people,
- self-serve grant/revoke by owners.

`agent_grants` is a genuine many-to-many join table on purpose: any
`(employee_id, agent_id)` pair may appear, any number of times (as long as
each *active*, i.e. non-revoked, row is a distinct grant — which the
application enforces, not the schema). `schema-permits-multiple-grants.test.ts`
proves this directly with a raw SQL insert that bypasses `AdminStore`
entirely — if a future PR "cleans up" by adding a unique constraint, that
test (not just the application-level rule test) will fail. That's the
tripwire this test exists for.

The 1:1 rule itself lives in `AdminStore.grantAccess`
(`src/admin.ts`): it checks for an existing active owner grant on the
target agent, and — for `kind = 'personal'` agents — an existing active
personal-agent grant for the target employee, and throws
`OneOwnerPerAgentError` / `OnePersonalAgentPerEmployeeError` before ever
touching a future multi-owner or multi-agent world's actual data shape.
When those features ship, this is the one function that changes; the
schema underneath it does not need a migration.

The same reasoning applies to `agents.kind` (`personal` | `shared`,
defaulting to — and in the MVP, *always* — `personal`) and
`agent_grants.role` (`owner` | `member`, defaulting to `owner`): both
columns exist from day one specifically so "personal agents are never
shareable, shared agents hold only contributed content" and "a member
grant is a lesser access level than an owner grant" have somewhere to hang
their logic later, without a migration.

## Provenance and revocation

Every grant records `granted_by` and `granted_at`. Revocation sets
`revoked_at`; there is no code path that `DELETE`s a grant row. This keeps
"who had access to this agent, when, and who granted/revoked it" queryable
forever, which matters both for audit and for reasoning about credential
exposure after the fact.

## Credentials

`agent_credentials` is keyed by `agent_id`, not by grant — one encrypted
API key per agent, independent of how many people (today: zero or one) can
reach it. Keys are encrypted at the application layer with AES-256-GCM
(`src/crypto.ts`, Node's built-in `crypto`, no added dependency) using a
key from `AGENT_KEY_ENCRYPTION_KEY` (64 hex chars = 32 bytes). Postgres
only ever stores ciphertext. No code path returns a decrypted key from an
HTTP response, and the plaintext key is never logged — see
`admin.test.ts`'s log-leak guard test.

Claiming an agent's API key via the Paperclip CLI is a manual human step
and stays out of scope here; `AdminStore.registerAgent` only accepts an
already-claimed key.

## Employees

Keyed by verified email, lowercased (`employees.email`'s
`CHECK (email = lower(email))`), matching
`ConfigIdentityResolver`'s existing case-insensitive normalization
(`packages/core/src/identity.ts`). `normalizeEmail` in `src/identity.ts`
is the single place that normalization happens on the DB-backed path.

## Migrations

Plain, numbered SQL files under `src/migrations/`, applied in ascending
filename order by the hand-rolled runner in `src/migrate.ts`, tracked in a
`schema_migrations` table so re-running `migrate()` is idempotent. No ORM
(no Prisma/TypeORM/Drizzle/Knex) — just `pg` and SQL.

## The one interface change this feature required

`core.BindingTable`'s public methods (`resolveAgentFor`,
`resolveEmployeeFor`, `isAuthorized`) are synchronous, because its only
implementation is an in-memory map built from config at startup. A
DB-backed binding table cannot honor that exact signature. `src/binding-table.ts`
exports a `BindingResolver` interface with the same method names and
deny-by-default semantics, but `Promise`-returning. `core.BindingTable`
is **not modified** and already satisfies `BindingResolver` structurally
(TypeScript structural typing + `await` on an already-resolved value is a
no-op), so the file/env path is unaffected. `packages/transport-web/src/types.ts`
widens `GatewayDeps.bindings`'s type from the concrete `BindingTable`
class to `BindingResolver` for this reason, and the two route files that
call it now `await` the result.

## Testing

Tests spin up a real, ephemeral Postgres via `testcontainers`
(`@testcontainers/postgresql`) and run every migration before each suite —
this requires a local Docker daemon (see repo root README/CI config for
how that's provided). Nothing in this package is tested against a fake or
in-memory stand-in for Postgres.
