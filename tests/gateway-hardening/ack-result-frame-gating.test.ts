/* eslint-disable @typescript-eslint/unbound-method */
/**
 * ==============================================================================================
 * THE `ack_result` FRAME, SEEN THE WAY THE ADAPTER SEES IT
 *
 * `AckResult` gained `delegation_rejections` and `chain_gate`. The gateway did
 * `const { receipt, ...legacyResult } = result` and spread `legacyResult` into the frame, so
 * the two new fields went on the wire UNGATED — while the `ack_result` member of
 * `WsOutboundSchema` stayed `.strict()` and unaware of them.
 *
 * On the adapter side that is not a frame that is dropped: `WsOutboundSchema.parse()` throws,
 * and the transport turned that throw into `queue.fail(...)`, which rejects the iterator and
 * everyone waiting on it. A single frame of that shape takes down the ENTIRE connection queue
 * and every in-flight delivery with it.
 *
 * WHY THESE TESTS EXIST, AND WHY THE PREVIOUS ONES FELL SHORT: the delegation-discipline tests
 * asserted on `ackDelivery`'s return value (`result.delegation_rejections?.[0]?.code`), and that
 * value was ALWAYS right. Nobody validated the frame. Here every frame the gateway emits goes
 * through the SAME validator the adapter runs; if the frame drifts out of schema, the test
 * fails the same way the fleet would.
 * ==============================================================================================
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  MAX_DELEGATION_REJECTION_TARGET_CHARS, WsOutboundSchema, type WsOutbound
} from '@cauce/protocol';
import { buildGateway } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { closeGatewaysAndSockets, fakePool, fakeRepository, ids, noDeliveryWakes, text } from './helpers.js';

const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  await closeGatewaysAndSockets(apps, sockets);
});

/**
 * The largest rejection the store can emit: `chain_gated` embeds the gate question, which the
 * database caps at 8 KiB, and the target is agent text trimmed to the schema ceiling. If the
 * largest possible frame did not pass its own schema, the gate would be useless.
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
    // `@all` expansion deliberately shifts the index; it is not an array index.
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
 * Stands up a gateway and an adapter that declares EXACTLY the capabilities passed in. Every
 * frame received is validated with the adapter's validator before being returned.
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
    // THIS is the line that was missing. `websocket-transport.ts` does exactly this with every
    // frame from the gateway, and a throw here took down the whole connection queue.
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
      // Without this, an out-of-schema frame would be a 120 s unexplained timeout — exactly what
      // makes this failure mode hard to read in production.
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
    // An adapter from the fleet as it stands today: it does not know `delegation_feedback_v1`.
    const adapter = await connectAdapter(['acks.v3', 'renewable_delivery_claims_v1']);
    adapter.ack();

    // That this `await` resolves is already half the test: if the frame drifted out of schema,
    // the adapter validator would have rejected it and this would fail with the offending fields.
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
    // And they do not arrive via spread: the gateway pulls them out of `legacyResult` by hand.
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
    // The gate must not degrade content: the worst case the store can produce — an 8 KiB
    // question and a target at the ceiling — travels whole and validates.
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
    // `receipt` keeps its own gate: this test also guards that precedent.
    expect(frame).not.toHaveProperty('receipt');
  });
});
