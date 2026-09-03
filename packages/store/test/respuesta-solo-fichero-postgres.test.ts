import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ARTIFACTS_CONSIDERED, objectRecord,
  type Ack, type DeliveryEnvelope, type PublishMessage, type Tenant
} from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { planArtifacts } from '../../../services/telegram-bridge/src/artifacts.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import { artifactRefs } from '../src/repository/agents/delegated-attachments.js';
import { requireValue } from './helpers.js';
import { preparePostgresSuite } from './postgres-suite.js';

/**
 * Respuesta cuyo contenido útil es un fichero, y las copias de egreso del resultado.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const INLINE_BYTES = Buffer.from('informe pdf simulado');
const INLINE_BASE64 = INLINE_BYTES.toString('base64');
const INLINE_URI = `data:application/pdf;base64,${INLINE_BASE64}`;
const INLINE_SHA256 = createHash('sha256').update(INLINE_BYTES).digest('hex');
const WRAPPED_URI =
  `data:application/pdf;base64,${INLINE_BASE64.slice(0, 12)}\n${INLINE_BASE64.slice(12)}`;
const TYPELESS_URI = `data:;base64,${INLINE_BASE64}`;
const UPPERCASE_URI = `DATA:application/pdf;base64,${INLINE_BASE64}`;
const CHARSET_URI = `data:application/pdf;charset=utf-8;base64,${INLINE_BASE64}`;
const BASE64_MAYUSCULAS_URI = `data:application/pdf;BASE64,${INLINE_BASE64}`;
const BASE64_EN_MEDIO_URI = `data:application/pdf;base64;charset=utf-8,${INLINE_BASE64}`;
/** El egreso sube el fichero igual: lo inservible es la ranura del tipo, nunca los bytes. */
const TIPO_INSERVIBLE_URI = `data:foo;base64,${INLINE_BASE64}`;
const TIPO_POR_DEFECTO = 'application/octet-stream';

/** Formas que el puente sube o rechaza, medidas con su propio decodificador. */
/* La invariante «subidas>0 ⟺ done» sólo vale sin locators: un https:// entrega sin subir nada. */
const PARIDAD_CON_EL_EGRESO = [
  { caso: 'canónico', uri: INLINE_URI, subidas: 1 },
  { caso: 'base64 partido en líneas', uri: WRAPPED_URI, subidas: 1 },
  { caso: 'sin tipo de medio', uri: TYPELESS_URI, subidas: 1 },
  { caso: 'esquema en mayúsculas', uri: UPPERCASE_URI, subidas: 1 },
  { caso: 'charset antes de base64', uri: CHARSET_URI, subidas: 1 },
  { caso: 'base64 en mayúsculas', uri: BASE64_MAYUSCULAS_URI, subidas: 1 },
  { caso: 'base64 en medio', uri: BASE64_EN_MEDIO_URI, subidas: 1 },
  { caso: 'data: sin datos', uri: 'data:x', subidas: 0 },
  { caso: 'https: sin autoridad', uri: 'https:ejemplo.invalid/informe.pdf', subidas: 0 }
] as const;

/* Las formas que el egreso sí sube y el lector del descriptor leía con su propia regla. `tipo` es
   el que sobrevive en la copia durable: el declarado en la entrada cuando lo hay, y si no el que
   sale de la cabecera — con el de la cabecera sustituido por el de por defecto cuando el protocolo
   no lo admite, porque perderlo costaba también el tamaño y el digest del fichero entregado. */
const FORMAS_NORMALIZADAS = [
  { caso: 'base64 partido en líneas', uri: WRAPPED_URI, declarado: true, tipo: 'application/pdf' },
  { caso: 'sin tipo de medio', uri: TYPELESS_URI, declarado: true, tipo: 'application/pdf' },
  { caso: 'charset antes de base64', uri: CHARSET_URI, declarado: true, tipo: 'application/pdf' },
  {
    caso: 'base64 en mayúsculas', uri: BASE64_MAYUSCULAS_URI, declarado: true,
    tipo: 'application/pdf'
  },
  { caso: 'esquema en mayúsculas', uri: UPPERCASE_URI, declarado: true, tipo: 'application/pdf' },
  { caso: 'base64 en medio', uri: BASE64_EN_MEDIO_URI, declarado: true, tipo: 'application/pdf' },
  {
    caso: 'tipo de medio que el protocolo no admite y sin tipo en la entrada',
    uri: TIPO_INSERVIBLE_URI, declarado: false, tipo: TIPO_POR_DEFECTO
  }
] as const;

/** Relleno que el puente descarta: pasado el tope, un fichero válido ya no lo mira nadie. */
const RELLENO_QUE_EL_EGRESO_DESCARTA = [
  { caso: 'entradas que no son objeto', relleno: 'basura' as unknown },
  { caso: 'uri que no es texto', relleno: { name: 'x.pdf', uri: 123 } },
  { caso: 'rutas que sólo existen en el agente', relleno: { name: 'x.pdf', uri: '/tmp/x.pdf' } }
] as const;

const NOMBRES_QUE_NO_SE_GUARDAN = [
  { caso: 'sin nombre', name: undefined },
  { caso: 'nombre inseguro', name: '../informe.pdf' }
] as const;

const BROKEN_BASE64 = 'QUJDR';
const BROKEN_URI = `data:application/pdf;base64,${BROKEN_BASE64}`;
const ATTACHMENT_BYTES = Buffer.from('adjunto de entrada');
const ATTACHMENT = {
  kind: 'document',
  name: 'entrada.txt',
  mime_type: 'text/plain',
  file_size: ATTACHMENT_BYTES.length,
  sha256: createHash('sha256').update(ATTACHMENT_BYTES).digest('hex'),
  content_base64: ATTACHMENT_BYTES.toString('base64')
};

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-fichero-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'devuelve el informe como fichero' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    authenticated_context: {
      session_id: `session-${randomUUID()}`,
      channel: 'telegram-dm',
      origin: {
        adapter: 'telegram',
        channel: 'dm',
        conversation_id: `chat-${randomUUID()}`,
        relay: [],
        metadata: {}
      }
    },
    ...overrides
  };
}

async function publishAndClaim(
  input: PublishMessage,
  tenant: Tenant,
  alias: string,
  instanceId: string
): Promise<{ delivery: DeliveryEnvelope; epoch: number; deliveryId: string }> {
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  const published = await repository.publish(input);
  const [delivery] = await repository.claimDeliveries(
    tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000
  );
  if (!delivery) throw new Error('expected a claimed delivery');
  return {
    delivery,
    epoch: requireValue(lease.epoch, 'lease.epoch'),
    deliveryId: requireValue(published.delivery_ids[0], 'published.delivery_ids')
  };
}

function artifactAck(
  delivery: DeliveryEnvelope,
  instanceId: string,
  epoch: number,
  artifacts: readonly unknown[]
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'done',
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result: {
      output: { reply: null, messages: [], status: 'done', retryable: false, artifacts }
    }
  };
}

function failureAck(delivery: DeliveryEnvelope, instanceId: string, epoch: number): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'failed',
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    error: 'el agente declaró un fallo definitivo',
    error_code: 'AGENT_FAILURE'
  };
}

async function relayPayload(deliveryId: string): Promise<Record<string, unknown>> {
  const relay = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM adapter_outbox WHERE delivery_id=$1 AND kind='origin_relay'`,
    [deliveryId]
  );
  return requireValue(relay.rows[0], 'origin relay row').payload;
}

async function storedResult(deliveryId: string): Promise<Record<string, unknown> | undefined> {
  const stored = await pool.query<{ result: Record<string, unknown> | null }>(
    `SELECT result FROM deliveries WHERE id=$1`, [deliveryId]
  );
  return objectRecord(requireValue(stored.rows[0], 'delivery row').result);
}

async function ackPayload(deliveryId: string): Promise<Record<string, unknown>> {
  const acks = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM delivery_acks WHERE delivery_id=$1 AND status='done' AND applied`,
    [deliveryId]
  );
  return requireValue(acks.rows[0], 'delivery ack row').payload;
}

function artifactsOf(result: unknown): readonly Record<string, unknown>[] {
  const entries = objectRecord(objectRecord(result)?.output)?.artifacts;
  if (!Array.isArray(entries)) return [];
  return (entries as readonly unknown[]).map((entry) => objectRecord(entry) ?? {});
}

async function relayOf(
  artifacts: readonly unknown[],
  instanceId: string
): Promise<{ payload: Record<string, unknown>; deliveryId: string }> {
  const { delivery, epoch, deliveryId } = await publishAndClaim(
    command(), 'Steven', 'argos', instanceId
  );
  await repository.ackDelivery(
    delivery.delivery_id, 'Steven', 'argos', artifactAck(delivery, instanceId, epoch, artifacts)
  );
  return { payload: await relayPayload(deliveryId), deliveryId };
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

beforeEach(async () => {
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

describe('una respuesta que solo trae fichero es una respuesta', () => {
  it('relaya done y conserva los bytes en la única copia con consumidor', async () => {
    const { payload } = await relayOf(
      [{ name: 'informe.pdf', media_type: 'application/pdf', sha256: INLINE_SHA256, uri: INLINE_URI }],
      'artifact-inline-consumer'
    );

    expect(payload.outcome).toBe('done');
    expect(payload.error_code).toBeUndefined();
    expect(JSON.stringify(payload)).toContain(INLINE_BASE64);
  });

  it('deja fuera los bytes inline de deliveries.result y de delivery_acks.payload', async () => {
    const { deliveryId, payload } = await relayOf(
      [{ name: 'informe.pdf', media_type: 'application/pdf', sha256: INLINE_SHA256, uri: INLINE_URI }],
      'artifact-copies-consumer'
    );

    const result = await storedResult(deliveryId);
    const ack = await ackPayload(deliveryId);
    for (const copy of [result, objectRecord(ack.result)]) {
      expect(JSON.stringify(copy)).not.toContain(INLINE_BASE64);
      expect(artifactsOf(copy)[0]).toEqual({
        name: 'informe.pdf',
        media_type: 'application/pdf',
        sha256: INLINE_SHA256,
        size: INLINE_BYTES.length,
        uri: 'cauce:inline-omitted'
      });
      expect(objectRecord(objectRecord(copy)?.output)?.inline_artifacts_omitted).toBe(1);
    }
    expect(JSON.stringify(payload)).toContain(INLINE_BASE64);
  });

  it('acepta https y deja intacto un resultado sin bytes inline', async () => {
    const { payload, deliveryId } = await relayOf(
      [{ name: 'informe.pdf', uri: 'https://ejemplo.invalid/informe.pdf' }],
      'artifact-https-consumer'
    );

    expect(payload.outcome).toBe('done');
    expect(payload.error_code).toBeUndefined();
    const result = await storedResult(deliveryId);
    expect(artifactsOf(result)[0]).toEqual({
      name: 'informe.pdf', uri: 'https://ejemplo.invalid/informe.pdf'
    });
    expect(objectRecord(objectRecord(result)?.output))
      .not.toHaveProperty('inline_artifacts_omitted');
  });

  it('no cierra done un data: que nadie puede decodificar', async () => {
    const { payload } = await relayOf(
      [{ name: 'informe.pdf', uri: 'data:x' }], 'artifact-broken-data-consumer'
    );

    expect(payload).toMatchObject({ outcome: 'failed', error_code: 'MISSING_FINAL_REPLY' });
  });

  it('no cierra done un https: sin autoridad que el puente listaría como ruta', async () => {
    const { payload } = await relayOf(
      [{ name: 'informe.pdf', uri: 'https:ejemplo.invalid/informe.pdf' }],
      'artifact-https-authority-consumer'
    );

    expect(payload).toMatchObject({ outcome: 'failed', error_code: 'MISSING_FINAL_REPLY' });
  });

  it('poda con la misma aritmética que lee el salto de vuelta', async () => {
    const originals = [
      { name: 'informe.pdf', media_type: 'application/pdf', sha256: INLINE_SHA256, uri: INLINE_URI },
      { name: 'roto.pdf', media_type: 'application/pdf', uri: BROKEN_URI }
    ];
    const { deliveryId } = await relayOf(originals, 'artifact-size-parity-consumer');

    const stored = artifactsOf(await storedResult(deliveryId));
    expect(stored).toHaveLength(originals.length);
    for (const [index, original] of originals.entries()) {
      const before = requireValue(artifactRefs([original])[0], 'referencia del artefacto íntegro');
      const after = requireValue(artifactRefs([stored[index]])[0], 'referencia de la copia podada');
      expect(after.size).toBe(before.size);
      expect(after.name).toBe(before.name);
      expect(after.media_type).toBe(before.media_type);
      expect(after.declared_sha256 ?? after.sha256).toBe(before.sha256 ?? before.declared_sha256);
    }
  });

  it.each(PARIDAD_CON_EL_EGRESO)('cierra done lo que el egreso sube: $caso', async (fila) => {
    const artifacts = [{ name: 'informe.pdf', media_type: 'application/pdf', uri: fila.uri }];
    expect(planArtifacts({ artifacts }).uploads).toHaveLength(fila.subidas);

    const { payload } = await relayOf(artifacts, 'artifact-parity-consumer');

    expect(payload.outcome).toBe(fila.subidas === 0 ? 'failed' : 'done');
  });

  it.each(FORMAS_NORMALIZADAS)(
    'conserva tamaño y digest del fichero que el egreso sube: $caso', async (fila) => {
      const { deliveryId } = await relayOf(
        [{
          name: 'informe.pdf',
          ...(fila.declarado ? { media_type: 'application/pdf' } : {}),
          uri: fila.uri
        }],
        'artifact-shape-consumer'
      );

      const stored = artifactsOf(await storedResult(deliveryId))[0];
      expect(stored).toEqual({
        name: 'informe.pdf',
        media_type: fila.tipo,
        sha256: INLINE_SHA256,
        size: INLINE_BYTES.length,
        uri: 'cauce:inline-omitted'
      });
      expect(JSON.stringify(stored)).not.toContain(INLINE_BASE64);
    }
  );

  /* El descriptor pelado `{uri}` no debe existir: sin nombre y con un tipo que el protocolo no
     admite, la copia durable seguiría siendo el único registro de un fichero que la persona sí
     recibió, y quedarse sin tipo, tamaño ni digest la vuelve un recibo en blanco. */
  it('nunca guarda un descriptor pelado, sin nombre y con un tipo inservible', async () => {
    const { deliveryId } = await relayOf(
      [{ uri: TIPO_INSERVIBLE_URI }], 'artifact-bare-descriptor-consumer'
    );

    expect(artifactsOf(await storedResult(deliveryId))[0]).toEqual({
      media_type: TIPO_POR_DEFECTO,
      sha256: INLINE_SHA256,
      size: INLINE_BYTES.length,
      uri: 'cauce:inline-omitted'
    });
  });

  it.each(RELLENO_QUE_EL_EGRESO_DESCARTA)(
    'no cierra done un fichero que al egreso ya no le entra: $caso', async (fila) => {
      const artifacts = [
        ...Array.from({ length: MAX_ARTIFACTS_CONSIDERED }, () => fila.relleno),
        { name: 'informe.pdf', media_type: 'application/pdf', uri: INLINE_URI }
      ];
      expect(planArtifacts({ artifacts }).uploads).toHaveLength(0);

      const { payload } = await relayOf(artifacts, 'artifact-overflow-consumer');

      expect(payload).toMatchObject({ outcome: 'failed', error_code: 'MISSING_FINAL_REPLY' });
    }
  );

  it.each(NOMBRES_QUE_NO_SE_GUARDAN)(
    'conserva tamaño, digest y tipo con $caso', async (fila) => {
      const { deliveryId } = await relayOf([{
        ...(fila.name === undefined ? {} : { name: fila.name }),
        media_type: 'application/pdf',
        uri: INLINE_URI
      }], 'artifact-nameless-consumer');

      const stored = artifactsOf(await storedResult(deliveryId))[0];
      expect(stored).toEqual({
        media_type: 'application/pdf',
        sha256: INLINE_SHA256,
        size: INLINE_BYTES.length,
        uri: 'cauce:inline-omitted'
      });
      expect(JSON.stringify(stored)).not.toContain('informe');
    }
  );

  it('no toma por respuesta un file: que solo existe dentro del agente', async () => {
    const { payload } = await relayOf(
      [{ name: 'informe.pdf', uri: 'file:///tmp/informe.pdf' }], 'artifact-file-consumer'
    );

    expect(payload).toMatchObject({ outcome: 'failed', error_code: 'MISSING_FINAL_REPLY' });
  });

  it('no toma por respuesta un http: que el puente no puede seguir', async () => {
    const { payload } = await relayOf(
      [{ name: 'informe.pdf', uri: 'http://ejemplo.invalid/informe.pdf' }], 'artifact-http-consumer'
    );

    expect(payload).toMatchObject({ outcome: 'failed', error_code: 'MISSING_FINAL_REPLY' });
  });
});

describe('dead letter de una entrega con adjuntos', () => {
  it('guarda el cuerpo sin los bytes de entrada y cuenta lo omitido', async () => {
    const { delivery, epoch, deliveryId } = await publishAndClaim(
      command({ body: { text: 'procesa el adjunto', attachments_v1: [ATTACHMENT] } }),
      'Steven', 'argos', 'attachment-failure-consumer'
    );

    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      failureAck(delivery, 'attachment-failure-consumer', epoch)
    );

    const dead = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM dead_letters WHERE delivery_id=$1`, [deliveryId]
    );
    const payload = requireValue(dead.rows[0], 'dead letter row').payload;
    expect(payload).toEqual({
      text: 'procesa el adjunto',
      attachments_omitted: 1
    });
  });

  it('deja el cuerpo tal cual cuando la entrega no traía adjuntos', async () => {
    const input = command();
    const { delivery, epoch, deliveryId } = await publishAndClaim(
      input, 'Steven', 'argos', 'plain-failure-consumer'
    );

    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      failureAck(delivery, 'plain-failure-consumer', epoch)
    );

    const dead = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM dead_letters WHERE delivery_id=$1`, [deliveryId]
    );
    expect(requireValue(dead.rows[0], 'dead letter row').payload).toEqual(input.body);
  });
});
