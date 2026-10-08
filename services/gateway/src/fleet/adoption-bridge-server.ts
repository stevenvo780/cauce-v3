import { chmod } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { LegacyAdoptionError, LegacyAdoptionFactsSchema, type LegacyAdoptionProbe } from '@cauce/store';
import { AdoptionBridgeRequestSchema, adoptionPacketBytes, adoptionTargetKey } from './adoption-bridge-client.js';
import { assertAuthBridgeSocket, prepareAuthBridgeSocket, setAuthBridgeGroup, type AuthBridgeSocketPolicy } from './auth-bridge-socket.js';

type Request = z.infer<typeof AdoptionBridgeRequestSchema>;
export interface LegacyAdoptionBridgeOptions { drain?: () => Promise<void> }
const unavailable = () => new LegacyAdoptionError('unavailable');

function serve(socket: WebSocket, probe: LegacyAdoptionProbe, options: LegacyAdoptionBridgeOptions): Promise<void> {
  const queue: Request[] = [];
  let nextId = 0; let lost = false; let releasing = false; let wake: (() => void) | undefined;
  const fail = () => { lost = true; clearTimeout(timer); wake?.(); if (socket.readyState !== 3) socket.terminate(); };
  const timer = setTimeout(fail, 10_000); timer.unref();
  socket.on('error', fail); socket.on('close', fail);
  socket.on('message', (raw, binary) => {
    try {
      if (lost || releasing || binary || queue.length >= 16) throw unavailable();
      const value = AdoptionBridgeRequestSchema.parse(JSON.parse(adoptionPacketBytes(raw).toString('utf8')));
      if (value.id !== nextId || (value.id === 0) !== (value.action === 'acquire')) throw unavailable();
      nextId += 1; if (value.action === 'release') releasing = true;
      queue.push(value); wake?.();
    } catch { fail(); }
  });
  const receive = async (): Promise<Request> => {
    while (!lost && queue.length === 0) await new Promise<void>(resolve => { wake = resolve; });
    wake = undefined; if (lost) throw unavailable();
    const value = queue.shift(); if (!value) throw unavailable(); return value;
  };
  const reply = (id: number, fields: Record<string, unknown> = {}): Promise<void> => new Promise((resolve, reject) => {
    if (lost || socket.readyState !== 1 || socket.bufferedAmount > 1_048_576) { reject(unavailable()); return; }
    socket.send(JSON.stringify({ version: 1, id, ok: true, ...fields }), error => {
      if (error) { fail(); reject(unavailable()); } else resolve();
    });
  });
  const drain = async () => {
    if (!options.drain) return;
    for (;;) {
      try { await options.drain(); return; } catch { await delay(100); }
    }
  };
  return (async () => {
    try {
      const acquired = await receive(); if (acquired.action !== 'acquire') throw unavailable();
      const releaseId = await probe.withSupervisorFence(acquired.targets, async fence => {
        try {
          if (lost) throw unavailable();
          await fence.assertHeld(); await reply(acquired.id); clearTimeout(timer);
          for (;;) {
            const value = await receive();
            if (value.action === 'release') return value.id;
            if (value.action === 'assertHeld') { await fence.assertHeld(); await reply(value.id); }
            else if (value.action === 'measure') {
              if (!acquired.targets.some(target => adoptionTargetKey(target) === adoptionTargetKey(value.target))) throw unavailable();
              const facts = LegacyAdoptionFactsSchema.parse(await fence.measure(value.target));
              if (adoptionTargetKey(facts.target) !== adoptionTargetKey(value.target)) throw unavailable();
              await reply(value.id, { facts });
            } else throw unavailable();
          }
        } catch (error) { fail(); await drain(); throw error; }
      });
      await reply(releaseId);
    } catch { fail(); }
    finally { clearTimeout(timer); }
  })();
}

export async function startLegacyAdoptionBridge(socketPath: string, probe: LegacyAdoptionProbe,
  policy: AuthBridgeSocketPolicy = { ownerUid: process.geteuid?.() ?? 0 }, options: LegacyAdoptionBridgeOptions = {}) {
  await prepareAuthBridgeSocket(socketPath, policy);
  const app = Fastify({ logger: false }); const running = new Set<Promise<void>>();
  await app.register(websocket, { options: { maxPayload: 1_048_576, perMessageDeflate: false } });
  app.get('/adoption', { websocket: true }, socket => {
    const task = serve(socket, probe, options); running.add(task); void task.finally(() => running.delete(task));
  });
  app.addHook('onClose', async () => { await Promise.all(running); });
  try {
    await app.listen({ path: socketPath }); await chmod(socketPath, 0o660); await setAuthBridgeGroup(socketPath, policy);
    await assertAuthBridgeSocket(socketPath, policy); return await app;
  } catch (error) { await app.close(); throw error; }
}
