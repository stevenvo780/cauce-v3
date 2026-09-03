import { preparePostgresSuite } from './postgres-suite.js';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { AttachmentsV1Schema, MAX_ATTACHMENTS_PER_MESSAGE } from '@cauce/protocol';
import {
  CauceRepository, DEFAULT_ACK_DEADLINE_MS, type AckResult, type DatabasePool
} from '../src/index.js';
import {
  artifactRefs, attachmentsFromArtifacts, declaredArtifactBudget
} from '../src/repository/agents/delegated-attachments.js';
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

const PURE = 'artifact references without a database';

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
const INFORME_BASE64 = informe.toString('base64');
const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

/** Caso, URI y el tipo con el que viaja: el declarado, o el de por defecto si no hay ninguno. */
const FORMAS_QUE_EL_EGRESO_SUBE: readonly (readonly [string, string, string])[] = [
  ['canonical', dataUri('application/pdf', informe), 'application/pdf'],
  [
    'base64 wrapped in lines',
    `data:application/pdf;base64,${INFORME_BASE64.slice(0, 12)}\n${INFORME_BASE64.slice(12)}`,
    'application/pdf'
  ],
  ['no media type', `data:;base64,${INFORME_BASE64}`, DEFAULT_MEDIA_TYPE],
  ['an uppercase scheme', `DATA:application/pdf;base64,${INFORME_BASE64}`, 'application/pdf'],
  [
    'a charset before base64',
    `data:application/pdf;charset=utf-8;base64,${INFORME_BASE64}`, 'application/pdf'
  ],
  ['BASE64 in caps', `data:application/pdf;BASE64,${INFORME_BASE64}`, 'application/pdf'],
  [
    'base64 in the middle',
    `data:application/pdf;base64;charset=utf-8,${INFORME_BASE64}`, 'application/pdf'
  ]
];

const LOCATOR_PROBE_CHARACTERS = 4_000_018;

function hugeLocator(index: number): string {
  const prefix = `https://ejemplo.invalid/${String(index)}/`;
  return prefix + 'a'.repeat(LOCATOR_PROBE_CHARACTERS - prefix.length);
}

async function enableHumanGate(): Promise<void> {
  await pool.query(`UPDATE agent_chain_policies SET human_gate_enabled=true WHERE id='default'`);
}

interface StubbedTarget { tenant_id: Tenant; alias: string; online: boolean }

/** The expanded-size cap only bites on a fleet larger than any seed room has aliases. */
const stubRoutingTargets = (count: number): (() => void) => {
  const mutable = repository as unknown as {
    routingTargets(client: unknown, tenant: Tenant, alias: string): Promise<StubbedTarget[]>;
  };
  const original = mutable.routingTargets.bind(repository);
  mutable.routingTargets = async () => Array.from({ length: count }, (_, index) => ({
    tenant_id: 'Steven', alias: `peer_${String(index).padStart(4, '0')}`, online: true
  }));
  return () => { mutable.routingTargets = original; };
};

const attachmentsOf = (delivery: DeliveryEnvelope): Record<string, unknown>[] => {
  const value = delivery.body.attachments_v1;
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
};

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000, [PURE]);

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

describe(PURE, () => {
  it('derives the size from the base64 of a data uri', () => {
    expect(artifactRefs([{
      name: 'informe.pdf', uri: dataUri('application/pdf', informe),
      media_type: 'application/pdf', sha256: digest(informe)
    }])).toEqual([{
      name: 'informe.pdf', media_type: 'application/pdf',
      sha256: digest(informe), size: informe.length
    }]);
  });

  it('labels the digest of a pruned reference as declared, never as verified', () => {
    expect(artifactRefs([{
      name: 'informe.pdf', uri: 'cauce:inline-omitted',
      media_type: 'application/pdf', sha256: digest(informe), size: informe.length
    }])).toEqual([{
      name: 'informe.pdf', media_type: 'application/pdf',
      declared_sha256: digest(informe), size: informe.length
    }]);
  });

  it('keeps an https locator so the recipient can still fetch it', () => {
    expect(artifactRefs([{
      name: 'informe.pdf', uri: 'https://ejemplo.invalid/informe.pdf',
      media_type: 'application/pdf', sha256: digest(informe)
    }])).toEqual([{
      name: 'informe.pdf', uri: 'https://ejemplo.invalid/informe.pdf',
      media_type: 'application/pdf', declared_sha256: digest(informe)
    }]);
  });

  it('recomputes the digest of the bytes it can see, overwriting a false one', () => {
    expect(artifactRefs([{
      name: 'informe.pdf', uri: dataUri('application/pdf', informe), sha256: 'f'.repeat(64)
    }])).toEqual([{
      name: 'informe.pdf', media_type: 'application/pdf',
      sha256: digest(informe), size: informe.length
    }]);
  });

  it('bounds five multi-megabyte locators instead of carrying them upward', () => {
    const refs = artifactRefs([1, 2, 3, 4, 5].map((index) => ({
      name: `parte-${String(index)}.pdf`, uri: hugeLocator(index), sha256: digest(informe)
    })));

    expect(refs.length).toBeLessThanOrEqual(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(refs.every((ref) => ref.uri === undefined)).toBe(true);
    expect(JSON.stringify(refs).length).toBeLessThan(1024);
  });

  it('reads the same artifact as the pruning pass does, whitespace and case included', () => {
    const bytes = payload(64, 0x5a);
    const carried = attachmentsFromArtifacts([
      { name: 'informe.txt', uri: `  DATA:text/plain;base64,${bytes.toString('base64')}  ` }
    ]);

    expect(carried.refs).toEqual([]);
    expect(carried.dropped).toBe(0);
    expect(carried.attachments).toEqual([{
      kind: 'document', name: 'informe.txt', mime_type: 'text/plain',
      file_size: bytes.length, sha256: digest(bytes), content_base64: bytes.toString('base64')
    }]);
  });

  /* Every shape `PARIDAD_CON_EL_EGRESO` pins for the human egress, on the delegation edge: this
     reader had its own `;base64`-last rule, so five of them lost the file AND told the delegated
     agent it could not be decoded -- about bytes the bridge does upload. */
  it.each(FORMAS_QUE_EL_EGRESO_SUBE)(
    'attaches the shape the egress uploads: %s', (_caso, uri, mimeType) => {
      const carried = attachmentsFromArtifacts([{ name: 'informe.pdf', uri }]);

      expect(carried.dropped).toBe(0);
      expect(carried.note).toBeUndefined();
      expect(carried.attachments).toEqual([{
        kind: 'document', name: 'informe.pdf', mime_type: mimeType,
        file_size: informe.length, sha256: digest(informe),
        content_base64: informe.toString('base64')
      }]);
    }
  );

  it.each(FORMAS_QUE_EL_EGRESO_SUBE)(
    'keeps size and digest on the return hop for the same shape: %s', (_caso, uri, mimeType) => {
      expect(artifactRefs([{ name: 'informe.pdf', uri }])).toEqual([{
        name: 'informe.pdf', media_type: mimeType,
        sha256: digest(informe), size: informe.length
      }]);
    }
  );

  it('falls back to the default type instead of dropping a file typed unusably', () => {
    const carried = attachmentsFromArtifacts([
      { name: 'informe.bin', uri: `data:app(x)/pdf;base64,${informe.toString('base64')}` }
    ]);

    expect(carried.dropped).toBe(0);
    expect(carried.attachments[0]).toMatchObject({
      mime_type: DEFAULT_MEDIA_TYPE, sha256: digest(informe), file_size: informe.length
    });
  });

  it('counts the stored base64 of a broadcast, never the decoded bytes', () => {
    const bytes = payload(3_000, 0x21);
    const base64 = bytes.toString('base64');

    expect(declaredArtifactBudget([
      { name: 'uno.bin', uri: dataUri('application/octet-stream', bytes) },
      { name: '../../etc/passwd', uri: dataUri('text/plain', bytes) },
      { name: 'tres.bin', uri: 'file:///etc/passwd' }
    ])).toEqual({ bytes: base64.length, deliverable: 1 });
    expect(base64.length).toBeGreaterThan(bytes.length);
  });

  it('never returns bytes, a traversal name or a bogus media type', () => {
    expect(artifactRefs([
      { name: '../../etc/passwd', uri: 'cauce:inline-omitted' },
      { name: 'raro.bin', uri: 'cauce:inline-omitted', media_type: 'no es un tipo', size: -1 }
    ])).toEqual([{ name: 'raro.bin' }]);
    expect(artifactRefs('informe.pdf')).toEqual([]);
  });
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

  it('routes an image media type as an image attachment', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const captura = payload(512, 0x89);
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: 'socrates',
      body: 'captura',
      artifacts: [{ name: 'captura.png', uri: dataUri('image/png', captura) }]
    }]);

    expect(attachmentsOf(await nextDelivery(socrates))[0]).toMatchObject({
      kind: 'image', mime_type: 'image/png', name: 'captura.png'
    });
  });
});

describe('degradation when the bytes do not fit', () => {
  it('keeps the delegation and notes the artifacts beyond the per-message count', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: 'socrates',
      body: 'cinco ficheros',
      artifacts: [1, 2, 3, 4, 5].map((index) => ({
        name: `parte-${String(index)}.txt`,
        uri: dataUri('text/plain', payload(64, index))
      }))
    }]);

    const child = await nextDelivery(socrates);
    expect(child.body.text).toBe('cinco ficheros');
    expect(attachmentsOf(child)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(child.body.attachments_note)
      .toBe('1 adjunto(s) no viajaron: superan el máximo de adjuntos por mensaje');
    expect((await pool.query(
      `SELECT status,rejection_code FROM agent_output_materializations`
    )).rows).toEqual([{ status: 'materialized', rejection_code: null }]);
  });

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

  it('keeps the delegation text when the artifacts field is malformed', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [
      { to: 'socrates', body: 'artifacts es una cadena', artifacts: 'informe.pdf' }
    ]);

    const child = await nextDelivery(socrates);
    expect(child.body.text).toBe('artifacts es una cadena');
    expect(child.body.attachments_v1).toBeUndefined();
    expect(child.body.attachments_note).toBeUndefined();
  });

  it('drops an artifact whose name is a traversal and keeps the delegation', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: 'socrates',
      body: 'nombre con travesia',
      artifacts: [{ name: '../../etc/passwd', uri: dataUri('text/plain', payload(32, 7)) }]
    }]);

    const child = await nextDelivery(socrates);
    expect(child.body.text).toBe('nombre con travesia');
    expect(child.body.attachments_v1).toBeUndefined();
    expect(child.body.attachments_note)
      .toBe('1 adjunto(s) no viajaron: llevan un nombre no admitido');
    expect((await pool.query(
      `SELECT metadata->>'rejected_attachment_names' AS rejected FROM audit_events
       WHERE action='agent_output.materialize'`
    )).rows).toEqual([{ rejected: '1' }]);
  });

  it('names every cause when several artifacts fall for different reasons', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: 'socrates',
      body: 'dos causas',
      artifacts: [
        { name: '../../etc/passwd', uri: dataUri('text/plain', payload(32, 7)) },
        { name: 'local.txt', uri: 'file:///etc/passwd' }
      ]
    }]);

    const child = await nextDelivery(socrates);
    expect(child.body.text).toBe('dos causas');
    expect(child.body.attachments_note).toBe(
      '2 adjunto(s) no viajaron: 1 no llegan por un origen entregable;'
      + ' 1 llevan un nombre no admitido'
    );
  });
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

  it('still rejects a broadcast whose text alone blows the expanded budget', async () => {
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    const restore = stubRoutingTargets(20);

    try {
      const result = await ackWith(argos, root, [{ to: '@all', body: 'x'.repeat(60 * 1024) }]);

      expect(result.delegation_materializations).toBeUndefined();
      expect(result.delegation_rejections).toEqual([
        expect.objectContaining({ output_index: 0, target: '@all', code: 'invalid_output' })
      ]);
    } finally {
      restore();
    }
  }, 180_000);
});

describe('an artifact the edge cannot inline still travels', () => {
  it('carries an https artifact as a reference instead of dropping it', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: 'socrates',
      body: 'esta en el bucket',
      artifacts: [{
        name: 'informe.pdf',
        uri: 'https://ejemplo.invalid/informe.pdf',
        media_type: 'application/pdf',
        sha256: digest(informe)
      }]
    }]);

    const child = await nextDelivery(socrates);
    expect(child.body.text).toBe('esta en el bucket');
    expect(child.body.artifacts_v1).toEqual([{
      name: 'informe.pdf',
      uri: 'https://ejemplo.invalid/informe.pdf',
      media_type: 'application/pdf',
      declared_sha256: digest(informe)
    }]);
    expect(child.body.attachments_v1).toBeUndefined();
    expect(child.body.attachments_note).toBeUndefined();
  });

  it('drops a scheme no reader could fetch and says so', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: 'socrates',
      body: 'en mi disco',
      artifacts: [{ name: 'informe.pdf', uri: 'file:///home/agente/informe.pdf' }]
    }]);

    const child = await nextDelivery(socrates);
    expect(child.body.attachments_v1).toBeUndefined();
    expect(child.body.artifacts_v1).toBeUndefined();
    expect(child.body.attachments_note)
      .toBe('1 adjunto(s) no viajaron: no llegan por un origen entregable');
  });
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

  it('moves body_hash when the same text carries a different file', async () => {
    const argos = await consumer('Steven', 'argos');
    await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [
      { to: 'socrates', body: 'mismo texto', artifacts: [
        { name: 'uno.txt', uri: dataUri('text/plain', payload(64, 1)) }
      ] },
      { to: 'socrates', body: 'mismo texto', artifacts: [
        { name: 'dos.txt', uri: dataUri('text/plain', payload(64, 2)) }
      ] }
    ]);

    const hashes = (await pool.query<{ body_hash: string }>(
      `SELECT body_hash FROM agent_output_materializations
       WHERE status='materialized' ORDER BY output_index`
    )).rows.map((row) => row.body_hash);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
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

  it('caps how many artifacts one ack may declare for a single delegation', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: 'socrates',
      body: 'nueve ficheros',
      artifacts: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => ({
        name: `parte-${String(index)}.txt`,
        uri: dataUri('text/plain', payload(64, index))
      }))
    }]);

    const child = await nextDelivery(socrates);
    expect(attachmentsOf(child)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(child.body.attachments_note)
      .toBe('4 adjunto(s) no viajaron: superan el máximo de adjuntos por mensaje');
  });
});

describe('the broadcast budget counts what it actually stores', () => {
  it('withholds an artifact whose base64 does not fit even though its bytes would', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    const grande = payload(240_000, 0x37);
    await repository.publish(command());
    const root = await nextDelivery(argos);

    const result = await ackWith(argos, root, [{
      to: '@all',
      body: 'para todos',
      artifacts: [{ name: 'grande.bin', uri: dataUri('application/octet-stream', grande) }]
    }]);

    expect(result.delegation_materializations).toHaveLength(2);
    for (const branch of [socrates, jarvis]) {
      const child = await nextDelivery(branch);
      expect(child.body.text).toBe('para todos');
      expect(child.body.attachments_v1).toBeUndefined();
      expect(child.body.attachments_note)
        .toBe('1 adjunto(s) no viajaron: no caben en la difusión a toda la flota');
    }
  }, 180_000);

  it('counts only the artifacts that would have travelled', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await consumer('Steven', 'jarvis');
    const grande = payload(240_000, 0x38);
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{
      to: '@all',
      body: 'para todos',
      artifacts: [
        { name: 'grande.bin', uri: dataUri('application/octet-stream', grande) },
        { name: 'local.txt', uri: 'file:///etc/passwd' }
      ]
    }]);

    expect((await nextDelivery(socrates)).body.attachments_note)
      .toBe('1 adjunto(s) no viajaron: no caben en la difusión a toda la flota');
  }, 180_000);
});

describe('what is hashed and what is asked are what was written', () => {
  it('gives the same body_hash to two texts that differ only in the secret', async () => {
    const argos = await consumer('Steven', 'argos');
    await consumer('Steven', 'socrates');
    await consumer('Steven', 'jarvis');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [
      { to: 'socrates', body: 'entra con Bearer abc123DEF456ghi789 y avisa' },
      { to: 'jarvis', body: 'entra con Bearer zzz999YYY888xxx777 y avisa' }
    ]);

    const hashes = (await pool.query<{ body_hash: string }>(
      `SELECT body_hash FROM agent_output_materializations
       WHERE status='materialized' ORDER BY output_index`
    )).rows.map((row) => row.body_hash);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('redacts the question a human gate stores and returns', async () => {
    await enableHumanGate();
    const argos = await consumer('Steven', 'argos');
    const token = 'abc123DEF456ghi789';
    await repository.publish(command());
    const root = await nextDelivery(argos);

    const result = await ackWith(
      argos, root, [{ to: '@human', body: `¿uso Bearer ${token} para entrar?` }]
    );

    const gates = (await pool.query<{ question: string }>(
      'SELECT question FROM agent_chain_gates'
    )).rows;
    expect(gates).toEqual([{ question: '¿uso Bearer [secreto-redactado] para entrar?' }]);
    expect(JSON.stringify(result)).not.toContain(token);
    const relays = (await pool.query<{ reply: string }>(
      `SELECT payload#>>'{result,output,reply}' AS reply FROM adapter_outbox
       WHERE kind='origin_relay' AND payload->>'gate_id' IS NOT NULL`
    )).rows;
    expect(relays.some((relay) => relay.reply.includes(token))).toBe(false);
  }, 180_000);
});
