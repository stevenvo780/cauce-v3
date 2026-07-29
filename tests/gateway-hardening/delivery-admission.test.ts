/* eslint-disable @typescript-eslint/unbound-method */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { isAgentToAgentBody } from '@cauce/protocol';
import { buildGateway, type DeliveryClaimRecord, type GatewayRepository } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { fakePool, fakeRepository, noDeliveryWakes } from './helpers.js';

/**
 * Control de admisión y reserva para el humano.
 *
 * Origen del defecto: `drain()` llamaba a `repository.claimDeliveries(...)` pasando `undefined`
 * en la posición de `limit`, así que se comía el default 20 del store. Veinte entregas
 * reclamadas en el mismo instante arrancan el mismo plazo de ACK de 30 minutos a la vez; la
 * cola del lote se muere sin haber empezado, se reintenta, y el reintento vuelve a ejecutar
 * trabajo ya hecho. Medido el 2026-07-27: kratos llegó a 71 entregas en vuelo, 1.001 de 1.622
 * errores fueron "ACK timeout", y los agentes codex pagaron 2.240 corridas para 1.312 entregas.
 *
 * Y el corolario que hace falta probar aparte: un límite de admisión a secas EMPEORA la
 * conversación. Si el único hueco lo ocupa una tarea de 40 minutos, el mensaje de la persona
 * espera 40 minutos. Por eso el cupo reservado es aditivo y se prueba explícitamente acá.
 */

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

function frameReader(socket: WebSocket): {
  next: () => Promise<Record<string, unknown>>;
  seen: () => Record<string, unknown>[];
} {
  const queued: Record<string, unknown>[] = [];
  const all: Record<string, unknown>[] = [];
  const waiting: Array<(value: Record<string, unknown>) => void> = [];
  socket.on('message', (data) => {
    const decoded = JSON.parse(text(data)) as Record<string, unknown>;
    all.push(decoded);
    const resolve = waiting.shift();
    if (resolve) resolve(decoded);
    else queued.push(decoded);
  });
  return {
    next: async () => {
      const existing = queued.shift();
      if (existing) return existing;
      return new Promise((resolve) => waiting.push(resolve));
    },
    seen: () => [...all]
  };
}

interface QueuedDelivery {
  readonly delivery_id: string;
  readonly body: Record<string, unknown>;
}

interface ClaimCall {
  readonly limit: number | undefined;
  readonly humanReservedLimit: number | undefined;
}

/**
 * Cola de mentira que respeta el MISMO contrato de cupos que `CauceRepository.claimDeliveries`:
 * el humano gana el turno, gasta primero el cupo reservado, y el trabajo agente-a-agente sólo
 * puede ocupar el cupo general. Sin esto el test probaría el doble, no el gateway.
 */
function queuedRepository(options: { beforeClaim?: (call: number) => Promise<void> } = {}): {
  repository: GatewayRepository;
  enqueue: (delivery: QueuedDelivery) => void;
  pending: () => QueuedDelivery[];
  claimCalls: () => ClaimCall[];
} {
  const repository = fakeRepository();
  const queue: QueuedDelivery[] = [];
  const calls: ClaimCall[] = [];
  let sequence = 0;

  vi.mocked(repository.claimDeliveries).mockImplementation(async (
    tenantId, alias, _instanceId, epoch, limit, _ackDeadlineMs, _interactiveBurst, admission
  ) => {
    calls.push({ limit, humanReservedLimit: admission?.humanReservedLimit });
    await options.beforeClaim?.(calls.length);
    let general = limit ?? 20;
    let reserved = admission?.humanReservedLimit ?? 0;
    const claimed: DeliveryClaimRecord[] = [];
    for (;;) {
      const humanIndex = queue.findIndex((item) => !isAgentToAgentBody(item.body));
      const agentIndex = queue.findIndex((item) => isAgentToAgentBody(item.body));
      let index = -1;
      let human = false;
      if (humanIndex >= 0 && (reserved > 0 || general > 0)) {
        index = humanIndex;
        human = true;
      } else if (agentIndex >= 0 && general > 0) {
        index = agentIndex;
      }
      if (index < 0) break;
      const [taken] = queue.splice(index, 1);
      if (!taken) break;
      if (human && reserved > 0) reserved -= 1;
      else general -= 1;
      sequence += 1;
      claimed.push({
        type: 'delivery',
        version: '3.0',
        delivery_id: taken.delivery_id,
        event_id: taken.delivery_id,
        message_id: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        request_id: `30000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        trace_id: `trace-${taken.delivery_id}`,
        epoch,
        attempt: 1,
        claim_token: `40000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        ack_deadline_at: new Date(Date.now() + 600_000).toISOString(),
        tenant_id: tenantId,
        room_id: 'grp.pablo',
        actor_alias: 'kant',
        recipient_alias: alias,
        body: taken.body
      });
    }
    return claimed;
  });

  return {
    repository,
    enqueue: (delivery) => queue.push(delivery),
    pending: () => [...queue],
    claimCalls: () => [...calls]
  };
}

function agentBody(text_: string): Record<string, unknown> {
  return { type: 'agent.message', text: text_, from_alias: 'kant' };
}

function humanBody(text_: string): Record<string, unknown> {
  return { text: text_ };
}

function deliveryId(index: number): string {
  return `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function connect(port: number, instanceId: string): Promise<{
  socket: WebSocket;
  next: () => Promise<Record<string, unknown>>;
  seen: () => Record<string, unknown>[];
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v3/ws`, {
    headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
  });
  sockets.push(socket);
  const reader = frameReader(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
    instance_id: instanceId, capabilities: ['acks.v3', 'renewable_delivery_claims_v1']
  }));
  expect(await reader.next()).toMatchObject({ type: 'hello_ack', epoch: 1 });
  return { socket, next: reader.next, seen: reader.seen };
}

describe('gateway delivery admission control', () => {
  it('claims at most the configured in-flight budget instead of the store default of 20', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 10; index += 1) {
      store.enqueue({ delivery_id: deliveryId(index), body: agentBody(`work ${index}`) });
    }
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 2, humanReservedDeliveries: 2 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'bounded-consumer');

    expect(await session.next()).toMatchObject({ type: 'delivery', delivery_id: deliveryId(1) });
    expect(await session.next()).toMatchObject({ type: 'delivery', delivery_id: deliveryId(2) });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Las otras ocho siguen en la cola: el cupo reservado NO se le presta al trabajo de agentes.
    expect(store.pending()).toHaveLength(8);
    expect(session.seen().filter((frame) => frame.type === 'delivery')).toHaveLength(2);
    expect(store.claimCalls()[0]).toEqual({ limit: 2, humanReservedLimit: 2 });
  });

  it('admits a human message while agent-to-agent work holds every general slot', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 5; index += 1) {
      store.enqueue({ delivery_id: deliveryId(index), body: agentBody(`long task ${index}`) });
    }
    let wake: ((notice: { tenant_id: string; alias: string }) => void) | undefined;
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: async (_pool, listener) => {
        wake = listener;
        return async () => undefined;
      },
      // Un solo hueco general: es el peor caso del reclamo del dueño, "el único slot está
      // ocupado por una tarea de 40 minutos".
      admission: { maxInflightDeliveries: 1, humanReservedDeliveries: 1 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'busy-assistant');

    expect(await session.next()).toMatchObject({
      type: 'delivery', delivery_id: deliveryId(1), body: { type: 'agent.message' }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // El cupo general quedó lleno y la tarea larga NO se ACKea: sigue corriendo, como debe ser.
    expect(session.seen().filter((frame) => frame.type === 'delivery')).toHaveLength(1);

    store.enqueue({ delivery_id: deliveryId(99), body: humanBody('¿cómo venís con eso?') });
    wake?.({ tenant_id: 'Pablo', alias: 'midas' });

    expect(await session.next()).toMatchObject({ type: 'wake' });
    // Acá está todo el punto: entra por el cupo reservado, en el mismo tick, sin haber
    // cancelado, interrumpido ni acortado la tarea de agente que sigue en vuelo.
    expect(await session.next()).toMatchObject({
      type: 'delivery',
      delivery_id: deliveryId(99),
      body: { text: '¿cómo venís con eso?' }
    });
    expect(store.claimCalls().at(-1)).toEqual({ limit: 0, humanReservedLimit: 1 });
    // Las cuatro tareas de agente restantes siguen esperando su turno: el humano no les robó
    // el cupo, usó el suyo.
    expect(store.pending()).toHaveLength(4);
  });

  it('serves a human message before queued agent work when both are waiting', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 4; index += 1) {
      store.enqueue({ delivery_id: deliveryId(index), body: agentBody(`chain hop ${index}`) });
    }
    store.enqueue({ delivery_id: deliveryId(99), body: humanBody('hola') });
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 1, humanReservedDeliveries: 1 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'queued-assistant');

    const first = await session.next();
    const second = await session.next();
    // El mensaje humano llegó último a la cola y sale primero. Antes salía quinto, detrás de
    // toda la cadena de agentes: por eso midas esperaba 114 minutos de mediana.
    expect([first, second].map((frame) => frame.delivery_id)).toContain(deliveryId(99));
    expect(first.delivery_id).toBe(deliveryId(99));
  });

  it('drains again as soon as a terminal ACK frees an in-flight slot', async () => {
    const store = queuedRepository();
    store.enqueue({ delivery_id: deliveryId(1), body: agentBody('first') });
    store.enqueue({ delivery_id: deliveryId(2), body: agentBody('second') });
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      // Sin wakes externos: si el gateway no vuelve a drenar solo al liberarse la garra, el
      // agente se queda sin trabajo para siempre con la cola llena. Ese es el riesgo principal
      // del parche y este test es el que lo cubre.
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 1, humanReservedDeliveries: 0 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'single-slot-consumer');

    const first = await session.next();
    expect(first).toMatchObject({ type: 'delivery', delivery_id: deliveryId(1) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.pending()).toHaveLength(1);

    session.socket.send(JSON.stringify({
      type: 'ack', version: '3.0', event_id: '50000000-0000-4000-8000-000000000001',
      delivery_id: deliveryId(1), attempt: 1, claim_token: first.claim_token,
      status: 'done', instance_id: 'single-slot-consumer', epoch: 1
    }));
    expect(await session.next()).toMatchObject({ type: 'ack_result', delivery_id: deliveryId(1) });
    expect(await session.next()).toMatchObject({ type: 'delivery', delivery_id: deliveryId(2) });
    expect(store.pending()).toHaveLength(0);
  });

  it('does not lose a wake that arrives while a drain is already in flight', async () => {
    let releaseFirstClaim!: () => void;
    const firstClaimGate = new Promise<void>((resolve) => {
      releaseFirstClaim = resolve;
    });
    let claimCount = 0;
    const store = queuedRepository({
      beforeClaim: async (call) => {
        claimCount = call;
        if (call === 1) await firstClaimGate;
      }
    });
    store.enqueue({ delivery_id: deliveryId(1), body: humanBody('primero') });
    let wake: ((notice: { tenant_id: string; alias: string }) => void) | undefined;
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: async (_pool, listener) => {
        wake = listener;
        return async () => undefined;
      },
      admission: { maxInflightDeliveries: 2, humanReservedDeliveries: 2 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'racing-consumer');

    await vi.waitFor(() => expect(claimCount).toBe(1));
    // El wake llega con el drenaje en curso. Antes se descartaba con `if (draining) return` y,
    // con cupo, eso puede ser el único aviso de que había trabajo esperando.
    store.enqueue({ delivery_id: deliveryId(2), body: humanBody('segundo') });
    wake?.({ tenant_id: 'Pablo', alias: 'midas' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirstClaim();

    // Sin `drainAgain` la segunda entrega no sale nunca: no hay más wakes, no hay ACK que
    // libere cupo y el outbox está en 60 s. Que llegue es la prueba de que el aviso perdido
    // se recuperó al terminar el drenaje en curso.
    await vi.waitFor(() => {
      expect(new Set(session.seen()
        .filter((frame) => frame.type === 'delivery')
        .map((frame) => frame.delivery_id)))
        .toEqual(new Set([deliveryId(1), deliveryId(2)]));
    });
    expect(claimCount).toBeGreaterThanOrEqual(2);
  });

  /**
   * El desenlace MÁS frecuente bajo saturación, y el que se colaba: un ACK que la base resuelve
   * como 'retry'. Ahí la entrega deja de ser de nadie —claim_token, consumer y plazo van a
   * NULL— pero el gateway se la quedaba en `session.claims` hasta que venciera su
   * `admissionExpiresAtMs`. Con el cupo en 1, un solo fallo reintentable dejaba al agente en
   * CUPO CERO durante media hora: exactamente el modo de falla que este parche existe para
   * evitar.
   */
  it('frees the in-flight slot when an ACK resolves to retry, not only on terminal states', async () => {
    const store = queuedRepository();
    store.enqueue({ delivery_id: deliveryId(1), body: agentBody('rate limited') });
    store.enqueue({ delivery_id: deliveryId(2), body: agentBody('siguiente') });
    vi.mocked(store.repository.ackDelivery).mockImplementation(async (id: string) => ({
      delivery_id: id,
      status: 'retry' as const,
      applied: true,
      receipt: 'applied' as const
    }));
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 1, humanReservedDeliveries: 0 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'retrying-consumer');

    const first = await session.next();
    expect(first).toMatchObject({ type: 'delivery', delivery_id: deliveryId(1) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.pending()).toHaveLength(1);

    session.socket.send(JSON.stringify({
      type: 'ack', version: '3.0', event_id: '50000000-0000-4000-8000-000000000011',
      delivery_id: deliveryId(1), attempt: 1, claim_token: first.claim_token,
      status: 'failed', retryable: true, instance_id: 'retrying-consumer', epoch: 1
    }));
    expect(await session.next()).toMatchObject({ type: 'ack_result', status: 'retry' });
    // Con el cupo liberado, la siguiente entrega sale en el mismo drenaje. Sin el arreglo esto
    // no llegaba nunca: `claimDeliveries` se llamaba con limit 0 y la cola quedaba parada.
    expect(await session.next()).toMatchObject({ type: 'delivery', delivery_id: deliveryId(2) });
    expect(store.claimCalls().at(-1)).toEqual({ limit: 1, humanReservedLimit: 0 });
  });

  /**
   * El cupo no puede vivir sólo en la RAM del socket. Con `renewable_delivery_claims_v1` el
   * lease y la época SOBREVIVEN a la reconexión a propósito, así que las garras siguen vivas en
   * la base; un `claims: new Map()` en cada hello le devolvía el presupuesto entero al
   * adaptador y un consumidor con flapping se llevaba una entrega por reconexión.
   */
  it('rebuilds the in-flight budget from the store instead of handing it back on every reconnect', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 3; index += 1) {
      store.enqueue({ delivery_id: deliveryId(index), body: agentBody(`work ${index}`) });
    }
    const live: Array<{
      delivery_id: string; attempt: number; claim_token: string;
      ack_deadline_at: string; agent_to_agent: boolean;
    }> = [];
    const repository = {
      ...store.repository,
      // Espejo mínimo de `CauceRepository.liveDeliveryClaims`: lo que la base sigue teniendo
      // con el plazo de ACK corriendo para este alias, sin importar qué socket lo reclamó.
      liveDeliveryClaims: vi.fn(async () => [...live])
    };
    vi.mocked(store.repository.claimDeliveries).mockImplementation(
      (function wrap(original) {
        return async (...args: Parameters<typeof original>) => {
          const claimed = await original(...args);
          for (const delivery of claimed) {
            live.push({
              delivery_id: delivery.delivery_id,
              attempt: delivery.attempt,
              claim_token: delivery.claim_token,
              ack_deadline_at: delivery.ack_deadline_at,
              agent_to_agent: isAgentToAgentBody(delivery.body)
            });
          }
          return claimed;
        };
      })(vi.mocked(store.repository.claimDeliveries).getMockImplementation()!)
    );
    const app = await buildGateway({
      pool: fakePool(),
      repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 1, humanReservedDeliveries: 0 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const first = await connect(port, 'flapping-consumer');
    expect(await first.next()).toMatchObject({ type: 'delivery', delivery_id: deliveryId(1) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Reconecta con el MISMO instance_id, sin haber ACKeado nada: la garra de la primera
    // entrega sigue viva del lado de la base.
    const second = await connect(port, 'flapping-consumer');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(second.seen().filter((frame) => frame.type === 'delivery')).toHaveLength(0);
    // Ni siquiera llegó a preguntar: el presupuesto rehidratado daba cero y el drenaje corta
    // antes de tocar la base. Sigue habiendo UNA sola llamada de reclamo en todo el test.
    expect(store.claimCalls()).toEqual([{ limit: 1, humanReservedLimit: 0 }]);
    expect(vi.mocked(repository.liveDeliveryClaims)).toHaveBeenCalledTimes(2);
    // Dos de tres siguen encoladas: reconectar no multiplicó el cupo.
    expect(store.pending()).toHaveLength(2);
  });

  it('caps a client-chosen HTTP claim limit at the configured budget', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 40; index += 1) {
      store.enqueue({ delivery_id: deliveryId(index), body: agentBody(`bulk ${index}`) });
    }
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 2, humanReservedDeliveries: 2 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v3/query',
      payload: { instance_id: 'http-consumer', epoch: 3, limit: 100 },
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ deliveries: DeliveryClaimRecord[] }>();
    // Sin techo, un solo POST vaciaba 20 entregas de golpe: el mismo lote suicida que el drain.
    expect(body.deliveries).toHaveLength(2);
    expect(store.claimCalls()[0]).toEqual({ limit: 2, humanReservedLimit: 2 });
  });
});
