/* eslint-disable @typescript-eslint/unbound-method */
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { StoreError } from '@cauce/store';
import { buildGateway, type DeliveryClaimRecord } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { fakePool, fakeRepository, noDeliveryWakes } from './helpers.js';
import {
  agentDelivery, apps, connect, frameSession, HTTP_CONNECTION_TOKEN, queuedRepository,
  registerDeliveryAdmissionTeardown, sockets,
} from './delivery-admission-helpers.js';

registerDeliveryAdmissionTeardown();

describe('gateway delivery admission control', () => {
  it('fails recovery visibly without expiring renewable claims from the acquired epoch', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.liveDeliveryClaims).mockRejectedValueOnce(new Error('database unavailable'));
    const app = await buildGateway({
      pool: fakePool(),
      repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(socket);
    const reader = frameSession(socket);
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => { resolve(code); });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'recovery-fails', capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    }));

    expect(await reader.next()).toMatchObject({
      type: 'error', code: 'delivery_unavailable',
      message: 'durable delivery claim recovery is unavailable',
    });
    await expect(closed).resolves.toBe(1011);
    expect(repository.releaseLease).not.toHaveBeenCalled();
    expect(repository.claimDeliveries).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'missing capacity with original prose', error: new StoreError(
      'conflict', 'delivery consumer is missing its durable agent capacity', 'consumer_capacity_missing',
    ), wire: 'consumer_not_declared', message: 'consumer has no durable delivery capacity declaration',
    status: 4403, close: 'consumer not declared' },
    { name: 'missing capacity with changed prose', error: new StoreError(
      'conflict', 'the declaration was removed after hello', 'consumer_capacity_missing',
    ), wire: 'consumer_not_declared', message: 'consumer has no durable delivery capacity declaration',
    status: 4403, close: 'consumer not declared' },
    { name: 'invalid capacity remains unavailable', error: new StoreError(
      'conflict', 'the declaration is now malformed', 'consumer_capacity_invalid',
    ), wire: 'delivery_unavailable', message: 'durable delivery admission is unavailable',
    status: 1011, close: 'delivery unavailable' },
    { name: 'generic conflict cannot inherit a reason from prose', error: new StoreError(
      'conflict', 'delivery consumer is missing its durable agent capacity',
    ), wire: 'delivery_unavailable', message: 'durable delivery admission is unavailable',
    status: 1011, close: 'delivery unavailable' },
    { name: 'fencing preserves its exact public result', error: new StoreError('fenced', 'the claim lease changed'),
      wire: 'fenced', message: 'the claim lease changed', status: 4401, close: 'fenced' },
  ])('preserves the post-hello drain outcome: $name', async (expected) => {
    const repository = fakeRepository();
    vi.mocked(repository.claimDeliveries).mockRejectedValueOnce(expected.error);
    const app = await buildGateway({
      pool: fakePool(), repository, authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes, outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(socket);
    const reader = frameSession(socket);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => { resolve({ code, reason: reason.toString('utf8') }); });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'post-hello-capacity', capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    }));

    expect(await reader.next()).toMatchObject({ type: 'hello_ack', version: '3.0', epoch: 1 });
    expect(await reader.next()).toEqual({ type: 'error', code: expected.wire, message: expected.message });
    await expect(closed).resolves.toEqual({ code: expected.status, reason: expected.close });
    expect(repository.acquireLease).toHaveBeenCalledOnce();
    expect(repository.claimDeliveries).toHaveBeenCalledOnce();
    expect(repository.releaseLease).not.toHaveBeenCalled();
  });

  it.each([
    { code: 'conflict', reason: 'consumer_capacity_missing', wire: 'consumer_not_declared', close: 'consumer not declared',
      message: 'consumer has no valid durable delivery capacity declaration' },
    { code: 'conflict', reason: 'consumer_capacity_invalid', wire: 'consumer_not_declared', close: 'consumer not declared',
      message: 'consumer has no valid durable delivery capacity declaration' },
    { code: 'forbidden', reason: 'consumer_disabled', wire: 'consumer_disabled', close: 'consumer disabled',
      message: 'consumer agent is disabled and cannot establish a delivery lease' },
  ] as const)('closes an unavailable consumer by reason, independently of prose: $reason', async (expected) => {
    const repository = fakeRepository();
    vi.mocked(repository.acquireLease).mockRejectedValueOnce(new StoreError(
      expected.code, 'reworded durable consumer admission failure', expected.reason,
    ));
    const app = await buildGateway({
      pool: fakePool(), repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(socket);
    const reader = frameSession(socket);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => { resolve({ code, reason: reason.toString('utf8') }); });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'undeclared-consumer',
      capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    }));

    expect(await reader.next()).toEqual({
      type: 'error', code: expected.wire, message: expected.message,
    });
    await expect(closed).resolves.toEqual({ code: 4403, reason: expected.close });
    expect(repository.releaseLease).not.toHaveBeenCalled();
    expect(repository.claimDeliveries).not.toHaveBeenCalled();
  });

  it('rejects HTTP hello atomically without creating a lease when durable capacity is missing', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.acquireLease).mockRejectedValueOnce(new StoreError(
      'conflict', 'delivery consumer is missing its durable agent capacity',
    ));
    const app = await buildGateway({
      pool: fakePool(), repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST', url: '/v3/connections/hello',
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
      payload: {
        type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
        instance_id: 'undeclared-http-consumer', capabilities: ['acks.v3'],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'conflict', message: 'delivery consumer is missing its durable agent capacity',
    });
    expect(repository.acquireLease).toHaveBeenCalledWith(
      'Pablo', 'midas', 'undeclared-http-consumer', ['acks.v3'], 180_000,
      { requireDeclaredCapacity: true, requireEnabledAgent: true },
    );
    expect(repository.releaseLease).not.toHaveBeenCalled();
    expect(response.body).not.toContain('connection_token');
  });

  it('lets only the newest simultaneous resume install the local session', async () => {
    const repository = fakeRepository();
    let releaseFirstRecovery!: () => void;
    const firstRecoveryGate = new Promise<void>((resolve) => { releaseFirstRecovery = resolve; });
    let firstRecoveryStarted!: () => void;
    const firstRecoveryObserved = new Promise<void>((resolve) => { firstRecoveryStarted = resolve; });
    let recoveryCalls = 0;
    vi.mocked(repository.liveDeliveryClaims).mockImplementation(async () => {
      recoveryCalls += 1;
      if (recoveryCalls === 1) {
        firstRecoveryStarted();
        await firstRecoveryGate;
      }
      return [];
    });
    const app = await buildGateway({
      pool: fakePool(), repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const firstSocket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(firstSocket);
    const firstReader = frameSession(firstSocket);
    const firstClosed = new Promise<number>((resolve) => {
      firstSocket.once('close', (code) => { resolve(code); });
    });
    await new Promise<void>((resolve, reject) => {
      firstSocket.once('open', resolve);
      firstSocket.once('error', reject);
    });
    const hello = {
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'simultaneous-resume',
      capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    };
    firstSocket.send(JSON.stringify(hello));
    await firstRecoveryObserved;

    const current = await connect(port, 'simultaneous-resume');
    releaseFirstRecovery();
    expect(await firstReader.next()).toMatchObject({ type: 'error', code: 'fenced' });
    await expect(firstClosed).resolves.toBe(4401);

    current.socket.send(JSON.stringify({
      type: 'heartbeat', instance_id: 'simultaneous-resume', epoch: 1,
    }));
    expect(await current.next()).toMatchObject({ type: 'heartbeat_ack' });
    expect(repository.heartbeat).toHaveBeenCalledTimes(4);
  });

  it('fences an older acquire response that arrives after a newer resume', async () => {
    const repository = fakeRepository();
    let releaseFirstAcquire!: () => void;
    const firstAcquireGate = new Promise<void>((resolve) => { releaseFirstAcquire = resolve; });
    let firstAcquireStarted!: () => void;
    const firstAcquireObserved = new Promise<void>((resolve) => { firstAcquireStarted = resolve; });
    let acquireCalls = 0;
    let currentToken = '';
    vi.mocked(repository.acquireLease).mockImplementation(async () => {
      acquireCalls += 1;
      const token = acquireCalls === 1
        ? '91000000-0000-4000-8000-000000000001'
        : '91000000-0000-4000-8000-000000000002';
      currentToken = token;
      if (acquireCalls === 1) {
        firstAcquireStarted();
        await firstAcquireGate;
      }
      return {
        acquired: true, epoch: 1, connection_token: token,
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    });
    vi.mocked(repository.heartbeat).mockImplementation(async (
      _tenant, _alias, _instance, _epoch, _ttl, token,
    ) => {
      if (token !== currentToken) throw new StoreError('fenced', 'stale connection token');
      return new Date(Date.now() + 60_000).toISOString();
    });
    let releaseCurrentRecovery!: () => void;
    const currentRecoveryGate = new Promise<void>((resolve) => { releaseCurrentRecovery = resolve; });
    let currentRecoveryStarted!: () => void;
    const currentRecoveryObserved = new Promise<void>((resolve) => { currentRecoveryStarted = resolve; });
    vi.mocked(repository.liveDeliveryClaims).mockImplementationOnce(async () => {
      currentRecoveryStarted();
      await currentRecoveryGate;
      return [];
    });
    const app = await buildGateway({
      pool: fakePool(), repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const firstSocket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(firstSocket);
    const firstReader = frameSession(firstSocket);
    const firstClosed = new Promise<number>((resolve) => {
      firstSocket.once('close', (code) => { resolve(code); });
    });
    await new Promise<void>((resolve, reject) => {
      firstSocket.once('open', resolve);
      firstSocket.once('error', reject);
    });
    firstSocket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'capacity-race-resume',
      capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    }));
    await firstAcquireObserved;

    const currentSocket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(currentSocket);
    const currentReader = frameSession(currentSocket);
    await new Promise<void>((resolve, reject) => {
      currentSocket.once('open', resolve);
      currentSocket.once('error', reject);
    });
    currentSocket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'capacity-race-resume',
      capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    }));
    await currentRecoveryObserved;

    releaseFirstAcquire();
    expect(await firstReader.next()).toMatchObject({ type: 'error', code: 'fenced' });
    await expect(firstClosed).resolves.toBe(4401);
    releaseCurrentRecovery();
    expect(await currentReader.next()).toMatchObject({ type: 'hello_ack', epoch: 1 });

    currentSocket.send(JSON.stringify({
      type: 'heartbeat', instance_id: 'capacity-race-resume', epoch: 1,
    }));
    expect(await currentReader.next()).toMatchObject({ type: 'heartbeat_ack' });
    expect(repository.heartbeat).toHaveBeenCalledTimes(4);
  });

  it('preserves a renewable lease and its claims when the socket closes during rehydration', async () => {
    const repository = fakeRepository();
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    let recoveryStarted!: () => void;
    const recoveryObserved = new Promise<void>((resolve) => { recoveryStarted = resolve; });
    let calls = 0;
    vi.mocked(repository.liveDeliveryClaims).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        recoveryStarted();
        await recoveryGate;
      }
      return [];
    });
    const app = await buildGateway({
      pool: fakePool(), repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'closed-during-recovery',
      capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    }));
    await recoveryObserved;
    const closed = new Promise<void>((resolve) => socket.once('close', () => { resolve(); }));
    socket.close();
    await closed;
    releaseRecovery();

    const replacement = await connect(port, 'closed-during-recovery');
    replacement.socket.send(JSON.stringify({
      type: 'heartbeat', instance_id: 'closed-during-recovery', epoch: 1,
    }));
    expect(await replacement.next()).toMatchObject({ type: 'heartbeat_ack' });
    // The heartbeat is the barrier: the abandoned hello finished, and the only claim is this one's.
    expect(repository.claimDeliveries).toHaveBeenCalledTimes(1);
    expect(repository.releaseLease).not.toHaveBeenCalled();
  });

  it('caps a client-chosen HTTP claim limit at the configured budget', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 40; index += 1) {
      store.enqueue(agentDelivery(index, `bulk ${String(index)}`));
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
      url: '/v3/deliveries/query',
      payload: {
        instance_id: 'http-consumer', epoch: 3, limit: 100,
        connection_token: HTTP_CONNECTION_TOKEN,
      },
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ deliveries: DeliveryClaimRecord[] }>();
    // Without a cap, a single POST emptied 20 deliveries at once: the same suicidal batch the drain caused.
    expect(body.deliveries).toHaveLength(2);
    expect(store.claimCalls()[0]).toEqual({
      limit: 4, generalCapacity: 2, humanReservedCapacity: 2, maxClaims: 4,
      requireDeclaredCapacity: true,
    });
  });

  it('shares one durable budget across repeated stateless HTTP polls', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 6; index += 1) store.enqueue(agentDelivery(index, `poll ${String(index)}`));
    const app = await buildGateway({
      pool: fakePool(), repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(), deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 2, humanReservedDeliveries: 1 },
      ackDeadlineMs: 600_000, outboxPollMs: 60_000,
    });
    apps.push(app);

    const query = () => app.inject({
      method: 'POST', url: '/v3/deliveries/query',
      payload: {
        instance_id: 'http-repeat', epoch: 3, limit: 100,
        connection_token: HTTP_CONNECTION_TOKEN,
      },
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    const first = await query();
    const second = await query();

    expect(first.json<{ deliveries: DeliveryClaimRecord[] }>().deliveries).toHaveLength(2);
    expect(second.json<{ deliveries: DeliveryClaimRecord[] }>().deliveries).toHaveLength(0);
    expect(store.pending()).toHaveLength(4);
  });});
