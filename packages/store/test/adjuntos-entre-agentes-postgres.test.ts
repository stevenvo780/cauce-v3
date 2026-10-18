import { preparePostgresSuite } from './postgres-suite.js';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { AttachmentsV1Schema, MAX_ATTACHMENTS_PER_MESSAGE } from '@cauce/protocol';
import {
  CauceRepository, DEFAULT_ACK_DEADLINE_MS, type AckResult, type DatabasePool
} from '../src/index.js';
import { agentFaninMaxAggregateBytes } from '../src/repository/agents/fanin/helpers.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import {
  ackEnvelope, ackWith as applyTerminalAck, consumer as leaseConsumer, nextDelivery as claimNext,
  type Consumer
} from './helpers/consumer.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'adjuntos entre agentes' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    ...overrides
  };
}

const consumer = (tenant: Tenant, alias: string): Promise<Consumer> =>
  leaseConsumer(repository, tenant, alias);

const nextDelivery = (
  target: Consumer, predicate?: (delivery: DeliveryEnvelope) => boolean
): Promise<DeliveryEnvelope> => claimNext(repository, target, predicate);

const ackWith = async (
  target: Consumer, delivery: DeliveryEnvelope, messages: unknown[],
  reply: string | null = 'done'
): Promise<AckResult> =>
  applyTerminalAck(repository, target, delivery, { messages, reply });

const artifactAck = (
  delivery: DeliveryEnvelope, target: Consumer, artifacts: unknown[], reply: string
): Ack => ackEnvelope(
  delivery, target,
  { output: { reply, messages: [], status: 'done', retryable: false, artifacts } }
);

const ackWithArtifacts = async (
  target: Consumer, delivery: DeliveryEnvelope, artifacts: unknown[], reply: string
): Promise<void> => {
  const result = await repository.ackDelivery(
    delivery.delivery_id, target.tenant, target.alias,
    artifactAck(delivery, target, artifacts, reply)
  );
  expect(result.applied).toBe(true);
};

function payload(size: number, seed: number): Buffer {
  return Buffer.alloc(size, seed);
}

function dataUri(mediaType: string, bytes: Buffer): string {
  return `data:${mediaType};base64,${bytes.toString('base64')}`;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const informe = payload(2048, 0x25);

const attachmentsOf = (delivery: DeliveryEnvelope): Record<string, unknown>[] => {
  const value = delivery.body.attachments_v1;
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
};

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

describe('the delegation edge transports files', () => {
  it('materializes a child whose attachments_v1 keeps the original bytes', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: 'socrates',
      body: 'mira esto',
      artifacts: [{ name: 'informe.pdf', uri: dataUri('application/pdf', informe) }]
    }]);

    const child = await nextDelivery(socrates);
    expect(child.body.text).toBe('mira esto');
    const attachments = attachmentsOf(child);
    expect(AttachmentsV1Schema.safeParse(attachments).success).toBe(true);
    expect(attachments).toEqual([{
      kind: 'document',
      name: 'informe.pdf',
      mime_type: 'application/pdf',
      file_size: informe.length,
      sha256: digest(informe),
      content_base64: informe.toString('base64')
    }]);
    expect(child.body.attachments_note).toBeUndefined();
  });
});

describe('degradation when the bytes do not fit', () => {

  it('drops the artifact that would break the aggregate budget', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const primero = payload(6_000_000, 0x41);
    const segundo = payload(6_000_000, 0x42);
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: 'socrates',
      body: 'dos ficheros grandes',
      artifacts: [
        { name: 'uno.bin', uri: dataUri('application/octet-stream', primero) },
        { name: 'dos.bin', uri: dataUri('application/octet-stream', segundo) }
      ]
    }]);

    const child = await nextDelivery(socrates);
    const attachments = attachmentsOf(child);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: 'uno.bin', sha256: digest(primero) });
    expect(child.body.attachments_note)
      .toBe('1 adjunto(s) no viajaron: exceden el cupo del mensaje');
  }, 180_000);
});

describe('the return hop carries references, never bytes', () => {
  it('publishes artifacts_v1 refs on the agent.response and no base64', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'trabaja' }]);
    const child = await nextDelivery(socrates);

    await ackWithArtifacts(socrates, child, [{
      name: 'resultado.pdf',
      uri: dataUri('application/pdf', informe),
      media_type: 'application/pdf',
      sha256: digest(informe)
    }], 'ahi va');

    const response = await nextDelivery(argos, (item) => item.body.type === 'agent.response');
    expect(response.body.artifacts_v1).toEqual([{
      name: 'resultado.pdf',
      media_type: 'application/pdf',
      sha256: digest(informe),
      size: informe.length
    }]);
    const rendered = JSON.stringify(response.body);
    expect(rendered).not.toContain('content_base64');
    expect(rendered).not.toContain(informe.toString('base64'));
  });
});

describe('fan-in lists the references of every branch', () => {
  it('carries one ref set per branch inside the aggregate budget', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    const seneca = await consumer('Pablo', 'seneca');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [
      { to: 'socrates', body: 'rama uno' },
      { to: 'jarvis', body: 'rama dos' },
      { to: 'seneca', body: 'rama tres' }
    ]);

    for (const branch of [socrates, jarvis, seneca]) {
      const delivery = await nextDelivery(branch);
      await ackWithArtifacts(branch, delivery, [{
        name: `${branch.alias}.pdf`,
        uri: dataUri('application/pdf', informe),
        sha256: digest(informe)
      }], `${branch.alias} termino`);
    }
    const responses = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 10, DEFAULT_ACK_DEADLINE_MS
    );
    expect(responses.filter((item) => item.body.type === 'agent.response')).toHaveLength(3);
    for (const response of responses) {
      await ackWith(argos, response, []);
    }

    const fanin = await nextDelivery(argos, (item) => item.body.type === 'agent.fanin');
    const data = fanin.body.fanin_data_v1 as { responses: Record<string, unknown>[] };
    expect(data.responses).toHaveLength(3);
    for (const response of data.responses) {
      expect(response.artifacts).toEqual([{
        name: `${String(response.alias)}.pdf`,
        media_type: 'application/pdf',
        declared_sha256: digest(informe),
        size: informe.length
      }]);
    }
    const rendered = JSON.stringify(fanin.body);
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(agentFaninMaxAggregateBytes);
    expect(rendered).not.toContain('content_base64');
  });
});

describe('a broadcast never loses its text over a file', () => {
  it('delivers to every target and drops the artifacts that do not fit the fan-out', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    const grande = payload(300_000, 0x33);
    await repository.publish(command());
    const root = await nextDelivery(argos);

    const result = await ackWith(argos, root, [{
      to: '@all',
      body: 'para todos',
      artifacts: [{ name: 'grande.bin', uri: dataUri('application/octet-stream', grande) }]
    }]);

    expect(result.delegation_rejections).toBeUndefined();
    expect(result.delegation_materializations).toHaveLength(2);
    for (const branch of [socrates, jarvis]) {
      const child = await nextDelivery(branch);
      expect(child.body.text).toBe('para todos');
      expect(child.body.attachments_v1).toBeUndefined();
      expect(child.body.attachments_note)
        .toBe('1 adjunto(s) no viajaron: no caben en la difusión a toda la flota');
    }
  }, 180_000);
});

describe('the digest of what travels is the digest of what travels', () => {
  it('overwrites a false sha256 on both hops', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: 'socrates',
      body: 'con firma falsa',
      artifacts: [{
        name: 'informe.pdf', uri: dataUri('application/pdf', informe), sha256: 'f'.repeat(64)
      }]
    }]);

    const child = await nextDelivery(socrates);
    expect(attachmentsOf(child)[0]).toMatchObject({ sha256: digest(informe) });
    expect(JSON.stringify(child.body)).not.toContain('f'.repeat(64));

    await ackWithArtifacts(socrates, child, [{
      name: 'resultado.pdf', uri: dataUri('application/pdf', informe), sha256: '0'.repeat(64)
    }], 'ahi va');

    const response = await nextDelivery(argos, (item) => item.body.type === 'agent.response');
    expect(response.body.artifacts_v1).toEqual([{
      name: 'resultado.pdf',
      media_type: 'application/pdf',
      sha256: digest(informe),
      size: informe.length
    }]);
  });
});

describe('an agent output is never a legitimate secret carrier', () => {
  it('redacts a token out of the delegated text and out of the attachment name', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const token = 'abc123DEF456ghi789';
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: 'socrates',
      body: `entra con Bearer ${token} y avisa`,
      artifacts: [{
        name: 'ghp_ABCdef0123456789ABCdef0123456789.txt',
        uri: dataUri('text/plain', payload(64, 3))
      }]
    }]);

    const child = await nextDelivery(socrates);
    const rendered = JSON.stringify(child.body);
    expect(child.body.text).toBe('entra con Bearer [secreto-redactado] y avisa');
    expect(rendered).not.toContain(token);
    expect(attachmentsOf(child)[0]).toMatchObject({ name: '[secreto-redactado].txt' });
  });
});

describe('a locator is a link, never a payload', () => {
  it('returns bounded references when a branch answers with multi-megabyte locators', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'trabaja' }]);
    const child = await nextDelivery(socrates);

    await ackWithArtifacts(socrates, child, [1, 2, 3, 4, 5].map((index) => ({
      name: `parte-${String(index)}.pdf`,
      uri: `https://ejemplo.invalid/${String(index)}/${'a'.repeat(300_000)}`,
      sha256: digest(informe)
    })), 'ahi van');

    const response = await nextDelivery(argos, (item) => item.body.type === 'agent.response');
    const refs = response.body.artifacts_v1 as Record<string, unknown>[];
    expect(refs).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(refs.every((ref) => ref.uri === undefined)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response.body), 'utf8'))
      .toBeLessThan(agentFaninMaxAggregateBytes);
  }, 180_000);
});
