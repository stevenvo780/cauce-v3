/* eslint-disable @typescript-eslint/unbound-method */
import { afterEach, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import { HUMAN_PRIORITY_FLOOR } from '@cauce/protocol';
import { buildGateway, type DeliveryClaimRecord, type GatewayRepository } from '../../services/gateway/src/index.js';
import { closeGatewaysAndSockets, fakeRepository, frameReader } from './helpers.js';

export const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];
export const HTTP_CONNECTION_TOKEN = '90000000-0000-4000-8000-000000000009';
export const sockets: WebSocket[] = [];

export function registerDeliveryAdmissionTeardown(): void {
  afterEach(async () => {
    await closeGatewaysAndSockets(apps, sockets);
  });
}

export function frameSession(socket: WebSocket): {
  next: () => Promise<Record<string, unknown>>;
  seen: () => Record<string, unknown>[];
} {
  const all: Record<string, unknown>[] = [];
  return { next: frameReader(socket, all), seen: () => [...all] };
}

export interface QueuedDelivery {
  readonly delivery_id: string;
  readonly body: Record<string, unknown>;
  readonly priority: number;
}

export interface ClaimCall {
  readonly limit: number | undefined;
  readonly generalCapacity: number | undefined;
  readonly humanReservedCapacity: number | undefined;
  readonly maxClaims: number | undefined;
  readonly requireDeclaredCapacity: boolean | undefined;
}

export interface ActiveDeliveryClaim {
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly ack_deadline_at: string;
  readonly human_originated: boolean;
}

/**
 * Fake queue that honors the SAME capacity contract as `CauceRepository.claimDeliveries`: the
 * human wins the turn, spends the reserved budget first, and agent-to-agent work can only fill
 * the general budget. Without this the test would exercise the double, not the gateway.
 */
export function queuedRepository(options: { beforeClaim?: (call: number) => Promise<void> } = {}): {
  repository: GatewayRepository;
  enqueue: (delivery: QueuedDelivery) => void;
  pending: () => QueuedDelivery[];
  claimCalls: () => ClaimCall[];
  liveClaims: () => ActiveDeliveryClaim[];
  release: (deliveryId: string) => void;
} {
  const repository = fakeRepository();
  const queue: QueuedDelivery[] = [];
  const calls: ClaimCall[] = [];
  const active = new Map<string, ActiveDeliveryClaim>();
  let sequence = 0;

  vi.mocked(repository.claimDeliveries).mockImplementation(async (
    tenantId, alias, _instanceId, epoch, limit, _ackDeadlineMs, _interactiveBurst, admission
  ) => {
    calls.push({
      limit,
      generalCapacity: admission?.generalCapacity,
      humanReservedCapacity: admission?.humanReservedCapacity,
      maxClaims: admission?.maxClaims,
      requireDeclaredCapacity: admission?.requireDeclaredCapacity,
    });
    await options.beforeClaim?.(calls.length);
    const generalCapacity = admission?.generalCapacity ?? limit ?? 20;
    const reservedCapacity = admission?.humanReservedCapacity ?? 0;
    const maxClaims = admission?.maxClaims ?? limit ?? 20;
    const activeHuman = [...active.values()].filter((claim) => claim.human_originated).length;
    const reservedInFlight = Math.min(activeHuman, reservedCapacity);
    let general = Math.max(0, generalCapacity - (active.size - reservedInFlight));
    let reserved = Math.max(0, reservedCapacity - reservedInFlight);
    const claimed: DeliveryClaimRecord[] = [];
    while (claimed.length < maxClaims) {
      const humanIndex = queue.findIndex((item) => item.priority >= HUMAN_PRIORITY_FLOOR);
      const agentIndex = queue.findIndex((item) => item.priority < HUMAN_PRIORITY_FLOOR);
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
      const claimToken = `40000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
      const ackDeadlineAt = new Date(Date.now() + 600_000).toISOString();
      active.set(taken.delivery_id, {
        delivery_id: taken.delivery_id,
        attempt: 1,
        claim_token: claimToken,
        ack_deadline_at: ackDeadlineAt,
        human_originated: human,
      });
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
        claim_token: claimToken,
        ack_deadline_at: ackDeadlineAt,
        tenant_id: tenantId,
        room_id: 'grp.pablo',
        actor_alias: 'kant',
        recipient_alias: alias,
        body: taken.body
      });
    }
    return claimed;
  });
  vi.mocked(repository.ackDelivery).mockImplementation(async (deliveryId: string) => {
    active.delete(deliveryId);
    return {
      delivery_id: deliveryId,
      status: 'done' as const,
      applied: true,
      receipt: 'applied' as const,
    };
  });

  return {
    repository,
    enqueue: (delivery) => queue.push(delivery),
    pending: () => [...queue],
    claimCalls: () => [...calls],
    liveClaims: () => [...active.values()],
    release: (deliveryId) => active.delete(deliveryId),
  };
}

export function agentBody(text_: string): Record<string, unknown> {
  return { type: 'agent.message', text: text_, from_alias: 'kant' };
}

export function humanBody(text_: string): Record<string, unknown> {
  return { text: text_ };
}

export function agentDelivery(index: number, text_: string): QueuedDelivery {
  return { delivery_id: deliveryId(index), body: agentBody(text_), priority: 0 };
}

export function humanDelivery(
  index: number,
  text_: string,
  body: Record<string, unknown> = humanBody(text_),
): QueuedDelivery {
  return { delivery_id: deliveryId(index), body, priority: HUMAN_PRIORITY_FLOOR };
}

export function deliveryId(index: number): string {
  return `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

export async function connect(port: number, instanceId: string): Promise<{
  socket: WebSocket;
  next: () => Promise<Record<string, unknown>>;
  seen: () => Record<string, unknown>[];
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
    headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
  });
  sockets.push(socket);
  const reader = frameSession(socket);
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
