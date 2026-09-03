import { preparePostgresSuite } from './postgres-suite.js';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishMessage } from '@cauce/protocol';
import { requireValue } from './helpers.js';
import { CauceRepository, StoreError, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const VENTANA_MS = 30 * 24 * 60 * 60_000;
const CADENA_MS = 48 * 60 * 60_000;

const bytes = Buffer.alloc(96, 0x41);

const adjunto = {
  kind: 'document',
  name: 'informe.pdf',
  mime_type: 'application/pdf',
  file_size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  content_base64: bytes.toString('base64')
};

const raizAjena = randomUUID();
const CONSUMIDOR = 'poda-adjuntos-consumer';
const OPERADOR_ALIAS = 'socrates';

function cuerpo(): Record<string, unknown> {
  return {
    type: 'delegation.report',
    text: 'informe de la rama',
    timeout_ms: 600_000,
    correlation: { root_message_id: raizAjena },
    attachments_v1: [adjunto]
  };
}

function command(body: Record<string, unknown> = cuerpo()): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-poda-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body,
    idempotency_key: randomUUID(),
    lane: 'batch',
    priority: 0
  };
}

async function publicar(body?: Record<string, unknown>): Promise<string> {
  const receipt = await repository.publish(command(body));
  return receipt.message_id;
}

async function publicarEntrega(
  body?: Record<string, unknown>
): Promise<{ messageId: string; deliveryId: string }> {
  const receipt = await repository.publish(command(body));
  return {
    messageId: receipt.message_id,
    deliveryId: requireValue(receipt.delivery_ids[0], 'receipt.delivery_ids')
  };
}

async function cartaMuerta(deliveryId: string): Promise<Record<string, unknown>> {
  const fila = await pool.query<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM dead_letters WHERE delivery_id=$1', [deliveryId]
  );
  const payload = fila.rows[0]?.payload;
  if (!payload) throw new Error(`no dead letter for ${deliveryId}`);
  return payload;
}

async function agotarIntentos(epoch: number, times: number): Promise<string> {
  let deliveryId = '';
  for (let round = 0; round < times; round += 1) {
    const [claimed] = await repository.claimDeliveries('Isa', 'salva', CONSUMIDOR, epoch, 1, 60_000);
    if (!claimed) throw new Error(`expected a claimed delivery on round ${String(round + 1)}`);
    deliveryId = claimed.delivery_id;
    if (round + 1 < times) {
      await repository.retryStaleDeliveries(0, 100);
      await pool.query('UPDATE deliveries SET available_at=now() WHERE id=$1', [deliveryId]);
    }
  }
  return deliveryId;
}

async function envejecer(messageId: string, interval: string): Promise<void> {
  await pool.query(
    `UPDATE messages SET created_at=now()-interval '${interval}' WHERE id=$1`, [messageId]
  );
  await pool.query(
    `UPDATE deliveries SET created_at=now()-interval '${interval}',
       updated_at=now()-interval '${interval}' WHERE message_id=$1`, [messageId]
  );
}

async function leerCuerpo(messageId: string): Promise<Record<string, unknown>> {
  const fila = await pool.query<{ body: Record<string, unknown> }>(
    'SELECT body FROM messages WHERE id=$1', [messageId]
  );
  const body = fila.rows[0]?.body;
  if (!body) throw new Error(`no message ${messageId}`);
  return body;
}

async function existe(messageId: string): Promise<boolean> {
  const fila = await pool.query('SELECT 1 FROM messages WHERE id=$1', [messageId]);
  return fila.rowCount === 1;
}

const poda = (
  overrides: { messageAttachmentsMs?: number; chainMaxAgeMs?: number; batch?: number } = {}
): Promise<{ message_attachments: number }> => repository.pruneMessageAttachments({
  messageAttachmentsMs: VENTANA_MS, chainMaxAgeMs: CADENA_MS, ...overrides
});

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

beforeEach(async () => {
  if (!databaseStarted) return;
  await resetTestDatabase(pool);
  await pool.query(`
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true,allow_read=true WHERE role='agent';
    UPDATE memberships SET role='operator' WHERE tenant_id='Steven' AND alias='socrates';
  `);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('poda de adjuntos en messages.body', () => {
  it('se lleva sólo los bytes y conserva texto, tipo, correlación y timeout', async () => {
    const messageId = await publicar();
    await envejecer(messageId, '40 days');

    expect(await poda()).toEqual({ message_attachments: 1 });

    const body = await leerCuerpo(messageId);
    expect(body.attachments_v1).toBeUndefined();
    expect(body.attachments_pruned).toBe(1);
    expect(body.text).toBe('informe de la rama');
    expect(body.type).toBe('delegation.report');
    expect(body.timeout_ms).toBe(600_000);
    expect(body.correlation).toEqual({ root_message_id: raizAjena });
    expect(JSON.stringify(body)).not.toContain(adjunto.content_base64);
    expect(await existe(messageId)).toBe(true);
  });

  it('el segundo barrido no encuentra nada y no pisa la cuenta', async () => {
    const messageId = await publicar();
    await envejecer(messageId, '40 days');
    await poda();

    expect(await poda()).toEqual({ message_attachments: 0 });
    expect((await leerCuerpo(messageId)).attachments_pruned).toBe(1);
    expect(await existe(messageId)).toBe(true);
  });

  it('no toca un mensaje que sigue dentro de la ventana', async () => {
    const messageId = await publicar();
    await envejecer(messageId, '2 days');

    expect(await poda()).toEqual({ message_attachments: 0 });
    expect((await leerCuerpo(messageId)).attachments_v1).toEqual([adjunto]);
  });

  it('rechaza al configurar una ventana que no supera la del barrido de cadenas', async () => {
    const messageId = await publicar();
    await envejecer(messageId, '40 days');

    await expect(poda({ messageAttachmentsMs: CADENA_MS })).rejects.toBeInstanceOf(StoreError);
    await expect(poda({ messageAttachmentsMs: 60 * 60_000 }))
      .rejects.toThrow(/chain sweep horizon/u);
    expect((await leerCuerpo(messageId)).attachments_v1).toEqual([adjunto]);
  });

  it('juzga la ventana contra el horizonte del despliegue, no contra una copia de 48 h', async () => {
    const messageId = await publicar();
    await envejecer(messageId, '40 days');

    await expect(poda({ chainMaxAgeMs: 60 * 24 * 60 * 60_000 }))
      .rejects.toThrow(/chain sweep horizon/u);
    expect((await leerCuerpo(messageId)).attachments_v1).toEqual([adjunto]);
  });

  it('trae su propio tope de 50 filas y no el del barrido de observabilidad', async () => {
    for (let index = 0; index < 51; index += 1) {
      await envejecer(await publicar(), '40 days');
    }

    expect(await poda()).toEqual({ message_attachments: 50 });
    expect(await poda()).toEqual({ message_attachments: 1 });
  });

  it('respeta el tope del lote', async () => {
    for (let index = 0; index < 3; index += 1) {
      await envejecer(await publicar(), '40 days');
    }

    expect(await poda({ batch: 2 })).toEqual({ message_attachments: 2 });
    expect(await poda({ batch: 2 })).toEqual({ message_attachments: 1 });
    expect(await poda({ batch: 2 })).toEqual({ message_attachments: 0 });
  });

  it('deja el cuerpo intacto cuando attachments_v1 no es una lista', async () => {
    const messageId = await publicar({ text: 'cuerpo torcido', attachments_v1: { roto: true } });
    await envejecer(messageId, '40 days');

    expect(await poda()).toEqual({ message_attachments: 1 });
    const body = await leerCuerpo(messageId);
    expect(body.attachments_v1).toBeUndefined();
    expect(body.attachments_pruned).toBe(0);
    expect(body.text).toBe('cuerpo torcido');
  });

  it('las lecturas de cadena y de fan-in siguen resolviendo sobre un cuerpo podado', async () => {
    const raiz = await publicar({ text: 'pedido humano' });
    await pool.query(
      `UPDATE messages SET origin=jsonb_build_object(
         'adapter','telegram','channel','telegram','conversation_id','c-1',
         'external_message_id','m-1','relay',jsonb_build_array(),
         'metadata',jsonb_build_object('bridge_alias','argos','bridge_tenant','Steven')
       ) WHERE id=$1`, [raiz]
    );
    const rama = await publicar();
    await pool.query(
      `UPDATE messages SET body=body||jsonb_build_object(
         'type','agent.response','correlation',jsonb_build_object('root_message_id',$2::text)
       ) WHERE id=$1`, [rama, raiz]
    );
    await envejecer(raiz, '40 days');
    await envejecer(rama, '40 days');

    expect((await poda()).message_attachments).toBe(1);

    const leido = await pool.query<{
      root: string | null; tipo: string | null; texto: string | null; timeout: string | null;
    }>(
      `SELECT body->'correlation'->>'root_message_id' AS root,body->>'type' AS tipo,
              body->>'text' AS texto,body->>'timeout_ms' AS timeout
         FROM messages WHERE id=$1`, [rama]
    );
    expect(leido.rows[0]).toEqual({
      root: raiz, tipo: 'agent.response', texto: 'informe de la rama', timeout: '600000'
    });

    const barrido = await repository.sweepSilentChains({
      idleMs: 1_000, settledGraceMs: 1_000, maxAgeMs: 60 * 24 * 60 * 60_000, limit: 5
    });
    expect(barrido.scanned).toBeGreaterThanOrEqual(1);
  });

  it('el segador no copia los bytes al dead letter', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', CONSUMIDOR, [], 120_000);
    const messageId = await publicar();
    const deliveryId = await agotarIntentos(requireValue(lease.epoch, 'lease.epoch'), 3);

    expect(await repository.retryStaleDeliveries(0, 100))
      .toEqual({ retried: 0, dead: 1, parked: 0 });

    const payload = await cartaMuerta(deliveryId);
    expect(payload.attachments_v1).toBeUndefined();
    expect(payload.attachments_omitted).toBe(1);
    expect(payload.text).toBe('informe de la rama');
    expect(JSON.stringify(payload)).not.toContain(adjunto.content_base64);
    expect((await leerCuerpo(messageId)).attachments_v1).toEqual([adjunto]);
  });

  it('la cancelación del operador tampoco copia los bytes al dead letter', async () => {
    const { messageId, deliveryId } = await publicarEntrega();

    await repository.cancelDelivery(deliveryId, 'Steven', OPERADOR_ALIAS, 'ya no hace falta');

    const payload = await cartaMuerta(deliveryId);
    expect(payload.attachments_v1).toBeUndefined();
    expect(payload.attachments_omitted).toBe(1);
    expect(payload.text).toBe('informe de la rama');
    expect(JSON.stringify(payload)).not.toContain(adjunto.content_base64);
    expect((await leerCuerpo(messageId)).attachments_v1).toEqual([adjunto]);
  });

  it('un attachments_v1 torcido no aborta la escritura del dead letter', async () => {
    const { deliveryId } = await publicarEntrega({ text: 'torcido', attachments_v1: { roto: true } });

    await repository.cancelDelivery(deliveryId, 'Steven', OPERADOR_ALIAS);

    const payload = await cartaMuerta(deliveryId);
    expect(payload.attachments_omitted).toBeUndefined();
    expect(payload.attachments_v1).toEqual({ roto: true });
    expect(payload.text).toBe('torcido');
  });

  it('getMessage entrega el resumen de adjuntos y nunca el base64', async () => {
    const messageId = await publicar();

    const detalle = await repository.getMessage(messageId, 'Steven', 'kant');
    const body = detalle.body as Record<string, unknown>;
    expect(body.attachments_v1).toBeUndefined();
    expect(body.text).toBe('informe de la rama');
    expect(detalle.attachments).toEqual([{
      name: adjunto.name,
      mime_type: adjunto.mime_type,
      file_size: adjunto.file_size,
      sha256: adjunto.sha256
    }]);
    expect(JSON.stringify(detalle)).not.toContain('content_base64');
    expect(JSON.stringify(detalle)).not.toContain(adjunto.content_base64);

    await envejecer(messageId, '40 days');
    await poda();
    const podado = await repository.getMessage(messageId, 'Steven', 'kant');
    expect(podado.attachments).toEqual([]);
    expect((podado.body as Record<string, unknown>).attachments_pruned).toBe(1);
  });
});
