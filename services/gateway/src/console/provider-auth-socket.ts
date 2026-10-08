import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { ProviderAuthSessionIdSchema } from './provider-auth.contracts.js';
import { providerAuthActor } from './provider-auth.routes.js';
import type { AuthProvider } from '../auth.js';
import type { ProviderAuthManager } from './provider-auth.sessions.js';
import type { ProviderAuthActor, ProviderAuthChannel } from './provider-auth.types.js';

function bytes(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
}
function sameActor(left: ProviderAuthActor, right: ProviderAuthActor): boolean {
  return left.subject === right.subject && left.alias === right.alias && left.tenant_id === right.tenant_id;
}
export async function attachProviderAuthSocket(
  socket: WebSocket, request: FastifyRequest, auth: AuthProvider, manager: ProviderAuthManager, origins: readonly string[],
): Promise<void> {
  let channel: ProviderAuthChannel | undefined;
  let actor: ProviderAuthActor;
  let ended = false;
  let admitting = false;
  let pending = 0;
  let chain = Promise.resolve();
  let revalidate: ReturnType<typeof setInterval> | undefined;
  const end = () => {
    if (ended) return;
    ended = true; clearTimeout(timer); clearInterval(revalidate);
    socket.off('message', onMessage);
    if (socket.readyState === 1) socket.close(1008, 'provider_auth_closed');
    if (channel) void channel.close().catch(() => undefined);
  };
  const currentHuman = async () => {
    if (!sameActor(actor, await providerAuthActor(request, auth))) throw new Error('authority changed');
  };
  const output = (data: Uint8Array) => {
    if (ended) return;
    if (socket.readyState !== 1 || data.byteLength > 65_536 || socket.bufferedAmount > 65_536) { end(); return; }
    try { socket.send(data, { binary: true }); } catch { end(); }
  };
  const id = () => ProviderAuthSessionIdSchema.parse((request.params as { id: string }).id);
  const onMessage = (raw: RawData, binary: boolean) => {
    if (ended) return;
    const data = bytes(raw);
    if (!channel) {
      if (admitting || binary || data.byteLength > 256) { end(); return; }
      let ticket: string;
      try {
        const value = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        if (value.type !== 'auth' || Object.keys(value).length !== 2 || typeof value.ticket !== 'string') { end(); return; }
        ticket = ProviderAuthSessionIdSchema.parse(value.ticket);
      } catch { end(); return; }
      admitting = true;
      void (async () => {
        await admission;
        if (ended) return;
        await currentHuman();
        await manager.consumeSocketTicket(actor, id(), ticket);
        channel = await manager.attach(actor, id(), output);
        if (ended || socket.readyState !== 1) { await channel.close(); return; }
        clearTimeout(timer);
        socket.send(JSON.stringify({ type: 'ready' }));
        let checking = false;
        revalidate = setInterval(() => {
          if (checking) return;
          checking = true;
          void currentHuman().then(async () => {
            const snapshot = await manager.get(actor, id());
            if (!['awaiting_login', 'verifying'].includes(snapshot.status)) end();
          }).catch(end).finally(() => { checking = false; });
        }, 1000);
        revalidate.unref();
      })().catch(end);
      return;
    }
    if (data.byteLength > 4096 || pending >= 16) { end(); return; }
    let action: () => Promise<void>;
    if (binary) action = () => channel?.input(data) ?? Promise.resolve();
    else {
      let value: Record<string, unknown>;
      try { value = JSON.parse(data.toString('utf8')) as Record<string, unknown>; } catch { end(); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'resize' || Object.keys(value).length !== 3 || !Number.isSafeInteger(value.cols) || !Number.isSafeInteger(value.rows)
          || Number(value.cols) < 20 || Number(value.cols) > 400 || Number(value.rows) < 5 || Number(value.rows) > 200) { end(); return; }
      action = () => channel?.resize(Number(value.cols), Number(value.rows)) ?? Promise.resolve();
    }
    pending += 1;
    chain = chain.then(async () => { if (!ended) { await currentHuman(); if (!ended) await action(); } })
      .catch(end).finally(() => { pending -= 1; });
  };
  const timer = setTimeout(end, 10_000); timer.unref();
  socket.once('close', end); socket.once('error', end);
  socket.on('message', onMessage);
  const admission = (async () => {
    if (typeof request.headers.origin !== 'string' || !origins.includes(request.headers.origin)
        || !request.headers.cookie || request.headers.authorization !== undefined || request.url.includes('?')) throw new Error('invalid admission');
    actor = await providerAuthActor(request, auth); id();
  })();
  try { await admission; } catch { end(); }
}

export function registerProviderAuthSocket(
  app: FastifyInstance, auth: AuthProvider, manager: ProviderAuthManager, origins: readonly string[],
): void {
  if (!origins.length || origins.some(origin => { try { return new URL(origin).origin !== origin; } catch { return true; } })) {
    throw new Error('provider auth requires exact configured console origins');
  }
  app.get('/v3/console/provider-auth/sessions/:id/stream', { websocket: true }, (socket, request) => {
    void attachProviderAuthSocket(socket, request, auth, manager, origins);
  });
  app.addHook('onClose', async () => { await manager.shutdown(); });
}
