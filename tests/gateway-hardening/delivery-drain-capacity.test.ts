/* eslint-disable @typescript-eslint/unbound-method */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { buildGateway, type DeliveryClaimRecord } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import {
  DEFAULT_HUMAN_RESERVED_DELIVERIES, DEFAULT_MAX_INFLIGHT_DELIVERIES
} from '../../services/gateway/src/config.js';
import { fakePool, fakeRepository, ids, noDeliveryWakes } from './helpers.js';

// El riesgo que introduce el techo de concurrencia, aislado.
//
// Con techo, un drain puede volver vacío por estar el agente lleno. A partir de ahí el backlog
// sólo avanza si el gateway vuelve a reclamar cuando se libera capacidad. El único instante en que
// eso ocurre es un ACK que saca la entrega del conjunto no terminal. Antes de este cambio el
// gateway sólo drenaba tras un ACK 'retry': con techo, eso deja una cola de 90 esperando a que
// alguien publique la 91.

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

function frameReader(socket: WebSocket): () => Promise<Record<string, unknown>> {
  const queued: Record<string, unknown>[] = [];
  const waiting: Array<(value: Record<string, unknown>) => void> = [];
  socket.on('message', (data) => {
    const decoded = JSON.parse(text(data)) as Record<string, unknown>;
    const resolve = waiting.shift();
    if (resolve) resolve(decoded);
    else queued.push(decoded);
  });
  return async () => {
    const existing = queued.shift();
    if (existing) return existing;
    return new Promise((resolve) => waiting.push(resolve));
  };
}

function claim(deliveryId: string, claimToken: string): DeliveryClaimRecord {
  return {
    type: 'delivery', delivery_id: deliveryId, event_id: deliveryId, attempt: 1,
    claim_token: claimToken, version: '3.0', message_id: ids.message, request_id: ids.request,
    trace_id: 'trace-capacity', epoch: 1,
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(), tenant_id: 'Pablo',
    room_id: 'grp.pablo', actor_alias: 'seneca', recipient_alias: 'midas', body: { text: 'work' }
  };
}

async function connect(
  repository: ReturnType<typeof fakeRepository>,
  overrides: Record<string, unknown> = {}
): Promise<{ socket: WebSocket; next: () => Promise<Record<string, unknown>> }> {
  const app = await buildGateway({
    pool: fakePool(),
    repository,
    authProvider: DevOnlyAuthProvider.forTests(),
    deliveryWakeSubscriber: noDeliveryWakes,
    ackDeadlineMs: 600_000,
    outboxPollMs: 60_000,
    ...overrides
  });
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v3/ws`, {
    headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
  });
  sockets.push(socket);
  const next = frameReader(socket);
  await new Promise((resolve) => socket.on('open', resolve));
  socket.send(JSON.stringify({
    type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
    instance_id: 'midas-1', capabilities: []
  }));
  const ack = await next();
  expect(ack.type).toBe('hello_ack');
  return { socket, next };
}

describe('drain keeps moving when capacity is what gates the claim', () => {
  it('claims again after a terminal ACK, not only after a retry', async () => {
    // El atasco duro: el agente estaba lleno, termina su trabajo y nadie vuelve a preguntar.
    const repository = fakeRepository();
    vi.mocked(repository.claimDeliveries)
      .mockResolvedValueOnce([claim(ids.delivery, ids.claim)])   // drain del hello: llena el cupo
      .mockResolvedValueOnce([claim(ids.deliveryTwo, ids.claimTwo)]) // drain tras el ACK terminal
      .mockResolvedValue([]);
    vi.mocked(repository.ackDelivery).mockResolvedValue({
      delivery_id: ids.delivery, status: 'done', applied: true, receipt: 'applied'
    });

    const { socket, next } = await connect(repository);
    const first = await next();
    expect(first.delivery_id).toBe(ids.delivery);

    socket.send(JSON.stringify({
      type: 'ack', delivery_id: ids.delivery, version: '3.0', event_id: ids.event,
      status: 'done', instance_id: 'midas-1', epoch: 1, claim_token: ids.claim,
      attempt: 1, retryable: false
    }));

    const ackResult = await next();
    expect(ackResult.type).toBe('ack_result');
    // Sin el re-drain en estado terminal esto nunca llega y la prueba muere por timeout.
    const second = await next();
    expect(second.type).toBe('delivery');
    expect(second.delivery_id).toBe(ids.deliveryTwo);
  });

  it.each(['failed', 'dead'] as const)(
    'also claims again after a %s ACK, which frees the slot just the same',
    async (status) => {
      const repository = fakeRepository();
      vi.mocked(repository.claimDeliveries)
        .mockResolvedValueOnce([claim(ids.delivery, ids.claim)])
        .mockResolvedValueOnce([claim(ids.deliveryTwo, ids.claimTwo)])
        .mockResolvedValue([]);
      vi.mocked(repository.ackDelivery).mockResolvedValue({
        delivery_id: ids.delivery, status, applied: true, receipt: 'applied'
      });

      const { socket, next } = await connect(repository);
      await next();
      socket.send(JSON.stringify({
        type: 'ack', delivery_id: ids.delivery, version: '3.0', event_id: ids.event,
        status: 'failed', instance_id: 'midas-1', epoch: 1, claim_token: ids.claim,
        attempt: 1, retryable: false, error: 'boom'
      }));
      await next();
      const second = await next();
      expect(second.delivery_id).toBe(ids.deliveryTwo);
    }
  );

  it('coalesces a wake that lands while a drain is already in flight', async () => {
    // El segundo agujero, y el único camino por el que dos drains se solapan de verdad: los frames
    // del socket están serializados por frameQueue, pero el handler de pg_notify llama a drain()
    // fuera de esa cola. La implementación vieja descartaba ese drain por el flag `draining`. Se
    // toleraba porque el drain en curso reclamaba hasta 20 y vaciaba la cola igual; con techo, el
    // drain descartado puede ser justo el que venía a buscar trabajo con el cupo recién liberado.
    const repository = fakeRepository();
    let wake: ((notice: { tenant_id: string; alias: string }) => void) | undefined;
    const subscriber: NonNullable<Parameters<typeof buildGateway>[0]['deliveryWakeSubscriber']> =
      async (_pool, listener) => {
        wake = listener;
        return async () => undefined;
      };

    let release: (() => void) | undefined;
    const firstClaimStarted = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    vi.mocked(repository.claimDeliveries).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return [];
      }
      if (calls === 2) return [claim(ids.deliveryTwo, ids.claimTwo)];
      return [];
    });

    const { next } = await connect(repository, { deliveryWakeSubscriber: subscriber });
    await firstClaimStarted;
    // Llega mientras el primer claim sigue en vuelo.
    wake?.({ tenant_id: 'Pablo', alias: 'midas' });

    const frames: Record<string, unknown>[] = [];
    for (let index = 0; index < 2; index += 1) frames.push(await next());
    // El frame 'wake' sale siempre; el 'delivery' sólo si el drain solapado no se perdió.
    expect(frames.map((frame) => frame.type)).toContain('delivery');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  // INTEGRACIÓN 2026-07-29. Estos dos tests nacieron contra un `drain()` que pasaba
  // `deliveryClaimLimit` como límite. En la línea integrada quien manda es el cupo de admisión
  // por sesión (`admissionBudget`), y `deliveryClaimLimit` es el techo de lote por encima de él:
  // el gateway pide `min(cupo, lote)`. Lo que estos tests cuidan sigue siendo lo mismo — que el
  // límite sea un número elegido acá y nunca `undefined` — pero contra la expresión real.
  it('asks the store for an explicit batch size instead of leaving it undefined', async () => {
    // Cupo holgado a propósito: así el que ata es el lote y se ve que el techo explícito manda.
    const repository = fakeRepository();
    await connect(repository, {
      deliveryClaimLimit: 4,
      admission: { maxInflightDeliveries: 10, humanReservedDeliveries: 0 }
    });
    expect(vi.mocked(repository.claimDeliveries)).toHaveBeenCalledWith(
      'Pablo', 'midas', 'midas-1', 1, 4, 600_000, undefined, { humanReservedLimit: 0 }
    );
  });

  it('defaults the batch size to a real number rather than undefined', async () => {
    const repository = fakeRepository();
    await connect(repository);
    const [, , , , limit, , , admission] = vi.mocked(repository.claimDeliveries).mock.calls[0]!;
    // Con los defaults ata el cupo de admisión (2 general + 2 reservado al humano), no el lote.
    expect(limit).toBe(DEFAULT_MAX_INFLIGHT_DELIVERIES);
    expect(admission).toEqual({ humanReservedLimit: DEFAULT_HUMAN_RESERVED_DELIVERIES });
  });

  it('rejects a batch size the store would refuse anyway', async () => {
    await expect(buildGateway({
      pool: fakePool(),
      repository: fakeRepository(),
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      deliveryClaimLimit: 0
    })).rejects.toThrow(/deliveryClaimLimit/);
  });
});
