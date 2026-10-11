import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { COMPANY_CONTEXT_CAPABILITY, DeliveryEnvelopeSchema, type PublishMessage } from '@cauce/protocol';
import { CauceRepository, CompanyContextCache, systemGatePrincipal, type DatabasePool } from '../src/index.js';
import { seedDevelopmentDatabase } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import {
  startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database);
  pool = current.pool;
  await seedDevelopmentDatabase(current.adminUrl, () => undefined);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const GATE = { tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant', principal_alias: 'gate-probe' };

function probe(overrides: Partial<PublishMessage> = {}): PublishMessage {
  const nonce = randomUUID().replaceAll('-', '');
  return {
    version: '3.0', request_id: randomUUID(), trace_id: `gate-${nonce}`,
    tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { type: 'system.gate.probe', nonce, timeout_ms: 5_000 },
    idempotency_key: `gate:Steven:argos:${nonce}`,
    authenticated_context: { session_id: 'gate-probe', channel: 'gate' },
    lane: 'interactive', priority: -100, ...overrides,
  };
}

describe('company context from data', () => {
  it('describes each recipient from its own company, with no key for a role the company lacks', async () => {
    const cache = new CompanyContextCache();
    const common = {
      company_id: 'humanizar', infra_escalation: { tenant_id: 'Steven', alias: 'zeus' },
      coordination: { tenant_id: 'Steven', alias: 'kant' }, gate_probe: GATE,
    };
    expect(await cache.read(pool, 'Steven', 'argos')).toEqual({ ...common, director: true });
    expect(await cache.read(pool, 'Steven', 'zeus')).toEqual(common);
    expect(await cache.read(pool, 'Miguel', 'kratos')).toEqual(common);
    expect(await cache.read(pool, 'Hospital', 'operador')).toEqual({
      company_id: 'praxis', director: true, human_receipt: true,
      infra_escalation: { tenant_id: 'Hospital', alias: 'operador' },
      coordination: { tenant_id: 'Hospital', alias: 'operador' },
      supervision_notice: {
        tenant_id: 'Hospital', room_id: 'grp.hospital', actor_alias: 'praxis-supervisor',
        principal_alias: 'praxis-supervisor', recipient_alias: 'operador', notify_handle: 'owner_dm',
      },
    });
    expect(await cache.read(pool, 'Hospital', 'praxis-supervisor')).not.toHaveProperty('director');
    expect(await cache.read(pool, 'Nowhere', 'ghost')).toBeUndefined();
  });

  it('serves the same facts for the whole TTL and re-reads afterwards', async () => {
    let now = 1_000;
    const cache = new CompanyContextCache(() => now, 60_000);
    expect((await cache.read(pool, 'Steven', 'zeus'))?.coordination?.alias).toBe('kant');
    if (!current) throw new Error('test database absent');
    await current.adminPool.query("UPDATE company_agent_roles SET alias='zeus' WHERE company_id='humanizar' AND role='coordination'");
    now += 59_999;
    expect((await cache.read(pool, 'Steven', 'zeus'))?.coordination?.alias).toBe('kant');
    now += 1;
    expect((await cache.read(pool, 'Steven', 'zeus'))?.coordination?.alias).toBe('zeus');
  });

  it('attaches company_context to a claim only behind the capability, as a valid strict envelope', async () => {
    const repository = new CauceRepository(pool);
    for (const [capabilities, expected] of [[[COMPANY_CONTEXT_CAPABILITY], true], [[], false]] as const) {
      const message = probe();
      await repository.publish({
        ...message, authenticated_context: undefined,
        body: { type: 'command', text: 'who directs us?' }, priority: 0,
        idempotency_key: `ctx-${randomUUID()}`,
      });
      const instance = `ctx-${String(capabilities.length)}`;
      const lease = await repository.acquireLease('Steven', 'argos', instance, [...capabilities], 60_000);
      expect(lease.acquired).toBe(true);
      const [claimed] = await repository.claimDeliveries('Steven', 'argos', instance, lease.epoch ?? 0, 1);
      expect(claimed).toBeDefined();
      expect(Object.hasOwn(claimed ?? {}, 'company_context')).toBe(expected);
      expect(DeliveryEnvelopeSchema.safeParse(claimed).success).toBe(true);
      if (expected) expect(claimed?.company_context?.director).toBe(true);
      await repository.releaseLease('Steven', 'argos', instance, lease.epoch ?? 0, lease.connection_token ?? '');
    }
  });
});

describe('system gate principal as data', () => {
  it('resolves per company and never invents one for a company without it', async () => {
    expect(await systemGatePrincipal(pool, 'Steven')).toEqual(GATE);
    expect(await systemGatePrincipal(pool, 'Miguel')).toEqual(GATE);
    expect(await systemGatePrincipal(pool, 'Hospital')).toBeUndefined();
  });

  it('publishes a probe only as the exact principal of the tenant company', async () => {
    const repository = new CauceRepository(pool);
    await expect(repository.publish(probe())).resolves.toMatchObject({ duplicate: false });
    const forged: PublishMessage[] = [
      probe({ actor_alias: 'argos' }),
      probe({ room_id: 'grp.miguel' }),
      probe({ tenant_id: 'Miguel', room_id: 'grp.miguel', actor_alias: 'kratos' }),
      probe({ tenant_id: 'Hospital', room_id: 'grp.hospital', actor_alias: 'operador',
        recipients: [{ tenant_id: 'Hospital', alias: 'operador' }] }),
    ];
    for (const message of forged) {
      const recipient = message.recipients[0];
      const body = message.body as { nonce: string };
      await expect(repository.publish({
        ...message, idempotency_key: `gate:${String(recipient?.tenant_id)}:${String(recipient?.alias)}:${body.nonce}`,
      })).rejects.toMatchObject({ code: 'forbidden' });
    }
  });
});
