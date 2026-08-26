/* eslint-disable @typescript-eslint/unbound-method */
/**
 * ==============================================================================================
 * EL FRAME `ack_result`, MIRADO COMO LO MIRA EL ADAPTADOR
 *
 * `AckResult` ganó `delegation_rejections` y `chain_gate`. El gateway hacía
 * `const { receipt, ...legacyResult } = result` y esparcía `legacyResult` al frame, así que los
 * dos campos nuevos salían al cable SIN gate — mientras el miembro `ack_result` de
 * `WsOutboundSchema` seguía `.strict()` y sin conocerlos.
 *
 * Del lado del adaptador eso no es un frame que se descarta: `WsOutboundSchema.parse()` tira, y
 * el transporte convertía ese throw en `queue.fail(...)`, que rechaza al iterador y a todos los
 * que esperan. Un solo frame de esa forma se lleva puesta la cola ENTERA de la conexión y todas
 * las entregas en vuelo con ella.
 *
 * POR QUÉ ESTOS TESTS EXISTEN, Y POR QUÉ LOS QUE HABÍA NO ALCANZARON: los tests de disciplina de
 * delegación afirmaban sobre el valor de retorno de `ackDelivery` (`result.delegation_rejections
 * ?.[0]?.code`), y ese valor SIEMPRE estuvo bien. Nadie validaba el frame. Así que acá cada frame
 * que sale del gateway se pasa por el MISMO validador que corre el adaptador; si el frame se sale
 * del esquema, el test falla igual que fallaría la flota.
 * ==============================================================================================
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import {
  MAX_DELEGATION_REJECTION_TARGET_CHARS, WsOutboundSchema, type WsOutbound
} from '@cauce/protocol';
import { buildGateway } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { fakePool, fakeRepository, ids, noDeliveryWakes } from './helpers.js';

const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function text(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/**
 * El rechazo más grande que el store sabe emitir: `chain_gated` incrusta la pregunta del gate,
 * que la base acota a 8 KiB, y el destino es texto del agente recortado al tope del esquema.
 * Si el frame más grande posible no pasara su propio esquema, el gate no serviría de nada.
 */
const worstCaseGateQuestion = 'q'.repeat(8 * 1_024);
const worstCaseTarget = 't'.repeat(MAX_DELEGATION_REJECTION_TARGET_CHARS);

const rejections = [
  {
    code: 'fanout_exceeded' as const,
    reason: 'Abanico agotado: este turno ya delegó 3 veces, que es el máximo por turno interno.',
    guidance: 'No reintentes. Elegí las delegaciones imprescindibles y mandá esas.',
    output_index: 0,
    target: 'kratos'
  },
  {
    code: 'chain_gated' as const,
    reason: `La cadena está suspendida esperando una respuesta humana: «${worstCaseGateQuestion}».`,
    guidance: 'No delegues ni reintentes mientras el gate esté abierto.',
    // La expansión de `@all` desplaza el índice a propósito; no es un índice de array.
    output_index: 1_205,
    target: worstCaseTarget
  }
];
const chainGate = { gate_id: 'a1b2c3d4-0000-4000-8000-00000000ffff', question: worstCaseGateQuestion };
const materializations = [{
  output_index: 1,
  target_tenant: 'Steven' as const,
  target_alias: 'socrates',
  child_delivery_id: 'a1b2c3d4-0000-4000-8000-000000000123'
}];

/**
 * Levanta un gateway y un adaptador que declara EXACTAMENTE las capabilities que se le pasan.
 * Todo frame que llega se valida con el validador del adaptador antes de devolverse.
 */
async function connectAdapter(capabilities: readonly string[]): Promise<{
  nextFrame: () => Promise<WsOutbound>;
  ack: () => void;
}> {
  const repository = fakeRepository();
  vi.mocked(repository.ackDelivery).mockResolvedValue({
    delivery_id: ids.delivery,
    status: 'done',
    applied: true,
    receipt: 'applied',
    delegation_rejections: rejections,
    delegation_materializations: materializations,
    chain_gate: chainGate
  });
  const app = await buildGateway({
    pool: fakePool(),
    repository,
    authProvider: DevOnlyAuthProvider.forTests(),
    deliveryWakeSubscriber: noDeliveryWakes,
    ackDeadlineMs: 600_000,
    outboxPollMs: 60_000
  });
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v3/ws`, {
    headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
  });
  sockets.push(socket);

  const queued: WsOutbound[] = [];
  const waiting: Array<(value: WsOutbound) => void> = [];
  const failures: unknown[] = [];
  socket.on('message', (data) => {
    // ESTA es la línea que faltaba. `websocket-transport.ts` hace exactamente esto con cada
    // frame del gateway, y un throw acá era la cola entera de la conexión.
    const parsed = WsOutboundSchema.safeParse(JSON.parse(text(data)));
    if (!parsed.success) {
      failures.push(parsed.error);
      return;
    }
    const resolve = waiting.shift();
    if (resolve) resolve(parsed.data);
    else queued.push(parsed.data);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
    instance_id: 'frame-gating', capabilities
  }));

  const nextFrame = async (): Promise<WsOutbound> => {
    const existing = queued.shift();
    if (existing) return existing;
    return new Promise<WsOutbound>((resolve, reject) => {
      waiting.push(resolve);
      // Sin esto un frame fuera del esquema sería un timeout de 120 s sin explicación, que es
      // justo lo que hace difícil de leer este modo de falla en producción.
      const deadline = setTimeout(() => {
        reject(new Error(
          failures.length > 0
            ? `el adaptador rechazó ${failures.length} frame(s) del gateway: ${String(failures[0])}`
            : 'el gateway no mandó ningún frame'
        ));
      }, 5_000);
      deadline.unref();
    });
  };

  expect(await nextFrame()).toMatchObject({ type: 'hello_ack' });
  return {
    nextFrame,
    ack: () => {
      socket.send(JSON.stringify({
        type: 'ack', version: '3.0', event_id: ids.event, delivery_id: ids.delivery,
        attempt: 1, claim_token: ids.claim, status: 'done', instance_id: 'frame-gating', epoch: 1
      }));
    }
  };
}

describe('ack_result delegation feedback is gated by a negotiated capability', () => {
  it('sends an OLD adapter a frame its own schema accepts, without the new fields', async () => {
    // Un adaptador de la flota tal como está desplegada hoy: no conoce `delegation_feedback_v1`.
    const adapter = await connectAdapter(['acks.v3', 'renewable_delivery_claims_v1']);
    adapter.ack();

    // Que este `await` resuelva ya es la mitad del test: si el frame se saliera del esquema, el
    // validador del adaptador lo habría rechazado y esto fallaría con los campos culpables.
    const frame = await adapter.nextFrame();

    expect(frame).toMatchObject({
      type: 'ack_result',
      delivery_id: ids.delivery,
      event_id: ids.event,
      claim_token: ids.claim,
      status: 'done',
      applied: true,
      receipt: 'applied'
    });
    // Y no llegan por el spread: el gateway los saca a mano de `legacyResult`.
    expect(frame).not.toHaveProperty('delegation_rejections');
    expect(frame).not.toHaveProperty('delegation_materializations');
    expect(frame).not.toHaveProperty('chain_gate');
  });

  it('sends a capable adapter all feedback fields, intactos y dentro del esquema', async () => {
    const adapter = await connectAdapter([
      'acks.v3', 'renewable_delivery_claims_v1', 'delegation_feedback_v1'
    ]);
    adapter.ack();

    const frame = await adapter.nextFrame();

    expect(frame).toMatchObject({ type: 'ack_result', applied: true, receipt: 'applied' });
    // El gate no puede degradar el contenido: el peor caso que el store sabe generar —una
    // pregunta de 8 KiB y un destino en el tope— viaja completo y valida.
    expect(frame).toHaveProperty('delegation_rejections', rejections);
    expect(frame).toHaveProperty('delegation_materializations', materializations);
    expect(frame).toHaveProperty('chain_gate', chainGate);
  });

  it('never leaks the fields to an adapter that declares no capabilities at all', async () => {
    const adapter = await connectAdapter([]);
    adapter.ack();

    const frame = await adapter.nextFrame();

    expect(frame).not.toHaveProperty('delegation_rejections');
    expect(frame).not.toHaveProperty('delegation_materializations');
    expect(frame).not.toHaveProperty('chain_gate');
    // `receipt` sigue con su propio gate: este test también protege ese precedente.
    expect(frame).not.toHaveProperty('receipt');
  });
});
