import { randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool, HumanIdentityKey } from '@cauce/store';
import { withTransaction } from '@cauce/store';

export async function seedIdentity(pool: DatabasePool, sharedAlias?: string) {
  const humanId = randomUUID();
  const alias = sharedAlias ?? `human_${humanId.slice(0, 8)}`;
  const key: HumanIdentityKey = { provider: 'oauth', namespace: 'https://issuer.example.test', subject: `Subject/${humanId}` };
  await withTransaction(pool, async (client) => {
    await client.query('INSERT INTO agents(tenant_id,alias) VALUES($1,$2) ON CONFLICT DO NOTHING', ['Steven', alias]);
    await client.query(`INSERT INTO console_users
      (id,email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
      VALUES($1,$2,$2,$3,'Fixture human','operator','Steven',$4,true)`,
    [humanId, `${humanId}@example.invalid`, `$scrypt$${'x'.repeat(40)}`, alias]);
    await client.query(`INSERT INTO human_external_identities(human_id,provider,namespace,subject,revision)
      VALUES($1,$2,$3,$4,9007199254740993)`, [humanId, key.provider, key.namespace, key.subject]);
    await client.query(`INSERT INTO human_tenant_memberships
      (human_id,tenant_id,actor_alias,role,permissions,revision)
      VALUES($1,'Steven',$2,'operator',ARRAY['read','route'],9007199254740994)`, [humanId, alias]);
  });
  return { humanId, alias, key };
}

export async function addDefaultMembership(pool: DatabasePool, humanId: string, alias: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("INSERT INTO agents(tenant_id,alias) VALUES('Jhon',$1) ON CONFLICT DO NOTHING", [alias]);
    await client.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,'Jhon',$2,'operator',ARRAY['read','route'])`, [humanId, alias]);
  });
}

export async function waitForBlocked(observer: DatabaseClient, pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('expected PostgreSQL lock barrier was not reached');
}

export const revocations = {
  account: 'UPDATE console_users SET active=false WHERE id=$1',
  binding: 'UPDATE human_external_identities SET enabled=false, revoked_at=now(), revision=revision+1 WHERE human_id=$1',
  membership: 'UPDATE human_tenant_memberships SET enabled=false, revoked_at=now(), revision=revision+1 WHERE human_id=$1',
} as const;
