-- Agent registry plus a cross-tenant pool of provider subscriptions, in the shape settled by
-- docs/POOL-SUSCRIPCIONES-Y-ALTA-AGENTES.md §1.2 and recorded in
-- docs/adr/006-agent-registry-and-deferred-execution.md.
--
-- Three questions, three tables: what is this alias and what runs it (`agents`), which
-- subscriptions exist and WHO PAYS for each (`provider_accounts`), and which subscriptions an
-- alias is allowed to fall back to and in what order (`alias_routing_ceiling` +
-- `agent_account_bindings`).
--
-- Additive by construction: memberships/rooms remain the routing and ACL surface, and nothing on
-- the delivery hot path (claimDeliveries, assertRuntimeRoute) reads any of these tables. An empty
-- ceiling means an alias behaves exactly as it does today.

-- 'openclaw' is a real production harness (hegel, janus, jarvis, midas and seneca all run it,
-- see ops/scripts/manifest_lib.py EXPECTED) that migration 003 never seeded. Without this row no
-- agent could reference the harness half the current fleet uses.
INSERT INTO harness_definitions(id,display_name,capabilities) VALUES
  ('openclaw','OpenClaw','["messages.receive","jobs.interactive","jobs.batch"]'::jsonb)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS agents (
  tenant_id text NOT NULL REFERENCES tenants(id),
  alias text NOT NULL CHECK (alias ~ '^[a-z][a-z0-9_-]{0,63}$'),
  harness_id text REFERENCES harness_definitions(id),
  display_name text,
  enabled boolean NOT NULL DEFAULT false,
  -- Runtime placement mirrors ops/container-aliases.json. It is all-or-nothing: a partially
  -- filled placement is not a valid runtime target for anything that reads this table.
  container_name text,
  runtime_user text,
  home_directory text,
  state_directory text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, alias),
  CONSTRAINT agents_placement_atomic CHECK (
    num_nonnulls(container_name, runtime_user, home_directory, state_directory) IN (0, 4)
  ),
  -- An enabled agent must be routable to a concrete runtime: fail-closed the same way
  -- acl_edges/role_policies already default every new permission column to false.
  CONSTRAINT agents_enabled_requires_runtime CHECK (
    NOT enabled OR (harness_id IS NOT NULL AND container_name IS NOT NULL)
  )
);

-- A provider subscription. The primary key is GLOBAL and deliberately not composed with a
-- tenant: an account is an object in its own right that any alias may be lent, while
-- payer_tenant_id keeps "quién paga qué" answerable forever. Composing the key with the
-- consumer's tenant is exactly the bug this table replaces — it made cross-tenant lending
-- structurally impossible.
CREATE TABLE IF NOT EXISTS provider_accounts (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  -- Opaque external identity (uuid, email, org id). Never the secret.
  external_account_id text NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 256),
  payer_tenant_id text NOT NULL REFERENCES tenants(id),
  label text,
  -- credential_ref is a LOCATOR, never a secret: env_path names a variable the adapter reads
  -- from its own process environment, file is an absolute path, secret_manager is a scheme:path
  -- into an external vault. The gateway never resolves any of them; that stays host-side,
  -- exactly like PKI_ROOT today. This is what makes lending an account safe at all — the
  -- borrower receives a reference it can only dereference on a host that already holds the
  -- material, so a pool row can never become a credential leak.
  credential_ref_kind text NOT NULL CHECK (credential_ref_kind IN ('env_path','file','secret_manager')),
  credential_ref text NOT NULL,
  -- Explicit opt-in to being used by OTHER tenants. Default-deny like every other permission in
  -- this schema; the borrow guard on alias_routing_ceiling is what gives it teeth.
  shared_with_pool boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One external subscription has exactly one payer; registering it twice would make
  -- "quién paga qué" unanswerable.
  UNIQUE (provider, external_account_id),
  -- Neither of the next two is redundant with the primary key: they are the targets of the two
  -- foreign keys alias_routing_ceiling uses to keep its payer mirror truthful and to refuse a
  -- loan the payer never authorised.
  UNIQUE (id, payer_tenant_id),
  UNIQUE (id, payer_tenant_id, shared_with_pool),
  CONSTRAINT provider_accounts_credential_ref_shape CHECK (
    credential_ref !~ '[[:cntrl:]]' AND (
      (credential_ref_kind = 'env_path' AND credential_ref ~ '^CAUCE_[A-Z0-9_]{1,120}_(PATH|FILE)$')
      OR (credential_ref_kind = 'file' AND length(credential_ref) BETWEEN 2 AND 1024
          AND left(credential_ref,1) = '/' AND credential_ref !~ '//'
          AND credential_ref !~ '(^|/)[.][.]?(/|$)')
      OR (credential_ref_kind = 'secret_manager'
          AND credential_ref ~ '^(vault|aws-sm|gcp-sm|op|azure-kv):[a-z0-9][a-z0-9_.:/-]{0,254}$')
    )
  )
);

-- THE CEILING: the exhaustive set of accounts an alias may ever be routed to. It exists so the
-- limit is a Postgres constraint rather than a branch in authorization code — agent_account_bindings
-- references this table, not provider_accounts, so no binding outside the ceiling can exist even
-- if the mutation layer were ever made field-blind.
CREATE TABLE IF NOT EXISTS alias_routing_ceiling (
  tenant_id text NOT NULL,
  alias text NOT NULL,
  account_id text NOT NULL,
  -- FK-verified mirror of provider_accounts.payer_tenant_id. It is not denormalisation for
  -- speed: it is the only way to express "this row lends somebody else's account" as something
  -- Postgres itself can check.
  account_payer_tenant text NOT NULL,
  created_by_tenant text NOT NULL REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Both columns are non-null exactly when the account is BORROWED from another tenant, and both
  -- are generated so no writer can spoof them. Under MATCH SIMPLE a foreign key whose referencing
  -- columns contain a NULL is not checked, so the borrow guard below applies to loans only and
  -- leaves a payer routing its own account untouched.
  borrowed_payer_tenant text GENERATED ALWAYS AS (
    CASE WHEN account_payer_tenant <> tenant_id THEN account_payer_tenant ELSE NULL::text END
  ) STORED,
  borrowed_from_pool boolean GENERATED ALWAYS AS (
    CASE WHEN account_payer_tenant <> tenant_id THEN true ELSE NULL::boolean END
  ) STORED,
  PRIMARY KEY (tenant_id, alias, account_id),
  CONSTRAINT alias_routing_ceiling_agent_fk
    FOREIGN KEY (tenant_id, alias) REFERENCES agents(tenant_id, alias) ON DELETE CASCADE,
  CONSTRAINT alias_routing_ceiling_account_fk
    FOREIGN KEY (account_id, account_payer_tenant) REFERENCES provider_accounts(id, payer_tenant_id),
  -- Lending only works against an account whose payer published it into the pool, and revoking
  -- that publication while a loan is outstanding fails with 23503 instead of silently leaving a
  -- foreign alias drawing on a withdrawn subscription. Both directions are enforced by Postgres,
  -- because this is the boundary that decides whose subscription a delivery spends.
  CONSTRAINT alias_routing_ceiling_borrow_requires_pool
    FOREIGN KEY (account_id, borrowed_payer_tenant, borrowed_from_pool)
    REFERENCES provider_accounts(id, payer_tenant_id, shared_with_pool)
);
CREATE INDEX IF NOT EXISTS alias_routing_ceiling_account_idx
  ON alias_routing_ceiling (account_id);

-- Fallback order WITHIN the ceiling. There is no 'purpose' column: the harness main loop is
-- never a row here. Attempt 1 of a delivery runs with no environment override at all, so the CLI
-- resolves whichever credential is already logged in inside its container — that is what "todos
-- pueden usar el pool de todos EXCEPTO en el main del harness" means operationally, and it is a
-- property of the runtime, not something a row could express.
CREATE TABLE IF NOT EXISTS agent_account_bindings (
  tenant_id text NOT NULL,
  agent_alias text NOT NULL,
  account_id text NOT NULL,
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 32767),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_alias, account_id),
  -- ON DELETE CASCADE so that withdrawing a ceiling entry actually stops the routing instead of
  -- being blocked by the binding that depends on it: revocation must never need two steps in the
  -- right order to take effect.
  CONSTRAINT agent_account_bindings_ceiling_fk
    FOREIGN KEY (tenant_id, agent_alias, account_id)
    REFERENCES alias_routing_ceiling (tenant_id, alias, account_id) ON DELETE CASCADE
);
-- One account per rank, so the fallback order of an alias is always total and unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS agent_account_bindings_order_idx
  ON agent_account_bindings (tenant_id, agent_alias, priority) WHERE enabled;
