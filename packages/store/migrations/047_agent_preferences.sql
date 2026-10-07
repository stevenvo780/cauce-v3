SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_047);

CREATE TABLE console_agent_favorites (
  human_id uuid NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (human_id, tenant_id, alias),
  FOREIGN KEY (tenant_id, alias) REFERENCES agents(tenant_id, alias) ON DELETE CASCADE
);
CREATE INDEX console_agent_favorites_agent ON console_agent_favorites(tenant_id, alias);

CREATE TABLE agent_appearances (
  tenant_id text NOT NULL,
  alias text NOT NULL,
  glyph text CHECK (glyph IS NULL OR (
    char_length(glyph) BETWEEN 1 AND 16 AND octet_length(glyph) <= 64 AND glyph !~ '[[:cntrl:][:space:]]')),
  hue smallint CHECK (hue IS NULL OR hue BETWEEN 0 AND 359),
  style text NOT NULL CHECK (style IN ('orb', 'aurora', 'pulse', 'pixel')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 256),
  PRIMARY KEY (tenant_id, alias),
  FOREIGN KEY (tenant_id, alias) REFERENCES agents(tenant_id, alias) ON DELETE CASCADE
);
