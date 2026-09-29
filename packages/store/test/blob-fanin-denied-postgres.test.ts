import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';
import {
  ackEnvelope, ackWith, consumer, nextDelivery, type Consumer,
} from './helpers/consumer.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const bytes = Buffer.from('Miguel blob from atlas');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const uri = `cauce-blob:sha256:${sha256}`;

async function next(target: Consumer, type?: string): Promise<DeliveryEnvelope> {
  return nextDelivery(repository, target, type === undefined
    ? undefined : (delivery) => delivery.body.type === type);
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  if (!databaseStarted) return;
  await resetTestDatabase(pool);
  await pool.query(`
    DELETE FROM blob_delivery_grants;
    DELETE FROM blobs;
    INSERT INTO memberships(tenant_id,room_id,alias,role)
      VALUES('Miguel','grp.miguel','atlas','agent') ON CONFLICT DO NOTHING;
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter');
  `);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('fan-in blob provenance', () => {
  it('does not turn a denied kant continuation into a Miguel to Pablo grant', async () => {
    const seneca = await consumer(repository, 'Pablo', 'seneca');
    const kant = await consumer(repository, 'Steven', 'kant');
    const atlas = await consumer(repository, 'Miguel', 'atlas');
    const request: PublishMessage = {
      version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
      tenant_id: 'Pablo', room_id: 'grp.pablo', actor_alias: 'seneca',
      recipients: [{ tenant_id: 'Pablo', alias: 'seneca' }],
      body: { text: 'human request' }, idempotency_key: randomUUID(),
      lane: 'interactive', priority: 7,
    };
    await repository.publish(request);
    const root = await next(seneca);
    await ackWith(repository, seneca, root, {
      messages: [{ to: 'kant', body: 'coordinate' }], reply: 'delegated',
    });
    const kantChild = await next(kant, 'agent.message');
    await ackWith(repository, kant, kantChild, {
      messages: [{ to: 'atlas', body: 'produce the blob' }], reply: 'delegated',
    });
    const atlasChild = await next(atlas, 'agent.message');
    await repository.registerBlob({
      sha256, bytes: bytes.length, mediaType: 'text/plain', name: 'atlas.txt',
      tenantId: 'Miguel', createdBy: 'atlas',
    });
    const returned = await repository.ackDelivery(
      atlasChild.delivery_id, atlas.tenant, atlas.alias,
      ackEnvelope(atlasChild, atlas, { output: {
        messages: [], reply: 'blob ready', status: 'done', retryable: false,
        artifacts: [{ name: 'atlas.txt', uri }],
      } }),
    );
    expect(returned.applied).toBe(true);
    const toKant = await next(kant, 'agent.response');
    expect(toKant.body.artifacts_v1).toMatchObject([{ uri }]);
    expect(await repository.findBlob(sha256, 'Steven', 'kant')).toBeDefined();
    expect(await repository.findBlob(sha256, 'Pablo', 'seneca')).toBeUndefined();

    await pool.query(`
      INSERT INTO rooms(id,tenant_id) VALUES('grp.steven.extra','Steven')
        ON CONFLICT DO NOTHING;
      INSERT INTO memberships(tenant_id,room_id,alias,role)
        VALUES('Steven','grp.steven.extra','kant','agent') ON CONFLICT DO NOTHING;
    `);
    await ackWith(repository, kant, toKant, { messages: [], reply: 'no artifact forwarded' });
    expect((await pool.query(
      `SELECT 1 FROM audit_events
       WHERE action='agent_output.response' AND decision='deny'
         AND metadata->>'child_delivery_id'=$1`,
      [kantChild.delivery_id],
    )).rowCount).toBe(1);

    const fanin = await next(seneca, 'agent.fanin');
    const data = fanin.body.fanin_data_v1 as {
      responses: { alias: string; untrusted_text: string; artifacts?: { uri?: string }[] }[];
    };
    const denied = data.responses.find((response) => response.alias === 'kant');
    expect(denied?.untrusted_text).toContain('Agent response denied: source_membership_unavailable');
    expect(denied?.artifacts ?? []).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM blob_delivery_grants
       WHERE owner_tenant_id='Miguel' AND target_tenant_id='Pablo'
         AND target_alias='seneca' AND sha256=$1`,
      [sha256],
    )).rowCount).toBe(0);
    expect(await repository.findBlob(sha256, 'Pablo', 'seneca')).toBeUndefined();
  });
});
