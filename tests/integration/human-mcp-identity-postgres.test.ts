import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '@cauce/store';
import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import {
  ALIAS, INSERT_INITIATOR, VERSION, rejectsSql, rollbackFixture, seedAgent, seedHuman,
  seedLineage, seedMembership, seedMessage,
} from './human-mcp-identity-postgres.fixtures.js';

let database: TestDatabase | undefined;
let up = '';
let down = '';
const pool = (): TestDatabase['pool'] => {
  if (!database) throw new Error('PostgreSQL setup has not run');
  return database.pool;
};

preparePostgresSuite(import.meta.url, async () => {
  // 045 depends on 044 and its down refuses while 045 is recorded, so the 044 rollback first removes the empty 045.
  const [source, own, later] = await Promise.all([
    readFile(new URL(`../../packages/store/migrations/${VERSION}`, import.meta.url), 'utf8'),
    readFile(new URL(`../../packages/store/migrations/down/${VERSION}`, import.meta.url), 'utf8'),
    readFile(new URL('../../packages/store/migrations/down/045_mcp_oauth_authorization.sql', import.meta.url), 'utf8'),
  ]);
  up = source; down = `${later}\n${own}`;
  database = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  if (!database) return;
  try { await database.pool.end(); } finally { await database.container.stop(); }
});

describe('human identity migration on real PostgreSQL', () => {
  it('runs the canonical migration runner twice without changing its exact source ledger', async () => {
    await applyMigrations(pool());
    await applyMigrations(pool());
    const result = await pool().query('SELECT source_sha256 FROM schema_migration_ledger WHERE version=$1', [VERSION]);
    expect(result.rows).toEqual([{ source_sha256: createHash('sha256').update(up).digest('hex') }]);
  });

  it('round-trips empty down/up and rolls the entire down back without touching baseline data', async () => {
    await rollbackFixture(pool(), async (client) => {
      const before = await client.query('SELECT * FROM tenants ORDER BY id');
      await client.query('SAVEPOINT before_down');
      await client.query(down);
      expect((await client.query<{ name: string | null }>("SELECT to_regclass('human_tenant_memberships') AS name")).rows[0]?.name).toBeNull();
      await client.query('ROLLBACK TO SAVEPOINT before_down');
      expect((await client.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations WHERE version=$1', [VERSION])).rows[0]?.n).toBe(1);
      await client.query(down);
      await client.query(up);
      expect((await client.query('SELECT * FROM tenants ORDER BY id')).rows).toEqual(before.rows);
    });
  });

  it('backfills both roles and inactive accounts while leaving bindings and historic initiators unknown', async () => {
    await rollbackFixture(pool(), async (client) => {
      await client.query(down);
      await seedAgent(client);
      const active = await seedHuman(client);
      const inactive = await seedHuman(client, { active: false, role: 'reader' });
      await seedMessage(client);
      await client.query(up);
      const rows = (await client.query<{ human_id: string; revoked_at: Date | null }>('SELECT human_id,actor_alias,role,permissions,enabled,revoked_at FROM human_tenant_memberships')).rows;
      expect(rows.find(row => row.human_id === active)).toMatchObject({ actor_alias: ALIAS, role: 'operator',
        permissions: ['route', 'read', 'control', 'notify'], enabled: true, revoked_at: null });
      expect(rows.find(row => row.human_id === inactive)).toMatchObject({ role: 'reader', permissions: ['read'], enabled: false });
      expect(rows.find(row => row.human_id === inactive)?.revoked_at).not.toBeNull();
      for (const table of ['human_external_identities', 'human_message_initiators']) {
        expect((await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n).toBe(0);
      }
    });
  });

  it('fails the actual runner on a missing legacy alias and rolls back DDL plus both ledgers', async () => {
    const client = await pool().connect();
    let human: string | undefined;
    try {
      await client.query('BEGIN');
      await client.query(down);
      human = await seedHuman(client, { alias: 'missing_human_agent' });
      await client.query('COMMIT');
      await expect(applyMigrations(pool())).rejects.toMatchObject({
        message: 'human identity backfill requires existing agents',
        detail: `human_id=${human} tenant_id=Steven alias=missing_human_agent`,
      });
      for (const name of ['human_external_identities', 'human_tenant_memberships', 'human_message_initiators', 'messages_id_tenant_identity_idx']) {
        expect((await client.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [name])).rows[0]?.name).toBeNull();
      }
      for (const table of ['schema_migrations', 'schema_migration_ledger']) {
        expect((await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE version=$1`, [VERSION])).rows[0]?.n).toBe(0);
      }
    } finally {
      await client.query('ROLLBACK');
      if (human) await client.query('DELETE FROM console_users WHERE id=$1', [human]);
      client.release();
      await applyMigrations(pool());
    }
  });

  it('keeps exact external keys unique after revocation and prevents reassignment or deletion', async () => {
    await rollbackFixture(pool(), async (client) => {
      await seedAgent(client);
      const a = await seedHuman(client);
      const b = await seedHuman(client);
      await seedMembership(client, a);
      await seedMembership(client, b);
      const insert = `INSERT INTO human_external_identities(human_id,provider,namespace,subject)
        VALUES($1,'oauth',$2,$3) RETURNING id`;
      const id = (await client.query<{ id: string }>(insert, [a, 'https://issuer.invalid', 'opaque:Subject'])).rows[0]?.id;
      await client.query(insert, [b, 'https://issuer.invalid/', 'opaque:Subject']);
      await client.query(insert, [b, 'https://issuer.invalid', 'opaque:subject']);
      await client.query('UPDATE human_external_identities SET enabled=false,revoked_at=now(),revision=revision+1 WHERE id=$1', [id]);
      await rejectsSql(client, insert, [b, 'https://issuer.invalid', 'opaque:Subject'], '23505');
      await rejectsSql(client, 'UPDATE human_external_identities SET human_id=$1 WHERE id=$2', [b, id], 'P0001');
      await rejectsSql(client, 'UPDATE human_external_identities SET id=$1 WHERE id=$2', [randomUUID(), id], 'P0001');
      await rejectsSql(client, 'DELETE FROM human_external_identities WHERE id=$1', [id], 'P0001');
      await rejectsSql(client, insert, [randomUUID(), 'https://issuer.invalid', 'unknown'], '23503');
    });
  });

  it('enforces one alias per human and tenant, permission vocabulary and preserved membership keys', async () => {
    await rollbackFixture(pool(), async (client) => {
      await seedAgent(client);
      await seedAgent(client, 'Jhon');
      const human = await seedHuman(client);
      await seedMembership(client, human);
      await seedMembership(client, human, 'Jhon');
      await rejectsSql(client, `INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role)
        VALUES($1,'Steven',$2,'reader')`, [human, ALIAS], '23505');
      for (const permissions of [['route'], ['unknown'], [null]]) {
        await rejectsSql(client, 'UPDATE human_tenant_memberships SET permissions=$1 WHERE human_id=$2', [permissions, human], '23514');
      }
      await rejectsSql(client, 'UPDATE human_tenant_memberships SET human_id=$1 WHERE human_id=$2', [randomUUID(), human], 'P0001');
      await rejectsSql(client, 'DELETE FROM human_tenant_memberships WHERE human_id=$1', [human], 'P0001');
      await rejectsSql(client, down, [], 'P0001');
    });
  });

  it('supports explicit guarded revision updates without claiming automatic CAS or audit', async () => {
    await rollbackFixture(pool(), async (client) => {
      await seedAgent(client);
      const human = await seedHuman(client);
      await seedMembership(client, human);
      const update = `UPDATE human_tenant_memberships SET enabled=false,revoked_at=now(),revision=revision+1
        WHERE human_id=$1 AND tenant_id='Steven' AND revision=1 RETURNING revision`;
      expect((await client.query(update, [human])).rowCount).toBe(1);
      expect((await client.query(update, [human])).rowCount).toBe(0);
      expect((await client.query('UPDATE human_tenant_memberships SET role=role WHERE human_id=$1', [human])).rowCount).toBe(1);
    });
  });

  it('ties a cross-tenant child and replay to the canonical self-root and conversation without adding authority', async () => {
    await rollbackFixture(pool(), async (client) => {
      const { human, root, child } = await seedLineage(client);
      const sibling = await seedMessage(client, 'Jhon');
      await client.query(INSERT_INITIATOR, [sibling, 'Jhon', human, root, 'conversation']);
      expect((await client.query('SELECT tenant_id FROM human_tenant_memberships WHERE human_id=$1', [human])).rows).toEqual([{ tenant_id: 'Steven' }]);
      await rejectsSql(client, INSERT_INITIATOR, [child, 'Jhon', human, root, 'conversation'], '23505');
      await rejectsSql(client, 'UPDATE human_message_initiators SET conversation_id=$1 WHERE message_id=$2', ['other', child], 'P0001');
      await rejectsSql(client, 'DELETE FROM human_message_initiators WHERE message_id=$1', [child], 'P0001');
      await rejectsSql(client, 'DELETE FROM messages WHERE id=$1', [child], '23503');
      const next = await seedMessage(client, 'Jhon');
      await rejectsSql(client, INSERT_INITIATOR, [next, 'Jhon', human, child, 'conversation'], '23503');
      await rejectsSql(client, INSERT_INITIATOR, [next, 'Jhon', human, root, 'other'], '23503');
      await rejectsSql(client, INSERT_INITIATOR, [next, 'Steven', human, root, 'conversation'], '23503');
      const other = await seedHuman(client);
      await seedMembership(client, other);
      await rejectsSql(client, INSERT_INITIATOR, [next, 'Jhon', other, root, 'conversation'], '23503');
      await rejectsSql(client, INSERT_INITIATOR, [next, 'Jhon', human, next, 'conversation'], '23514');
      await client.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1', [human]);
      await client.query(INSERT_INITIATOR, [next, 'Jhon', human, root, 'conversation']);
      expect((await client.query<{ n: number }>('SELECT count(*)::int AS n FROM human_message_initiators WHERE root_message_id=$1', [root])).rows[0]?.n).toBe(4);
    });
  });

  it('rolls back a newly inserted message and initiator in the same transaction scope', async () => {
    await rollbackFixture(pool(), async (client) => {
      const { human, root } = await seedLineage(client);
      await client.query('SAVEPOINT publication');
      const message = await seedMessage(client);
      await client.query(INSERT_INITIATOR, [message, 'Steven', human, root, 'conversation']);
      await client.query('ROLLBACK TO SAVEPOINT publication');
      expect((await client.query('SELECT id FROM messages WHERE id=$1', [message])).rows).toEqual([]);
      expect((await client.query('SELECT message_id FROM human_message_initiators WHERE message_id=$1', [message])).rows).toEqual([]);
    });
  });
});
