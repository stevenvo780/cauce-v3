-- PTY control plane. The gateway decides and audits every terminal session; the bytes
-- travel through terminal-relay and never touch this table. One row per issued ticket,
-- so the audit trail keeps the exact container, image digest and generation that the
-- operator was handed, even after the container is recreated on kratos.
--
-- Purely additive: no existing table is touched. Terminal enablement is a grants file
-- (CAUCE_TERMINAL_GRANTS_FILE), not a column in role_policies or acl_edges, because
-- production only accepts read-only SQL.

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id uuid PRIMARY KEY,
  -- Human behind the console when attribution exists; otherwise the shared basic-auth
  -- pseudo-operator. attributed=false forbids cross-tenant targets (see authority.ts).
  operator_id text NOT NULL,
  attributed boolean NOT NULL DEFAULT false,
  -- Certificate principal the gateway authenticated (today always Steven:kant).
  console_subject text NOT NULL,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  container text NOT NULL,
  generation text,
  image_id text,
  runtime_user text,
  mode text NOT NULL CHECK (mode IN ('shell','harness')),
  -- Only the digest of the emitted ticket; the ticket itself is never persisted or logged.
  ticket_sha256 bytea NOT NULL,
  reason text NOT NULL,
  cols integer,
  rows integer,
  trace_id text,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  bytes_in bigint NOT NULL DEFAULT 0,
  bytes_out bigint NOT NULL DEFAULT 0
);

-- Concurrency limits per operator and the container-busy check both scan only open rows.
CREATE INDEX IF NOT EXISTS terminal_sessions_open_operator_idx
  ON terminal_sessions (operator_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS terminal_sessions_open_target_idx
  ON terminal_sessions (tenant_id, alias) WHERE closed_at IS NULL;
