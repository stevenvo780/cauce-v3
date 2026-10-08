import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { ProviderAuthError, ProviderAuthRequestSchema } from '../console/provider-auth.contracts.js';
import type { ProviderAuthActor, ProviderAuthChannel, ProviderAuthService } from '../console/provider-auth.types.js';
import { HostAuthRequestSchema, HostAuthSnapshotSchema, HostAuthTicketSchema } from './auth-bridge-contracts.js';
import { assertAuthBridgeSocket, type AuthBridgeSocketPolicy } from './auth-bridge-socket.js';

type Request = z.infer<typeof HostAuthRequestSchema>;
const ErrorSchema = HostAuthSnapshotSchema.shape.error.unwrap();
export class HostProviderAuthService implements ProviderAuthService {
  private readonly streams = new Set<WebSocket>();
  constructor(private readonly socketPath: string, private readonly socketPolicy: AuthBridgeSocketPolicy = {}) {
    if (!socketPath.startsWith('/') || socketPath.split('/').includes('..')) throw new Error('invalid host socket path');
  }
  private async invoke(value: Request): Promise<unknown> {
    try { await assertAuthBridgeSocket(this.socketPath, this.socketPolicy); }
    catch { throw new ProviderAuthError('HOST_UNAVAILABLE'); }
    const body = JSON.stringify(HostAuthRequestSchema.parse(value));
    return new Promise((resolve, reject) => {
      const unavailable = () => { reject(new ProviderAuthError('HOST_UNAVAILABLE')); };
      const request = httpRequest({ socketPath: this.socketPath, path: '/auth', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        let length = 0; const chunks: Buffer[] = [];
        response.on('data', (data: Buffer) => {
          length += data.length;
          if (length > 8192) { response.destroy(); unavailable(); } else chunks.push(data);
        });
        response.once('error', unavailable);
        response.once('end', () => {
          try {
            const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode !== 200) {
              const failed = z.object({ error: ErrorSchema }).strict().parse(payload);
              reject(new ProviderAuthError(failed.error)); return;
            }
            resolve(payload);
          } catch { unavailable(); }
        });
      });
      request.setTimeout(90_000, () => { request.destroy(); unavailable(); });
      request.once('error', unavailable); request.end(body);
    });
  }
  async start(actor: ProviderAuthActor, input: unknown) {
    const value = HostAuthRequestSchema.parse({ action: 'start', actor, request: input });
    return HostAuthSnapshotSchema.parse(await this.invoke(value));
  }
  async resolve(actor: ProviderAuthActor, operation_id: string) {
    return ProviderAuthRequestSchema.parse(await this.invoke({ action: 'scope', actor, operation_id }));
  }
  async get(actor: ProviderAuthActor, id: string) { return HostAuthSnapshotSchema.parse(await this.invoke({ action: 'get', actor, id })); }
  async verify(actor: ProviderAuthActor, id: string) { return HostAuthSnapshotSchema.parse(await this.invoke({ action: 'verify', actor, id })); }
  async cancel(actor: ProviderAuthActor, id: string) { return HostAuthSnapshotSchema.parse(await this.invoke({ action: 'cancel', actor, id })); }
  async issueSocketTicket(actor: ProviderAuthActor, id: string) { return HostAuthTicketSchema.parse(await this.invoke({ action: 'ticket', actor, id })); }
  async consumeSocketTicket(actor: ProviderAuthActor, id: string, ticket: string): Promise<void> {
    z.object({}).strict().parse(await this.invoke({ action: 'consume', actor, id, ticket }));
  }
  async revokeOperation(operation_id: string): Promise<void> {
    z.object({}).strict().parse(await this.invoke({ action: 'revoke', operation_id }));
  }
  async attach(actor: ProviderAuthActor, id: string, output: (bytes: Uint8Array) => void): Promise<ProviderAuthChannel> {
    try { await assertAuthBridgeSocket(this.socketPath, this.socketPolicy); }
    catch { throw new ProviderAuthError('HOST_UNAVAILABLE'); }
    const socket = new WebSocket('ws://localhost/stream', { createConnection: () => connect(this.socketPath), maxPayload: 65_536 });
    this.streams.add(socket); socket.once('close', () => { this.streams.delete(socket); });
    await new Promise<void>((resolve, reject) => {
      let admitted = false;
      const failure = () => { clearTimeout(timer); if (!admitted) reject(new ProviderAuthError('HOST_UNAVAILABLE')); };
      const timer = setTimeout(() => { socket.terminate(); failure(); }, 10_000); timer.unref();
      socket.once('open', () => { socket.send(JSON.stringify({ type: 'attach', actor, id })); });
      socket.once('error', failure); socket.once('close', failure);
      socket.on('message', (raw, binary) => {
        try {
          const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          if (binary) {
            output(data); return;
          }
          if (admitted || data.toString('utf8') !== '{"type":"ready"}') throw new Error('invalid admission');
          admitted = true; clearTimeout(timer); resolve();
        } catch { socket.terminate(); failure(); }
      });
    });
    const send = (value: Uint8Array | string) => new Promise<void>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 65_536) { reject(new ProviderAuthError('HOST_UNAVAILABLE')); return; }
      socket.send(value, { binary: typeof value !== 'string' }, error => { if (error) reject(new ProviderAuthError('HOST_UNAVAILABLE')); else resolve(); });
    });
    return {
      input: async bytes => { if (bytes.byteLength > 4096) throw new ProviderAuthError('INVALID_REQUEST'); await send(bytes); },
      resize: async (cols, rows) => { await send(JSON.stringify({ type: 'resize', cols, rows })); },
      close: async () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        await new Promise<void>(resolve => { const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1000);
          socket.once('close', () => { clearTimeout(timer); resolve(); }); socket.close(); });
      },
    };
  }
  async shutdown(): Promise<void> { for (const socket of this.streams) socket.terminate(); this.streams.clear(); }
}
