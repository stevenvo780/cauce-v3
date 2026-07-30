import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION, type Ack, type DeliveryEnvelope, type Hello,
  type Tenant, type WsOutbound
} from '@cauce/protocol';

export interface AdapterIdentity {
  tenant_id: Tenant;
  alias: string;
  instance_id: string;
  capabilities: string[];
}

export interface AdapterConsumer {
  connect(url: string, headers?: Record<string, string>): Promise<number>;
  ack(
    delivery: Pick<DeliveryEnvelope, 'event_id' | 'delivery_id' | 'attempt' | 'claim_token'>,
    status: Ack['status'],
    detail?: Partial<Pick<Ack, 'event_id' | 'retryable' | 'error' | 'error_code' | 'result' | 'execution_started'>>,
  ): void;
  close(): Promise<void>;
}

interface FrameWaiter {
  predicate: (message: WsOutbound) => boolean;
  resolve: (message: WsOutbound) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class FakeHarness extends EventEmitter implements AdapterConsumer {
  private socket: WebSocket | undefined;
  private currentEpoch: number | undefined;
  private readonly frames: WsOutbound[] = [];
  private readonly waiters = new Set<FrameWaiter>();

  constructor(readonly identity: AdapterIdentity) {
    super();
  }

  get epoch(): number {
    if (!this.currentEpoch) throw new Error('harness has no active lease');
    return this.currentEpoch;
  }

  async connect(url: string, headers: Record<string, string> = {
    'x-cauce-tenant': this.identity.tenant_id,
    'x-cauce-alias': this.identity.alias
  }): Promise<number> {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) throw new Error('harness is already connected');
    const socket = new WebSocket(url, { headers });
    this.socket = socket;
    socket.on('message', (data: WebSocket.RawData) => this.receive(data));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const hello: Hello = { type: 'hello', version: PROTOCOL_VERSION, ...this.identity };
    socket.send(JSON.stringify(hello));
    const reply = await this.waitFor((message) => message.type === 'hello_ack' || message.type === 'takeover_rejected');
    if (reply.type === 'takeover_rejected') throw new Error(`takeover_rejected:${reply.active_instance_id}`);
    if (reply.type !== 'hello_ack') throw new Error('unexpected hello response');
    this.currentEpoch = reply.epoch;
    return reply.epoch;
  }

  private receive(data: WebSocket.RawData): void {
    let message: WsOutbound;
    try {
      message = JSON.parse(rawDataText(data)) as WsOutbound;
    } catch {
      return;
    }
    this.emit('frame', message);
    for (const waiter of this.waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    this.frames.push(message);
  }

  ack(
    delivery: Pick<DeliveryEnvelope, 'event_id' | 'delivery_id' | 'attempt' | 'claim_token'>,
    status: Ack['status'],
    detail: Partial<Pick<Ack, 'event_id' | 'retryable' | 'error' | 'error_code' | 'result' | 'execution_started'>> = {},
  ): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('harness is disconnected');
    this.socket.send(JSON.stringify({
      type: 'ack', version: PROTOCOL_VERSION, event_id: detail.event_id ?? randomUUID(),
      delivery_id: delivery.delivery_id, attempt: delivery.attempt, claim_token: delivery.claim_token, status,
      instance_id: this.identity.instance_id, epoch: this.epoch,
      retryable: detail.retryable ?? false,
      ...(detail.error ? { error: detail.error } : {}),
      ...(detail.error_code ? { error_code: detail.error_code } : {}),
      ...(detail.result ? { result: detail.result } : {}),
      // La marca que distingue "el harness arrancó de verdad" de "la entrega hace cola".
      // El SDK real la manda en el 'started' posterior a la reserva de sesión; sin poder
      // emitirla acá, ninguna prueba de integración puede cubrir el camino de la ejecución
      // ya pagada, que es justo el que no se debe reintentar.
      ...(detail.execution_started === true ? { execution_started: true } : {})
    }));
  }

  heartbeat(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('harness is disconnected');
    this.socket.send(JSON.stringify({
      type: 'heartbeat', instance_id: this.identity.instance_id, epoch: this.epoch
    }));
  }

  async waitFor(predicate: (message: WsOutbound) => boolean, timeoutMs = 5_000): Promise<WsOutbound> {
    const index = this.frames.findIndex(predicate);
    if (index >= 0) return this.frames.splice(index, 1)[0]!;
    if (!this.socket) throw new Error('harness is disconnected');
    return new Promise<WsOutbound>((resolve, reject) => {
      const waiter = {} as FrameWaiter;
      waiter.predicate = predicate;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('timed out waiting for WebSocket frame'));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async nextDelivery(timeoutMs = 5_000): Promise<DeliveryEnvelope> {
    const message = await this.waitFor((candidate) => candidate.type === 'delivery', timeoutMs);
    if (message.type !== 'delivery') throw new Error('unreachable delivery narrowing');
    return message;
  }

  terminate(): void {
    this.socket?.terminate();
    this.socket = undefined;
    this.currentEpoch = undefined;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.currentEpoch = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close(1000, 'harness close');
      setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        resolve();
      }, 1_000).unref();
    });
  }
}

function rawDataText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
