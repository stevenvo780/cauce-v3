// Shared helpers for the split client.test.ts tests (Task 2 of opencode-minimax.md).
// NOT a test: the `dist/test/*.test.js` runner does not pick it up (does not end in .test.js).
import assert from "node:assert/strict";
import {rm} from 'node:fs/promises';
import { resolve } from "node:path";
import {HarnessAdapter, fakeDefinition} from '../src/harnesses/index.js';
import {AdapterClient} from '../src/sdk/client.js';
import {DurableStore} from '../src/sdk/durable-store.js';
import type {ClientFrame, CommandRunRequest, CommandRunResult, CommandRunner, ConsumerConnection, ConsumerConnector, HarnessDefinition, ServerFrame} from '../src/sdk/types.js';
export type HelloAgentProfile = NonNullable<Extract<ServerFrame, { type: "hello_ack" }>["agent_profile"]>;

export const root = resolve(".test-state");

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
  private readonly waiters: Array<(value: IteratorResult<ServerFrame>) => void> = [];
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
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
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
    epoch?: number;
    onLeaseAcquired?: () => Promise<void>;
    runner?: CommandRunner;
    definition?: HarnessDefinition;
    onError?: (code: string) => void;
    claimRenewalMs?: number;
    claimWatchdogMs?: number;
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
        reconnect: { initialMs: 1, maxMs: 2, factor: 2, jitter: 0 },
      },
      connector,
      store,
      harness,
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.onLeaseAcquired === undefined ? {} : { onLeaseAcquired: options.onLeaseAcquired }),
      ...(options.claimRenewalMs === undefined ? {} : { claimRenewalMs: options.claimRenewalMs }),
      ...(options.claimWatchdogMs === undefined ? {} : { claimWatchdogMs: options.claimWatchdogMs }),
    }),
  };
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timeout");
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
}

export function renewableDelivery(
  name: string,
  suffix: string,
  ackDeadlineAt: number,
): Extract<ServerFrame, { type: "delivery" }> {
  return {
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
    body: { prompt: "block while the renewable claim is valid", timeout_ms: 60_000 },
  };
}

export function startedAcks(connection: FakeConnection): Array<Extract<ClientFrame, { type: "ack" }>> {
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
