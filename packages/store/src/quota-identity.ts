import { createHash } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from './db.js';
import { withTransaction } from './db.js';
import { StoreError } from './repository/errors.js';

/** A quota registration that still has no authenticated provider identity. */
export const PENDING_QUOTA_ACCOUNT_SQL = 'quota_registration_key IS NOT NULL AND quota_identity_hash IS NULL';

/**
 * A provider session proven inside an agent (fleet login) enables its pending quota
 * registration: the account stays without a quota identity hash, which is only bound
 * by a quota-environment login, but it may now back fleet operations.
 */
export async function enableProviderAccountAfterAgentAuth(pool: DatabasePool, accountId: string): Promise<boolean> {
  return withTransaction(pool, async client => {
    const updated = await client.query(
      `UPDATE provider_accounts SET enabled=true,quota_version=quota_version+1,updated_at=now()
       WHERE id=$1 AND enabled=false AND canonical_account_id IS NULL AND ${PENDING_QUOTA_ACCOUNT_SQL}`,
      [accountId]);
    return (updated.rowCount ?? 0) > 0;
  });
}

function providerIdentityHash(provider: string, identity: string): string {
  if (typeof identity !== 'string' || identity.length < 1 || identity.length > 256 || /[\p{Cc}]/u.test(identity)) {
    throw new StoreError('invalid_input', 'quota provider identity is invalid');
  }
  return createHash('sha256').update(JSON.stringify([provider, identity])).digest('hex');
}
export async function assertQuotaEnvironmentIdentity(client: DatabaseClient, environmentId: string, accountId: string, identity: string): Promise<void> {
  const environment = (await client.query<{ account_id: string; provider: string; quota_identity_hash: string | null }>(
    `SELECT environment.account_id,environment.provider,account.quota_identity_hash FROM quota_environments environment
     JOIN provider_accounts account ON account.id=environment.account_id AND account.company_id=environment.company_id
       AND account.provider=environment.provider AND account.canonical_account_id IS NULL
     WHERE environment.id=$1 FOR SHARE OF environment,account`, [environmentId])).rows[0];
  if (environment?.account_id !== accountId
      || environment.quota_identity_hash !== providerIdentityHash(environment.provider, identity)) {
    throw new StoreError('conflict', 'quota authenticated identity differs from the accepted account');
  }
}
export async function bindQuotaEnvironmentIdentity(client: DatabaseClient, environmentId: string, identity: string): Promise<string> {
  const environment = (await client.query<{ company_id: string; account_id: string; provider: string }>(
    'SELECT company_id,account_id,provider FROM quota_environments WHERE id=$1 FOR UPDATE', [environmentId])).rows[0];
  if (!environment) throw new StoreError('conflict', 'quota environment identity is unavailable');
  const hash = providerIdentityHash(environment.provider, identity);
  await client.query('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))', [783_003_057, `${environment.company_id}/${hash}`]);
  const current = (await client.query<{ quota_identity_hash: string | null }>('SELECT quota_identity_hash FROM provider_accounts WHERE id=$1 FOR UPDATE', [environment.account_id])).rows[0];
  if (current?.quota_identity_hash != null && current.quota_identity_hash !== hash) {
    throw new StoreError('conflict', 'the authenticated provider account differs from the environment account');
  }
  const canonical = (await client.query<{ id: string }>(`SELECT id FROM provider_accounts WHERE company_id=$1 AND provider=$2
    AND canonical_account_id IS NULL AND (quota_identity_hash=$3 OR external_account_id=$4) ORDER BY id LIMIT 1 FOR UPDATE`,
  [environment.company_id, environment.provider, hash, identity])).rows[0];
  const id = canonical?.id ?? environment.account_id;
  if (id !== environment.account_id) {
    const bindings = await client.query('SELECT 1 FROM agent_account_bindings WHERE account_id=$1 LIMIT 1', [environment.account_id]);
    if (bindings.rowCount) throw new StoreError('conflict', 'assign agents to the canonical shared subscription before merging a quota registration');
    await client.query('UPDATE quota_environments SET account_id=$2,version=version+1,updated_at=now() WHERE account_id=$1', [environment.account_id, id]);
    await client.query(`UPDATE provider_accounts SET canonical_account_id=$2,enabled=false,quota_version=quota_version+1,updated_at=now()
      WHERE id=$1 AND quota_registration_key IS NOT NULL`, [environment.account_id, id]);
  }
  await client.query(`UPDATE provider_accounts SET quota_identity_hash=$2,enabled=true,quota_version=quota_version+1,updated_at=now() WHERE id=$1`, [id, hash]);
  return id;
}
