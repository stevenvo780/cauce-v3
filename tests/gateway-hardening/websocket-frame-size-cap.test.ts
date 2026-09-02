import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildGateway } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import {
  closeGatewaysAndSockets, fakePool, fakeRepository, noDeliveryWakes,
} from './helpers.js';

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  await closeGatewaysAndSockets(apps, sockets);
});

describe('gateway WebSocket frame size cap', () => {
  it('closes an oversized frame with 1009 before it ever reaches the frame parser', async () => {
    const app = await buildGateway({
      pool: fakePool(),
      repository: fakeRepository(),
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
    socket.on('error', () => undefined);
    const messages: unknown[] = [];
    socket.on('message', (data) => { messages.push(data); });
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => { resolve(code); });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    // One byte over the gateway's configured 16 MiB cap, wrapped in valid JSON so a
    // parse failure -- rather than the size cap -- could never explain the close.
    const oversizedHello = JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'oversized-consumer', capabilities: [], padding: 'x'.repeat(16 * 1024 * 1024),
    });
    socket.send(oversizedHello);

    expect(await closed).toBe(1009);
    expect(messages).toHaveLength(0);
  });
});
