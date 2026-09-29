import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, DEFAULT_ACK_DEADLINE_MS, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';
import {
  ackEnvelope, ackWith as applyTerminalAck, consumer as leaseConsumer, nextDelivery as claimNext,
  type Consumer,
} from './helpers/consumer.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const BYTES = Buffer.from('blob sintético compartido');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const URI = `cauce-blob:sha256:${SHA}`;
const UNKNOWN_URI = `cauce-blob:sha256:${'f'.repeat(64)}`;

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'entrega sintética' }, idempotency_key: randomUUID(),
    lane: 'interactive', priority: 7, ...overrides,
  };
}

async function consumer(tenant: Tenant, alias: string): Promise<Consumer> {
  return leaseConsumer(repository, tenant, alias);
}

async function next(target: Consumer, type?: string): Promise<DeliveryEnvelope> {
  return claimNext(repository, target, type === undefined ? undefined : (item) => item.body.type === type);
}

async function register(tenantId: string, createdBy: string): Promise<void> {
  await repository.registerBlob({
    sha256: SHA, bytes: BYTES.length, mediaType: 'text/plain', name: 'sintetico.txt',
    tenantId, createdBy,
  });
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
    INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES
      ('Miguel','grp.miguel','atlas','agent'),('Miguel','grp.miguel','janus','agent')
    ON CONFLICT DO NOTHING;
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

describe('blob references follow only authorized deliveries', () => {
  it('grants a directly published reference to its exact cross-tenant recipient', async () => {
    await register('Steven', 'kant');
    expect(await repository.findBlob(SHA, 'Pablo', 'seneca')).toBeUndefined();
    const receipt = await repository.publish(command({
      recipients: [{ tenant_id: 'Pablo', alias: 'seneca' }],
      body: { text: 'archivo', artifacts_v1: [{ name: 'sintetico.txt', uri: URI }] },
    }));
    expect(receipt.delivery_ids).toHaveLength(1);
    expect(await repository.findBlob(SHA, 'Pablo', 'seneca')).toMatchObject({ sha256: SHA });
    expect(await repository.findBlob(SHA, 'Pablo', 'midas')).toBeUndefined();
    const grants = await pool.query<{ delivery_id: string }>(
      `SELECT delivery_id FROM blob_delivery_grants WHERE target_tenant_id='Pablo' AND target_alias='seneca'`,
    );
    expect(grants.rows.map((row) => row.delivery_id)).toEqual(receipt.delivery_ids);
  });

  it('rejects an unowned direct reference without publishing a message or grant', async () => {
    await expect(repository.publish(command({
      recipients: [{ tenant_id: 'Pablo', alias: 'seneca' }],
      body: { text: 'ref inventada', artifacts_v1: [{ name: 'ajeno.txt', uri: UNKNOWN_URI }] },
    }))).rejects.toMatchObject({ code: 'forbidden' });
    const state = await pool.query<{ messages: string; grants: string; keys: string }>(`
      SELECT (SELECT count(*)::text FROM messages) AS messages,
             (SELECT count(*)::text FROM blob_delivery_grants) AS grants,
             (SELECT count(*)::text FROM idempotency_keys) AS keys
    `);
    expect(state.rows[0]).toEqual({ messages: '0', grants: '0', keys: '0' });
  });

  it('does not grant a real blob when the cross-tenant route is denied', async () => {
    await register('Steven', 'kant');
    await pool.query(`UPDATE acl_edges SET allow_route=false WHERE from_tenant='Steven' AND to_tenant='Pablo'`);
    await expect(repository.publish(command({
      recipients: [{ tenant_id: 'Pablo', alias: 'seneca' }],
      body: { text: 'ruta denegada', artifacts_v1: [{ name: 'sintetico.txt', uri: URI }] },
    }))).rejects.toThrow();
    expect((await pool.query('SELECT 1 FROM blob_delivery_grants')).rowCount).toBe(0);
    expect(await repository.findBlob(SHA, 'Pablo', 'seneca')).toBeUndefined();
  });

  it('grants a delegated reference and a reverse response without exposing other aliases', async () => {
    await register('Steven', 'argos');
    const argos = await consumer('Steven', 'argos');
    const seneca = await consumer('Pablo', 'seneca');
    await repository.publish(command());
    const root = await next(argos);
    const delegated = await applyTerminalAck(repository, argos, root, {
      messages: [{ to: 'seneca', body: 'revisa', artifacts: [{ name: 'sintetico.txt', uri: URI }] }],
      reply: 'delegado',
    });
    expect(delegated.applied).toBe(true);
    const child = await next(seneca, 'agent.message');
    expect(child.body.artifacts_v1).toMatchObject([{ uri: URI }]);
    expect(await repository.findBlob(SHA, 'Pablo', 'seneca')).toBeDefined();
    expect(await repository.findBlob(SHA, 'Pablo', 'midas')).toBeUndefined();

    const otherBytes = Buffer.from('respuesta sintética');
    const otherSha = createHash('sha256').update(otherBytes).digest('hex');
    await repository.registerBlob({
      sha256: otherSha, bytes: otherBytes.length, mediaType: 'text/plain',
      name: 'respuesta.txt', tenantId: 'Pablo', createdBy: 'seneca',
    });
    const returned = await repository.ackDelivery(
      child.delivery_id, seneca.tenant, seneca.alias,
      ackEnvelope(child, seneca, { output: {
        messages: [], reply: 'resultado', status: 'done', retryable: false,
        artifacts: [{ name: 'respuesta.txt', uri: `cauce-blob:sha256:${otherSha}` }],
      } }),
    );
    expect(returned.applied).toBe(true);
    const response = await next(argos, 'agent.response');
    expect(response.body.artifacts_v1).toMatchObject([{ uri: `cauce-blob:sha256:${otherSha}` }]);
    expect(await repository.findBlob(otherSha, 'Steven', 'argos')).toBeDefined();
    expect(await repository.findBlob(otherSha, 'Steven', 'kant')).toBeUndefined();
  });

  it('grants only a retained nested branch artifact to the root coordinator at fan-in', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const seneca = await consumer('Pablo', 'seneca');
    await repository.publish(command());
    const root = await next(argos);
    await applyTerminalAck(repository, argos, root, {
      messages: [{ to: 'socrates', body: 'coordina la rama' }], reply: 'delegado',
    });
    const intermediate = await next(socrates, 'agent.message');
    await applyTerminalAck(repository, socrates, intermediate, {
      messages: [{ to: 'seneca', body: 'produce el archivo' }], reply: 'delegado',
    });
    const nested = await next(seneca, 'agent.message');
    await register('Pablo', 'seneca');
    const returned = await repository.ackDelivery(
      nested.delivery_id, seneca.tenant, seneca.alias,
      ackEnvelope(nested, seneca, { output: {
        messages: [], reply: 'archivo listo', status: 'done', retryable: false,
        artifacts: [{ name: 'sintetico.txt', uri: URI }],
      } }),
    );
    expect(returned.applied).toBe(true);
    const toIntermediate = await next(socrates, 'agent.response');
    expect(await repository.findBlob(SHA, 'Steven', 'socrates')).toBeDefined();
    expect(await repository.findBlob(SHA, 'Steven', 'argos')).toBeUndefined();
    await applyTerminalAck(repository, socrates, toIntermediate, {
      messages: [], reply: 'rama revisada sin reenviar el archivo',
    });
    const toRoot = await next(argos, 'agent.response');
    await applyTerminalAck(repository, argos, toRoot, { messages: [], reply: 'revisado' });
    const fanin = await next(argos, 'agent.fanin');
    const data = fanin.body.fanin_data_v1 as { responses: { alias: string; artifacts?: { uri?: string }[] }[] };
    expect(data.responses.find((entry) => entry.alias === 'seneca')?.artifacts).toMatchObject([{ uri: URI }]);
    expect(await repository.findBlob(SHA, 'Steven', 'argos')).toBeDefined();
    expect(await repository.findBlob(SHA, 'Steven', 'kant')).toBeUndefined();
  });

  it('withholds a nested blob reference when its source cannot route to the root tenant', async () => {
    const atlas = await consumer('Miguel', 'atlas');
    const kant = await consumer('Steven', 'kant');
    const seneca = await consumer('Pablo', 'seneca');
    await repository.publish(command({
      tenant_id: 'Miguel', room_id: 'grp.miguel', actor_alias: 'janus',
      recipients: [{ tenant_id: 'Miguel', alias: 'atlas' }],
    }));
    const root = await next(atlas);
    await applyTerminalAck(repository, atlas, root, {
      messages: [{ to: 'kant', body: 'coordina' }], reply: 'delegado',
    });
    const intermediate = await next(kant, 'agent.message');
    await applyTerminalAck(repository, kant, intermediate, {
      messages: [{ to: 'seneca', body: 'produce' }], reply: 'delegado',
    });
    const nested = await next(seneca, 'agent.message');
    await register('Pablo', 'seneca');
    await repository.ackDelivery(
      nested.delivery_id, seneca.tenant, seneca.alias,
      ackEnvelope(nested, seneca, { output: {
        messages: [], reply: 'archivo listo', status: 'done', retryable: false,
        artifacts: [{ name: 'sintetico.txt', uri: URI }],
      } }),
    );
    const toIntermediate = await next(kant, 'agent.response');
    await applyTerminalAck(repository, kant, toIntermediate, { messages: [], reply: 'sin archivo' });
    const toRoot = await next(atlas, 'agent.response');
    await applyTerminalAck(repository, atlas, toRoot, { messages: [], reply: 'revisado' });
    const fanin = await next(atlas, 'agent.fanin');
    const data = fanin.body.fanin_data_v1 as { responses: { alias: string; artifacts?: { uri?: string }[] }[] };
    expect(data.responses.find((entry) => entry.alias === 'seneca')?.artifacts ?? []).toEqual([]);
    expect(await repository.findBlob(SHA, 'Miguel', 'atlas')).toBeUndefined();
    const audit = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM audit_events
      WHERE action='agent_output.fanin' AND metadata->>'withheld_blob_refs'='1'
    `);
    expect(audit.rows[0]?.count).toBe('1');
  });

  it('keeps both branch references when distinct aliases return the same digest', async () => {
    const argos = await consumer('Steven', 'argos');
    const seneca = await consumer('Pablo', 'seneca');
    const atlas = await consumer('Miguel', 'atlas');
    await repository.publish(command());
    const root = await next(argos);
    await applyTerminalAck(repository, argos, root, {
      messages: [
        { to: 'seneca', body: 'rama Pablo' },
        { to: 'atlas', body: 'rama Miguel' },
      ],
      reply: 'delegado',
    });
    await register('Pablo', 'seneca');
    await register('Miguel', 'atlas');
    for (const target of [seneca, atlas]) {
      const child = await next(target, 'agent.message');
      const result = await repository.ackDelivery(
        child.delivery_id, target.tenant, target.alias,
        ackEnvelope(child, target, { output: {
          messages: [], reply: `${target.alias} terminó`, status: 'done', retryable: false,
          artifacts: [{ name: `${target.alias}.txt`, uri: URI }],
        } }),
      );
      expect(result.applied).toBe(true);
    }
    const responses = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 10, DEFAULT_ACK_DEADLINE_MS,
    );
    expect(responses.filter((response) => response.body.type === 'agent.response')).toHaveLength(2);
    for (const response of responses) {
      await applyTerminalAck(repository, argos, response, { messages: [], reply: 'revisado' });
    }
    const fanin = await next(argos, 'agent.fanin');
    const data = fanin.body.fanin_data_v1 as { responses: { alias: string; artifacts?: { uri?: string }[] }[] };
    expect(data.responses.filter((response) =>
      (response.alias === 'seneca' || response.alias === 'atlas')
      && response.artifacts?.[0]?.uri === URI)).toHaveLength(2);
    expect(await repository.findBlob(SHA, 'Steven', 'argos')).toBeDefined();
    const grants = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM blob_delivery_grants WHERE delivery_id=$1 AND sha256=$2`,
      [fanin.delivery_id, SHA],
    );
    expect(grants.rows[0]?.count).toBe('1');
  });

  it('drops a forged delegated reference while delivering the text and terminal ACK', async () => {
    const argos = await consumer('Steven', 'argos');
    const seneca = await consumer('Pablo', 'seneca');
    await repository.publish(command());
    const root = await next(argos);
    const ack = await applyTerminalAck(repository, argos, root, {
      messages: [{ to: 'seneca', body: 'ref ajena', artifacts: [{ name: 'ajeno.txt', uri: UNKNOWN_URI }] }],
      reply: 'delegado',
    });
    expect(ack.applied).toBe(true);
    const child = await next(seneca, 'agent.message');
    expect(child.body.text).toBe('ref ajena');
    expect(child.body.artifacts_v1).toBeUndefined();
    expect(child.body.attachments_note).toMatch(/blob no viajaron: emisor sin acceso/u);
    const state = await pool.query<{ grants: string; children: string }>(`
      SELECT (SELECT count(*)::text FROM blob_delivery_grants) AS grants,
             (SELECT count(*)::text FROM messages WHERE body->>'type'='agent.message') AS children
    `);
    expect(state.rows[0]).toEqual({ grants: '0', children: '1' });
  });

  it('drops a forged result artifact without poisoning the child ACK', async () => {
    const argos = await consumer('Steven', 'argos');
    const seneca = await consumer('Pablo', 'seneca');
    await repository.publish(command());
    const root = await next(argos);
    await applyTerminalAck(repository, argos, root, {
      messages: [{ to: 'seneca', body: 'responde' }], reply: 'delegado',
    });
    const child = await next(seneca, 'agent.message');
    const ack = await repository.ackDelivery(
      child.delivery_id, seneca.tenant, seneca.alias,
      ackEnvelope(child, seneca, { output: {
        messages: [], reply: 'resultado válido', status: 'done', retryable: false,
        artifacts: [{ name: 'ajeno.txt', uri: UNKNOWN_URI }],
      } }),
    );
    expect(ack.applied).toBe(true);
    const response = await next(argos, 'agent.response');
    expect(response.body.artifacts_v1).toBeUndefined();
    expect(response.body.text).toMatch(/referencia\(s\) blob no viajaron: emisor sin acceso/u);
    expect((await pool.query('SELECT 1 FROM blob_delivery_grants')).rowCount).toBe(0);
  });
});
