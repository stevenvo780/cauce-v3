import { chmod } from 'node:fs/promises';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { ProviderAuthError, ProviderAuthRequestSchema } from '../console/provider-auth.contracts.js';
import type { ProviderAuthChannel, ProviderAuthService } from '../console/provider-auth.types.js';
import { HostAuthAttachSchema, HostAuthRequestSchema, HostAuthResizeSchema, HostAuthSnapshotSchema, HostAuthTicketSchema } from './auth-bridge-contracts.js';
import { assertAuthBridgeSocket, prepareAuthBridgeSocket, setAuthBridgeGroup, type AuthBridgeSocketPolicy } from './auth-bridge-socket.js';

function attach(socket: WebSocket, service: ProviderAuthService): void {
  let channel: ProviderAuthChannel | undefined;
  let closed = false;
  const isClosed = () => closed;
  let pending = 0;
  let chain = Promise.resolve();
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    if (socket.readyState === 1) socket.close(1008, 'closed');
    if (channel) void channel.close().catch(() => undefined);
  };
  const timer = setTimeout(close, 10_000); timer.unref();
  socket.once('error', close); socket.once('close', close);
  socket.on('message', (raw, binary) => {
    if (closed || pending >= 16) { close(); return; }
    const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (data.byteLength > (channel ? 4096 : 1024)) { close(); return; }
    pending += 1;
    chain = chain.then(async () => {
      if (closed) return;
      if (!channel) {
        if (binary) throw new Error('invalid admission');
        const value = HostAuthAttachSchema.parse(JSON.parse(data.toString('utf8')));
        channel = await service.attach(value.actor, value.id, bytes => {
          if (closed) return;
          if (socket.readyState !== 1 || bytes.byteLength > 65_536 || socket.bufferedAmount > 65_536) { close(); return; }
          socket.send(bytes, { binary: true });
        });
        if (isClosed()) { await channel.close(); return; }
        clearTimeout(timer); socket.send(JSON.stringify({ type: 'ready' }));
      } else if (binary) await channel.input(data);
      else {
        const value = HostAuthResizeSchema.parse(JSON.parse(data.toString('utf8')));
        await channel.resize(value.cols, value.rows);
      }
    }).catch(close).finally(() => { pending -= 1; });
  });
}

export async function startAuthBridge(socketPath: string, service: ProviderAuthService,
  socketPolicy: AuthBridgeSocketPolicy = { ownerUid: process.geteuid?.() ?? 0 }) {
  await prepareAuthBridgeSocket(socketPath, socketPolicy);
  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  app.post('/auth', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const value = HostAuthRequestSchema.parse(request.body);
      if (value.action === 'scope') {
        if (!service.resolve) throw new ProviderAuthError('HOST_UNAVAILABLE');
        return ProviderAuthRequestSchema.parse(await service.resolve(value.actor, value.operation_id));
      }
      if (value.action === 'revoke') { await service.revokeOperation(value.operation_id); return {}; }
      if (value.action === 'start') return HostAuthSnapshotSchema.parse(await service.start(value.actor, value.request));
      if (value.action === 'consume') { await service.consumeSocketTicket(value.actor, value.id, value.ticket); return {}; }
      if (value.action === 'ticket') return HostAuthTicketSchema.parse(await service.issueSocketTicket(value.actor, value.id));
      return HostAuthSnapshotSchema.parse(await service[value.action](value.actor, value.id));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof ProviderAuthError ? error.code : 'HOST_UNAVAILABLE' });
    }
  });
  app.get('/stream', { websocket: true }, socket => { attach(socket, service); });
  app.addHook('onClose', async () => { await service.shutdown(); });
  try {
    await app.listen({ path: socketPath }); await chmod(socketPath, 0o660);
    await setAuthBridgeGroup(socketPath, socketPolicy); await assertAuthBridgeSocket(socketPath, socketPolicy); return await app;
  }
  catch (error) { await app.close(); throw error; }
}
