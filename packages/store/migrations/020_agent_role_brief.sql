-- 020: Columna role_brief en la tabla agents para descripción corta de rol del agente.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS role_brief text;

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_role_brief_len;

ALTER TABLE agents
  ADD CONSTRAINT agents_role_brief_len CHECK (
    role_brief IS NULL OR char_length(role_brief) BETWEEN 1 AND 1200
  ) NOT VALID;
