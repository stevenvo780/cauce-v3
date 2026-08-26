import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

interface Member {
  alias: string;
  registered: boolean;
  agent_enabled: boolean | null;
  off_reason: string | null;
}

interface TenantView {
  id: string;
  rooms: Array<{ id: string; members: Member[] }>;
}

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

async function seedAgent(tenantId: string, alias: string, enabled = true): Promise<void> {
  await pool.query(
    `INSERT INTO agents(
       tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory
     ) VALUES($1,$2,'codex',$3,'ws-test','dev','/home/dev','/home/dev/.cauce/test')`,
    [tenantId, alias, enabled]
  );
}

async function seedMembership(alias: string, enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO memberships(tenant_id,alias,room_id,role,enabled)
     VALUES('Steven',$1,'grp.steven','agent',$2)`,
    [alias, enabled]
  );
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(
    `DELETE FROM memberships WHERE tenant_id='Steven'
       AND alias IN ('same-alias','agent-off','both-off');
     UPDATE memberships SET enabled=true
      WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias IN ('argos','kant')`
  );
});

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

describe('topology registry facts', () => {
  it('qualifies membership identities by tenant and distinguishes every disabled state', async () => {
    await seedAgent('Steven', 'argos');
    await seedAgent('Steven', 'kant');
    await pool.query(
      `UPDATE memberships SET enabled=false
        WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias='kant'`
    );

    // Same alias in another tenant must not make Steven's membership look registered.
    await seedMembership('same-alias', true);
    await seedAgent('Miguel', 'same-alias');

    await seedMembership('agent-off', true);
    await seedAgent('Steven', 'agent-off', false);

    await seedMembership('both-off', false);
    await seedAgent('Steven', 'both-off', false);

    const snapshot = await repository.topology('Steven', 'argos');
    const tenants = snapshot.tenants as TenantView[];
    const members = tenants.find((tenant) => tenant.id === 'Steven')?.rooms
      .find((room) => room.id === 'grp.steven')?.members ?? [];
    const byAlias = new Map(members.map((member) => [member.alias, member]));

    expect(byAlias.get('argos')).toMatchObject({
      registered: true, agent_enabled: true, off_reason: null
    });
    expect(byAlias.get('kant')).toMatchObject({
      registered: true, agent_enabled: true, off_reason: 'membership_disabled'
    });
    expect(byAlias.get('agent-off')).toMatchObject({
      registered: true, agent_enabled: false, off_reason: 'agent_disabled'
    });
    expect(byAlias.get('both-off')).toMatchObject({
      registered: true, agent_enabled: false, off_reason: 'agent_and_membership_disabled'
    });
    expect(byAlias.get('same-alias')).toMatchObject({
      registered: false, agent_enabled: null, off_reason: 'not_registered'
    });
    expect(byAlias.get('quota-collector')).toMatchObject({
      registered: false, agent_enabled: null, off_reason: 'not_registered'
    });
  });
});
