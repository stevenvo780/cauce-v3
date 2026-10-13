import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QUALIFIED_PEOPLE_SQL } from '../src/configuration/control-holders.js';
import { holdsHomeControlAsOperator } from '../src/human-identity.js';
import { assertFleetHumanAuthority } from '../src/repository/fleet-operation-human.js';
import { seedDevelopmentDatabase } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

// Every production route that used to read or write human_tenant_memberships.role, exercised with
// 081 applied: the role is derived from console_users.role and the column no longer exists.
const readerId = '5f0c2b8e-61a4-4c3d-9e7f-0a1b2c3d4e5f';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let operator: { id: string; tenant_id: string; alias: string };

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database);
  await seedDevelopmentDatabase(current.adminUrl, () => undefined);
  const seeded = (await current.adminPool.query<{ id: string; tenant_id: string; alias: string }>(
    `SELECT person.id::text,person.tenant_id,person.alias FROM console_users person
      JOIN human_tenant_memberships home ON home.human_id=person.id AND home.tenant_id=person.tenant_id
     WHERE person.role='operator' AND 'control'=ANY(home.permissions) ORDER BY person.email LIMIT 1`)).rows[0];
  if (!seeded) throw new Error('the development seed wrote no operator with a home membership');
  operator = seeded;
  await current.adminPool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,'reader@derived-role.test','reader@derived-role.test',$2,'Reader','reader',$3,$4)`,
  [readerId, '$scrypt$' + 'x'.repeat(40), operator.tenant_id, operator.alias]);
  await current.adminPool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,$2,$3,ARRAY['read'])`, [readerId, operator.tenant_id, operator.alias]);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function active(): EmptyTestDatabase {
  if (!current) throw new Error('case database absent');
  return current;
}

describe('membership role derived from the console account after 081', () => {
  it('has no membership role column and the development seed writes home memberships without it', async () => {
    expect((await active().adminPool.query(`SELECT 1 FROM information_schema.columns
      WHERE table_name='human_tenant_memberships' AND column_name='role'`)).rowCount).toBe(0);
    expect((await active().adminPool.query(`SELECT 1 FROM human_tenant_memberships home JOIN console_users person
      ON person.id=home.human_id WHERE person.id=$1::uuid`, [operator.id])).rowCount).toBe(1);
  });

  it('qualifies only the operator as a control holder', async () => {
    const qualified = (await active().adminPool.query<{ id: string }>(`SELECT id::text FROM (${QUALIFIED_PEOPLE_SQL}) qualified`)).rows
      .map(row => row.id);
    expect(qualified).toContain(operator.id);
    expect(qualified).not.toContain(readerId);
  });

  it('gives fleet control and native writes to the operator and only reads to the reader', async () => {
    const client = await active().adminPool.connect();
    try {
      await client.query('BEGIN');
      await expect(assertFleetHumanAuthority(client, operator.tenant_id, operator.alias, `console:${operator.id}`)).resolves.toBeUndefined();
      await expect(assertFleetHumanAuthority(client, operator.tenant_id, operator.alias, `console:${readerId}`))
        .rejects.toThrow('fleet human authority is unavailable');
      await expect(assertFleetHumanAuthority(client, operator.tenant_id, operator.alias, `console:${readerId}`, false)).resolves.toBeUndefined();
      expect(await holdsHomeControlAsOperator(client, operator.id)).toBe(true);
      expect(await holdsHomeControlAsOperator(client, readerId)).toBe(false);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('withdraws membership authority without consulting a stored role', async () => {
    await active().adminPool.query(`UPDATE human_tenant_memberships SET permissions=ARRAY['read']
      WHERE human_id=$1::uuid AND tenant_id=$2`, [operator.id, operator.tenant_id]);
    const client = await active().adminPool.connect();
    try {
      await client.query('BEGIN');
      await expect(assertFleetHumanAuthority(client, operator.tenant_id, operator.alias, `console:${operator.id}`))
        .rejects.toThrow('fleet human membership authority is unavailable');
      expect(await holdsHomeControlAsOperator(client, operator.id)).toBe(false);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });
});
