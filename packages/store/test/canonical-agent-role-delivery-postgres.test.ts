import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublishMessage } from '@cauce/protocol';
import { AgentProfileRepository, CauceRepository, type DatabasePool } from '../src/index.js';
import { requireValue } from './helpers.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

/**
 * Contract 028 on the delivery path, against the current schema. The migration round trips stay in
 * canonical-agent-role-postgres.test.ts, pinned to an older schema the current runtime cannot route on.
 */
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
const ACTOR = { tenant_id: 'Steven', alias: 'kant' } as const;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool;
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function insertAgent(tenant: string, alias: string): Promise<void> {
  await pool.query(
    `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
     VALUES ($1,$2,'codex',$2,true,'ws-' || $1 || '-' || $2,'dev','/home/dev','/home/dev/.cauce')`,
    [tenant, alias],
  );
}

describe('delivery context real', () => {
  it('deriva self_role del mismo perfil rico que se entrega en hello, sin confiar en la caché', async () => {
    await insertAgent('Steven', 'argos');
    const rich = `${'r'.repeat(1_199)}🎉${'detalle'.repeat(20)}`;
    const profiles = new AgentProfileRepository(pool);
    await profiles.replace(
      { tenant_id: 'Steven', alias: 'argos', role_summary: rich }, null, ACTOR,
    );

    // Deliberate damage to the projection, with triggers disabled only during this statement. The
    // correct claim must still come from the profile and not from this cache.
    await pool.query('ALTER TABLE agents DISABLE TRIGGER agents_translate_legacy_role');
    try {
      await pool.query(
        `UPDATE agents SET role_brief='caché dañada'
          WHERE tenant_id='Steven' AND alias='argos'`,
      );
    } finally {
      await pool.query('ALTER TABLE agents ENABLE TRIGGER agents_translate_legacy_role');
    }

    const repository = new CauceRepository(pool);
    const instance = `identity-${randomUUID()}`;
    const lease = await repository.acquireLease(
      'Steven', 'argos', instance, ['agent_identity_v1', 'agent_profile_v1'], 30_000,
    );
    const message: PublishMessage = {
      version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
      tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      body: { text: 'comprueba tu identidad' }, idempotency_key: randomUUID(),
      lane: 'interactive', priority: 0,
    };
    await repository.publish(message);
    const [delivery] = await repository.claimDeliveries(
      'Steven', 'argos', instance, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000,
    );

    expect(delivery).toBeDefined();
    expect(Array.from(delivery?.self_role ?? '')).toHaveLength(1_200);
    expect(delivery?.self_role?.endsWith('🎉')).toBe(true);
    expect(delivery?.self_role).not.toBe('caché dañada');
    expect((await profiles.readContext('Steven', 'argos')).perfil.role_summary).toBe(rich);
  });
});
