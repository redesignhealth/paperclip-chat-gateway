-- Initial schema for the Postgres-backed roster / binding / credential
-- store. See ../../README.md for the reasoning behind each design choice
-- below (especially why the MVP's "1 owner per agent" / "1 personal agent
-- per person" rules are NOT expressed as schema constraints here).

CREATE TABLE employees (
  employee_id  TEXT PRIMARY KEY,
  -- Verified email, always stored lowercased to match
  -- ConfigIdentityResolver's existing case-insensitive normalization
  -- (packages/core/src/identity.ts). The CHECK is a belt-and-suspenders
  -- guard against a future write path that forgets to normalize before
  -- insert; the application layer is still responsible for normalizing on
  -- every read too.
  email        TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  agent_id     TEXT PRIMARY KEY,
  -- 'personal' (holds one person's credentials, never shareable) vs
  -- 'shared' (holds only contributed content, no personal credentials).
  -- MVP only ever creates 'personal' agents; the column exists from day
  -- one so the future personal/shared split needs no migration.
  kind         TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'shared')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credentials live keyed by agent, NOT by grant: one encrypted API key per
-- agent regardless of how many people can reach it (relevant once 'shared'
-- agents / multi-person grants exist). The key is encrypted at the
-- application layer (AES-256-GCM, see ../crypto.ts) before it ever reaches
-- this table; this table only ever stores ciphertext.
CREATE TABLE agent_credentials (
  agent_id       TEXT PRIMARY KEY REFERENCES agents(agent_id),
  encrypted_key  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The binding/grant table: a genuine many-to-many join between employees
-- and agents. Deliberately NO unique constraint on employee_id alone, and
-- NO unique constraint on (employee_id, agent_id) either — see README for
-- why the MVP's 1:1 rule is enforced in application code instead, and why
-- that is intentional rather than an oversight.
CREATE TABLE agent_grants (
  id           BIGSERIAL PRIMARY KEY,
  employee_id  TEXT NOT NULL REFERENCES employees(employee_id),
  agent_id     TEXT NOT NULL REFERENCES agents(agent_id),
  -- 'owner' (personal-agent owner; holds/uses the credential) vs 'member'
  -- (future: shared-agent participant). MVP only ever writes 'owner'.
  role         TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
  granted_by   TEXT NOT NULL,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Revocation is a timestamp, never a DELETE — the grant's history
  -- (who had access, granted by whom, when revoked) is provenance that
  -- must survive revocation for audit purposes.
  revoked_at   TIMESTAMPTZ
);

-- These are non-unique indexes: they speed up the "does this employee/agent
-- have any active grants" lookups the store performs on every request, but
-- deliberately do NOT constrain how many active rows can match — that
-- would smuggle the 1:1 rule back into the schema through the back door.
CREATE INDEX idx_agent_grants_employee_active ON agent_grants(employee_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_agent_grants_agent_active ON agent_grants(agent_id) WHERE revoked_at IS NULL;
