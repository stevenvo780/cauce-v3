import { createHash, randomBytes } from 'node:crypto';

interface Queryable { query(sql: string, values?: unknown[]): Promise<{ rows: { id: string }[]; rowCount: number | null }> }

/**
 * The hermetic gateway has no configured executor, so the console only offers quota accounts when an enrolled host reports a fresh
 * quota capability. This writes the rows a real enrolled host leaves behind, valid for a day so the 120 s window never expires mid-run.
 */
export async function seedQuotaHost(db: Queryable, input: { companyId: string; ownerEmail: string; hostId: string }): Promise<void> {
  const owner = (await db.query('SELECT id FROM console_users WHERE email=$1', [input.ownerEmail])).rows[0];
  if (!owner) throw new Error('quota host owner does not exist');
  const enrollment = (await db.query(`INSERT INTO fleet_host_enrollments(company_id,host_id,display_name,invited_by,token_hash,nonce,expires_at,state,enrolled_at)
    VALUES($1,$2,'Ordenador de cuotas V4',$3,$4,$5,now()+interval '1 day','enrolled',now()) RETURNING id`,
  [input.companyId, input.hostId, owner.id, randomBytes(32).toString('hex'), randomBytes(32).toString('hex')])).rows[0];
  if (!enrollment) throw new Error('quota host enrollment was not created');
  await db.query('INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES($1,$2,$3)', [input.hostId, input.companyId, 'Ordenador de cuotas V4']);
  const publicKey = randomBytes(48).toString('base64');
  const actions = ['create', 'authenticate', 'query', 'update_cli', 'delete'];
  const capabilities = { resource: 'host', action: 'capabilities', schemaVersion: 1, executor_version: 'v4-e2e', policy_sha256: createHash('sha256').update(input.hostId).digest('hex'),
    fleet_executor: false, quota_executor: true, templates: [], quota_providers: ['codex'], quota_provider_actions: { codex: actions } };
  await db.query(`INSERT INTO fleet_host_identities(host_id,company_id,enrollment_id,public_key,key_fingerprint,capabilities,capabilities_seen_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,now()+interval '1 day')`,
  [input.hostId, input.companyId, enrollment.id, publicKey, createHash('sha256').update(publicKey).digest('hex'), JSON.stringify(capabilities)]);
}
