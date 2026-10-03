import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { DatabaseClient, DatabasePool } from '@cauce/store';

export const VERSION = '044_human_mcp_identity.sql';
export const ALIAS = 'human_fixture';

export async function rollbackFixture(pool: DatabasePool, work: (client: DatabaseClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

export async function rejectsSql(client: DatabaseClient, sql: string, values: unknown[] = [], code?: string): Promise<void> {
  await client.query('SAVEPOINT expected_constraint');
  try {
    const result = client.query(sql, values);
    if (code) await expect(result).rejects.toMatchObject({ code });
    else await expect(result).rejects.toBeDefined();
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_constraint');
    await client.query('RELEASE SAVEPOINT expected_constraint');
  }
}

export async function seedAgent(client: DatabaseClient, tenant = 'Steven'): Promise<void> {
  await client.query('INSERT INTO agents(tenant_id,alias) VALUES($1,$2)', [tenant, ALIAS]);
  await client.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [`human-${tenant}`, tenant]);
  await client.query('INSERT INTO memberships(tenant_id,room_id,alias) VALUES($1,$2,$3)', [tenant, `human-${tenant}`, ALIAS]);
}

export async function seedHuman(client: DatabaseClient, options: {
  tenant?: string; alias?: string; active?: boolean; role?: string;
} = {}): Promise<string> {
  const id = randomUUID();
  const email = `${id}@example.invalid`;
  await client.query(`INSERT INTO console_users
    (id,email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
    VALUES($1,$2,$2,$3,'Fixture human',$4,$5,$6,$7)`,
  [id, email, `$scrypt$${'x'.repeat(40)}`, options.role ?? 'operator', options.tenant ?? 'Steven',
    options.alias ?? ALIAS, options.active ?? true]);
  return id;
}

export async function seedMembership(client: DatabaseClient, human: string, tenant = 'Steven'): Promise<void> {
  await client.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role)
    VALUES($1,$2,$3,'reader')`, [human, tenant, ALIAS]);
}

export async function seedMessage(client: DatabaseClient, tenant = 'Steven'): Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO messages(id,request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
    VALUES($1,$2,'human-fixture',$3,$4,$5,'{}','interactive')`, [id, randomUUID(), tenant, `human-${tenant}`, ALIAS]);
  return id;
}

export const INSERT_INITIATOR = `INSERT INTO human_message_initiators
  (message_id,message_tenant_id,initiating_human_id,initiating_tenant_id,root_message_id,conversation_id)
  VALUES($1,$2,$3,'Steven',$4,$5)`;

export async function seedLineage(client: DatabaseClient): Promise<{ human: string; root: string; child: string }> {
  await seedAgent(client);
  await seedAgent(client, 'Jhon');
  const human = await seedHuman(client);
  await seedMembership(client, human);
  const root = await seedMessage(client);
  const child = await seedMessage(client, 'Jhon');
  await client.query(INSERT_INITIATOR, [root, 'Steven', human, root, 'conversation']);
  await client.query(INSERT_INITIATOR, [child, 'Jhon', human, root, 'conversation']);
  return { human, root, child };
}
