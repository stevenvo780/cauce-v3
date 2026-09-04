// Shared helpers for the split client.test.ts tests (Task 2 of opencode-minimax.md).
// NOT a test: the `dist/test/*.test.js` runner does not pick it up (does not end in .test.js).
import assert from "node:assert/strict";
import {rm} from 'node:fs/promises';
import { resolve } from "node:path";
import {HarnessAdapter, fakeDefinition} from '../src/harnesses/index.js';
import {systemClock} from '../src/sdk/backoff.js';
import {AdapterClient} from '../src/sdk/client.js';
import {DurableStore} from '../src/sdk/durable-store.js';
import type {AdapterLogger, BackoffConfig, ClientFrame, Clock, CommandRunRequest, CommandRunResult, CommandRunner, ConsumerConnection, ConsumerConnector, HarnessDefinition, ServerFrame, TimerHandle, TimerOptions} from '../src/sdk/types.js';
import { testStateRoot } from "./test-state.js";
export type HelloAgentProfile = NonNullable<Extract<ServerFrame, { type: "hello_ack" }>["agent_profile"]>;

export const root = testStateRoot();

const rawTimeScale = Number(process.env.CAUCE_TEST_TIME_SCALE ?? 1);
export const TEST_TIME_SCALE = Number.isFinite(rawTimeScale) && rawTimeScale > 0 ? rawTimeScale : 1;

export function escala(ms: number): number {
  return Math.round(ms * TEST_TIME_SCALE);
}

export const CLAIM_DEADLINE_MS = escala(30_000);
export const HARNESS_TIMEOUT_MS = escala(60_000);
export const LEASE_MS = escala(30_000);

export function claimDeadline(): number {
  return Date.now() + CLAIM_DEADLINE_MS;
}

export class NoopRunner implements CommandRunner {
  async run(_request: CommandRunRequest): Promise<CommandRunResult> {
    return {
      stdout: JSON.stringify({
        reply: "ok",
        messages: [],
        status: "done",
        retryable: false,
        artifacts: [],
      }),
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
  }
}

export class CountingRunner extends NoopRunner {
  calls = 0;

  override async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.calls += 1;
    return super.run(request);
  }
}

export class BlockingRunner implements CommandRunner {
  started = false;
  aborted = false;
  private settle: (() => void) | undefined;

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.started = true;
    let abort: () => void = () => undefined;
    await new Promise<void>((resolveWait) => {
      let settled = false;
      this.settle = () => {
        if (settled) return;
        settled = true;
        resolveWait();
      };
      abort = () => {
        this.aborted = true;
        this.settle?.();
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    });
    request.signal.removeEventListener("abort", abort);
    this.settle = undefined;
    if (!this.aborted) {
      return {
        stdout: JSON.stringify({
          reply: "completed after confirmed renewals",
          messages: [],
          status: "done",
          retryable: false,
          artifacts: [],
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
      };
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
    };
  }

  complete(): void {
    assert.ok(this.settle, "Harness execution is not blocked");
    this.settle();
  }
}

export class FakeConnection implements ConsumerConnection {
  readonly mode = "consumer" as const;
  readonly ephemeral = false as const;
  readonly sent: ClientFrame[] = [];
  private readonly queued: ServerFrame[] = [];
  private readonly waiters: ((value: IteratorResult<ServerFrame>) => void)[] = [];
  private ended = false;

  constructor(
    private readonly welcomeEpoch = 1,
    private readonly agentProfile?: HelloAgentProfile,
    private readonly autoConfirmExecutionIntent = true,
  ) {}

  async send(frame: ClientFrame): Promise<void> {
    this.sent.push(frame);
    if (frame.type === "hello") this.push({
      type: "hello_ack", version: "3.0", epoch: this.welcomeEpoch,
      lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
      ...(this.agentProfile === undefined ? {} : { agent_profile: this.agentProfile }),
    });
    if (frame.type === "ack" && frame.execution_started === true && this.autoConfirmExecutionIntent) {
      this.push({
        type: "ack_result",
        event_id: frame.event_id,
        delivery_id: frame.delivery_id,
        attempt: frame.attempt,
        claim_token: frame.claim_token,
        status: "started",
        applied: true,
        receipt: "applied",
      });
    }
  }

  push(frame: ServerFrame): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.queued.push(frame);
    else waiter({ value: frame, done: false });
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  frames(): AsyncIterable<ServerFrame> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<ServerFrame>> => {
          const value = this.queued.shift();
          if (value !== undefined) return { value, done: false };
          if (this.ended) return { value: undefined, done: true };
          return new Promise((resolveWait) => this.waiters.push(resolveWait));
        },
      }),
    };
  }

  async close(): Promise<void> {
    this.end();
  }
}

export class FrameSchemaError extends Error {
  readonly issues = [
    { path: ["result", "output", "status"], code: "invalid_value", message: "Invalid option" },
  ];

  constructor() {
    super("Outbound frame rejected by the Cauce V3 schema");
    this.name = "FrameSchemaError";
  }
}

export class RejectingConnection extends FakeConnection {
  readonly refused: string[] = [];

  constructor(
    private readonly refusedEventIds: readonly string[],
    private readonly failure: () => Error = () => new FrameSchemaError(),
  ) {
    super(1);
  }

  override async send(frame: ClientFrame): Promise<void> {
    if (frame.type === "ack" && this.refusedEventIds.includes(frame.event_id)) {
      this.refused.push(frame.event_id);
      throw this.failure();
    }
    await super.send(frame);
  }
}

export class ClosingConnection extends FakeConnection {
  constructor(private readonly withHeartbeatAck: boolean) {
    super(1);
  }

  override async send(frame: ClientFrame): Promise<void> {
    await super.send(frame);
    if (frame.type !== "hello") return;
    if (this.withHeartbeatAck) {
      this.push({
        type: "heartbeat_ack",
        lease_expires_at: new Date(Date.now() + LEASE_MS + 60_000).toISOString(),
      });
    }
    this.end();
  }
}

export class FactoryConnector implements ConsumerConnector {
  calls = 0;

  constructor(private readonly build: (call: number) => ConsumerConnection) {}

  async connect(_signal: AbortSignal): Promise<ConsumerConnection> {
    this.calls += 1;
    return this.build(this.calls);
  }
}

export class ReconnectDelayClock implements Clock {
  readonly delays: number[] = [];

  constructor(private readonly heartbeatMs: number) {}

  now(): Date {
    return new Date();
  }

  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms === this.heartbeatMs) return systemClock.sleep(ms, signal);
    this.delays.push(ms);
    return systemClock.sleep(1, signal);
  }

  setTimer(fn: () => void, ms: number, options?: TimerOptions): TimerHandle {
    return systemClock.setTimer(fn, ms, options);
  }

  setRepeating(fn: () => void, ms: number, options?: TimerOptions): TimerHandle {
    return systemClock.setRepeating(fn, ms, options);
  }

  clearTimer(handle: TimerHandle): void {
    systemClock.clearTimer(handle);
  }
}

export interface ScheduledTimer {
  readonly ms: number;
  readonly repeating: boolean;
  readonly options: TimerOptions | undefined;
}

interface PendingTimer {
  readonly fn: () => void;
  readonly ms: number;
  readonly repeating: boolean;
}

export class ManualTimerClock implements Clock {
  readonly history: ScheduledTimer[] = [];
  private readonly pending = new Map<number, PendingTimer>();
  private nextId = 0;

  now(): Date {
    return new Date();
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return systemClock.sleep(ms, signal);
  }

  setTimer(fn: () => void, ms: number, options?: TimerOptions): TimerHandle {
    return this.schedule(fn, ms, false, options);
  }

  setRepeating(fn: () => void, ms: number, options?: TimerOptions): TimerHandle {
    return this.schedule(fn, ms, true, options);
  }

  clearTimer(handle: TimerHandle): void {
    handle.cancel();
  }

  scheduledAt(ms: number): number {
    return this.scheduledIds(ms).length;
  }

  scheduledIds(ms: number): readonly number[] {
    return [...this.pending].filter(([, entry]) => entry.ms === ms).map(([id]) => id);
  }

  keepAlive(): readonly ScheduledTimer[] {
    return this.history.filter((entry) => entry.options?.keepProcessAlive === true);
  }

  fire(ms: number): number { // a one-shot entry is gone once it fires; a repeating one stays armed
    const due = [...this.pending].filter(([, entry]) => entry.ms === ms);
    for (const [id, entry] of due) if (!entry.repeating) this.pending.delete(id);
    for (const [, entry] of due) entry.fn();
    return due.length;
  }

  private schedule(fn: () => void, ms: number, repeating: boolean, options: TimerOptions | undefined): TimerHandle {
    const id = this.nextId++;
    this.pending.set(id, { fn, ms, repeating });
    this.history.push({ ms, repeating, options });
    return { cancel: () => { this.pending.delete(id); } };
  }
}

export class ImmediateTimerClock implements Clock { // fires a non-positive delay in the arming tick
  now(): Date {
    return new Date();
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return systemClock.sleep(ms, signal);
  }

  setTimer(fn: () => void, ms: number): TimerHandle {
    if (ms <= 0) fn();
    return { cancel: () => undefined };
  }

  setRepeating(_fn: () => void, _ms: number): TimerHandle {
    return { cancel: () => undefined };
  }

  clearTimer(handle: TimerHandle): void {
    handle.cancel();
  }
}

interface VirtualTimer {
  at: number;
  readonly fn: () => void;
  readonly intervalMs?: number;
}

export class VirtualClock implements Clock {
  private currentMs: number;
  private nextId = 0;
  private readonly timers = new Map<number, VirtualTimer>();

  constructor(startedAt: number = Date.now()) {
    this.currentMs = startedAt;
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolveWait, rejectWait) => {
      if (signal.aborted) {
        rejectWait(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
        return;
      }
      const abort = (): void => {
        this.clearTimer(timer);
        rejectWait(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      };
      const timer = this.setTimer(() => {
        signal.removeEventListener('abort', abort);
        resolveWait();
      }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  setTimer(fn: () => void, ms: number): TimerHandle {
    return this.schedule(fn, ms);
  }

  setRepeating(fn: () => void, ms: number): TimerHandle {
    return this.schedule(fn, ms, ms);
  }

  clearTimer(handle: TimerHandle): void {
    handle.cancel();
  }

  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('advance requires a non-negative integer');
    const target = this.currentMs + ms;
    for (;;) {
      const nextAt = Math.min(
        ...[...this.timers.values()].map((timer) => timer.at),
        Number.POSITIVE_INFINITY,
      );
      if (nextAt > target) break;
      this.currentMs = nextAt;
      const due = [...this.timers].filter(([, timer]) => timer.at === nextAt);
      for (const [id, timer] of due) {
        if (!this.timers.has(id)) continue;
        if (timer.intervalMs === undefined) this.timers.delete(id);
        else timer.at += timer.intervalMs;
        timer.fn();
      }
    }
    this.currentMs = target;
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  scheduledIn(ms: number): number {
    return [...this.timers.values()].filter((timer) => timer.at - this.currentMs === ms).length;
  }

  private schedule(fn: () => void, ms: number, intervalMs?: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, {
      at: this.currentMs + Math.max(0, ms),
      fn,
      ...(intervalMs === undefined ? {} : { intervalMs }),
    });
    return { cancel: () => { this.timers.delete(id); } };
  }
}

export class ScriptedConnector implements ConsumerConnector {
  calls = 0;
  constructor(
    private readonly connection: ConsumerConnection,
    private readonly failures = 0,
  ) {}

  async connect(_signal: AbortSignal): Promise<ConsumerConnection> {
    this.calls += 1;
    if (this.calls <= this.failures) throw new Error("planned connect failure");
    return this.connection;
  }
}

export class SequenceConnector implements ConsumerConnector {
  calls = 0;
  constructor(private readonly connections: readonly ConsumerConnection[]) {}

  async connect(_signal: AbortSignal): Promise<ConsumerConnection> {
    const connection = this.connections[Math.min(this.calls, this.connections.length - 1)];
    this.calls += 1;
    if (connection === undefined) throw new Error("No scripted connection available");
    return connection;
  }
}

export async function makeClient(
  name: string,
  connector: ConsumerConnector,
  options: {
    heartbeatMs?: number;
    connectTimeoutMs?: number;
    helloAckTimeoutMs?: number;
    heartbeatAckTimeoutMs?: number;
    sendTimeoutMs?: number;
    epoch?: number;
    onLeaseAcquired?: () => Promise<void>;
    runner?: CommandRunner;
    definition?: HarnessDefinition;
    onError?: (code: string) => void;
    claimRenewalMs?: number;
    claimWatchdogMs?: number;
    reconnect?: BackoffConfig;
    clock?: Clock;
    logger?: AdapterLogger;
  } = {},
): Promise<{ client: AdapterClient; store: DurableStore; directory: string }> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  const store = await DurableStore.open(directory);
  if (options.epoch !== undefined) await store.activateEpoch(options.epoch);
  const harness = new HarnessAdapter({
    definition: options.definition ?? fakeDefinition,
    runner: options.runner ?? new NoopRunner(),
    store,
  });
  return {
    directory,
    store,
    client: new AdapterClient({
      config: {
        tenantId: "Steven",
        alias: `agent_${name.replaceAll("-", "_")}`.slice(0, 60),
        instanceId: `instance-${name}`,
        stateDirectory: directory,
        heartbeatMs: options.heartbeatMs ?? 10_000,
        ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
        ...(options.helloAckTimeoutMs === undefined ? {} : { helloAckTimeoutMs: options.helloAckTimeoutMs }),
        ...(options.heartbeatAckTimeoutMs === undefined
          ? {}
          : { heartbeatAckTimeoutMs: options.heartbeatAckTimeoutMs }),
        ...(options.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: options.sendTimeoutMs }),
        reconnect: options.reconnect ?? { initialMs: 1, maxMs: 2, factor: 2, jitter: 0 },
      },
      connector,
      store,
      harness,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.onLeaseAcquired === undefined ? {} : { onLeaseAcquired: options.onLeaseAcquired }),
      ...(options.claimRenewalMs === undefined ? {} : { claimRenewalMs: options.claimRenewalMs }),
      ...(options.claimWatchdogMs === undefined ? {} : { claimWatchdogMs: options.claimWatchdogMs }),
    }),
  };
}

export async function waitUntil( // the label is what a starved run reports, not the predicate source
  predicate: () => boolean,
  timeoutOrLabel?: number | string,
  label?: string,
): Promise<void> {
  const timeoutMs = typeof timeoutOrLabel === "number" ? timeoutOrLabel : escala(5_000);
  const named = typeof timeoutOrLabel === "string" ? timeoutOrLabel : label;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      const elapsed = Date.now() - startedAt;
      throw new Error(
        `condition timeout after ${String(elapsed)}ms: ${named ?? predicate.toString()}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
}

export function renewableDelivery(
  name: string,
  suffix: string,
  ackDeadlineAt: number,
  origin?: Extract<ServerFrame, { type: "delivery" }>["origin"],
): Extract<ServerFrame, { type: "delivery" }> {
  return {
    ...(origin === undefined ? {} : { origin }),
    type: "delivery",
    version: "3.0",
    event_id: `30000000-0000-4000-8000-${suffix}`,
    delivery_id: `20000000-0000-4000-8000-${suffix}`,
    message_id: `00000000-0000-4000-8000-${suffix}`,
    request_id: `10000000-0000-4000-8000-${suffix}`,
    trace_id: `trace-${name}`,
    epoch: 1,
    attempt: 1,
    claim_token: `40000000-0000-4000-8000-${suffix}`,
    ack_deadline_at: new Date(ackDeadlineAt).toISOString(),
    tenant_id: "Steven",
    room_id: "grp.steven",
    actor_alias: "kant",
    recipient_alias: `agent_${name.replaceAll("-", "_")}`,
    body: { prompt: "block while the renewable claim is valid", timeout_ms: HARNESS_TIMEOUT_MS },
  };
}

export function startedAcks(connection: FakeConnection): Extract<ClientFrame, { type: "ack" }>[] {
  return connection.sent.filter(
    (frame): frame is Extract<ClientFrame, { type: "ack" }> => (
      frame.type === "ack" && frame.status === "started"
    ),
  );
}

export async function waitUntilTimestamp(timestamp: number): Promise<void> {
  const remaining = timestamp - Date.now();
  if (remaining > 0) {
    await new Promise((resolveWait) => setTimeout(resolveWait, remaining));
  }
}
