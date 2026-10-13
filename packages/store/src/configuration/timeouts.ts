import type { DatabaseClient } from '../db.js';

/** Zero disables a PostgreSQL timeout; an existing finite caller limit may only be shortened. */
export async function boundAuthorityTimeouts(client: DatabaseClient, maximumMs = 5_000, statement = false): Promise<void> {
  await client.query(`SELECT set_config(name,
    LEAST(COALESCE(NULLIF(setting::bigint,0),$1::bigint),$1::bigint)::text,true)
    FROM pg_settings WHERE name=ANY($2::text[])`,
  [maximumMs, statement ? ['lock_timeout', 'statement_timeout'] : ['lock_timeout']]);
}
