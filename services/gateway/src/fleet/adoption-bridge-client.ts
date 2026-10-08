import { connect } from 'node:net';
import { WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import { LegacyAdoptionError, LegacyAdoptionFactsSchema, LegacyAdoptionTargetSchema, LegacyAdoptionTargetsSchema,
  type LegacyAdoptionFence, type LegacyAdoptionProbe, type LegacyAdoptionTarget } from '@cauce/store';
import { assertAuthBridgeSocket, type AuthBridgeSocketPolicy } from './auth-bridge-socket.js';

const Identifier = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Packet = { version: z.literal(1), id: Identifier };
export const AdoptionBridgeRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...Packet, action: z.literal('acquire'), targets: LegacyAdoptionTargetsSchema }).strict(),
  z.object({ ...Packet, action: z.literal('measure'), target: LegacyAdoptionTargetSchema }).strict(),
  z.object({ ...Packet, action: z.literal('assertHeld') }).strict(),
  z.object({ ...Packet, action: z.literal('release') }).strict(),
]);
const Reply = z.object({ ...Packet, ok: z.literal(true), facts: LegacyAdoptionFactsSchema.optional() }).strict();
const unavailable = () => new LegacyAdoptionError('unavailable');
export const adoptionTargetKey = (target: LegacyAdoptionTarget): string => JSON.stringify([target.tenant_id, target.alias]);
export const adoptionPacketBytes = (raw: RawData): Buffer => Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
type Request = z.infer<typeof AdoptionBridgeRequestSchema>;
type Action = Request['action'];

class Session {
  private nextId = 0;
  private failed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private pending: { id: number; action: Action; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  private readonly socket: WebSocket;
  private readonly opened: Promise<void>;

  constructor(socketPath: string, private readonly timeoutMs: number) {
    this.socket = new WebSocket('ws://localhost/adoption', { createConnection: () => connect(socketPath),
      maxPayload: 1_048_576, perMessageDeflate: false, handshakeTimeout: 10_000 });
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', () => { reject(unavailable()); });
      this.socket.once('close', () => { reject(unavailable()); });
    });
    this.socket.on('error', () => { this.fail(); }); this.socket.on('close', () => { this.fail(); });
    this.socket.on('message', (raw, binary) => {
      try {
        if (binary) throw unavailable();
        const reply = Reply.parse(JSON.parse(adoptionPacketBytes(raw).toString('utf8')));
        const pending = this.pending;
        if (reply.id !== pending?.id || (pending.action === 'measure') !== (reply.facts !== undefined)) throw unavailable();
        this.pending = undefined; clearTimeout(pending.timer); pending.resolve(reply.facts);
      } catch { this.fail(); }
    });
  }
  private fail(): void {
    this.failed = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(unavailable()); this.pending = undefined; }
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
  healthy(): void { if (this.failed || this.socket.readyState !== WebSocket.OPEN) throw unavailable(); }
  request(action: Action, fields: Record<string, unknown> = {}): Promise<unknown> {
    const run = this.chain.then(async () => {
      await this.opened; this.healthy();
      const request = AdoptionBridgeRequestSchema.parse({ version: 1, id: this.nextId++, action, ...fields });
      return new Promise<unknown>((resolve, reject) => {
        this.pending = { id: request.id, action, resolve, reject, timer: setTimeout(() => { this.fail(); }, this.timeoutMs) };
        this.socket.send(JSON.stringify(request), error => { if (error) this.fail(); });
      });
    });
    this.chain = run.catch(() => undefined); return run;
  }
  close(): void { this.fail(); }
}

export class HostLegacyAdoptionProbe implements LegacyAdoptionProbe {
  private readonly timeoutMs: number;
  constructor(private readonly socketPath: string, private readonly policy: AuthBridgeSocketPolicy = {},
    options: { rpcTimeoutMs?: number } = {}) {
    this.timeoutMs = options.rpcTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) throw unavailable();
  }
  async withSupervisorFence<T>(targets: readonly LegacyAdoptionTarget[], work: (fence: LegacyAdoptionFence) => Promise<T>): Promise<T> {
    const scope = LegacyAdoptionTargetsSchema.safeParse(targets);
    if (!scope.success) throw new LegacyAdoptionError('invalid_input');
    try { await assertAuthBridgeSocket(this.socketPath, this.policy); } catch { throw unavailable(); }
    const session = new Session(this.socketPath, this.timeoutMs);
    try {
      await session.request('acquire', { targets: scope.data });
      const value = await work({
        measure: async target => {
          if (!scope.data.some(row => adoptionTargetKey(row) === adoptionTargetKey(target))) throw unavailable();
          const facts = LegacyAdoptionFactsSchema.parse(await session.request('measure', { target }));
          if (adoptionTargetKey(facts.target) !== adoptionTargetKey(target)) throw unavailable();
          return facts;
        },
        assertHeld: async () => { await session.request('assertHeld'); },
      });
      await session.request('assertHeld'); await session.request('release'); session.healthy(); return value;
    } catch (error) {
      try { session.healthy(); await session.request('release'); } catch { /* Preserve the callback error if cleanup fails. */ }
      throw error;
    } finally { session.close(); }
  }
}
