// Helpers shared by the split tests of engine.test.ts (Task 2 of opencode-minimax.md).
// This file is NOT a test: the compiler picks it up (tsconfig: rootDir "." -> dist/test/engine-fixtures.js)
// but the `dist/test/*.test.js` runner does NOT. All symbols are exported for reuse.
import assert from "node:assert/strict";
import {readFile, rm} from 'node:fs/promises';
import { resolve } from "node:path";
import {HarnessAdapter, fakeDefinition} from '../src/harnesses/index.js';
import { DurableStore } from "../src/sdk/durable-store.js";
import {AdapterEngine} from '../src/sdk/engine.js';
import { humanHarnessSelector } from '../src/sdk/engine/delivery-context.js';
import type {CommandRunRequest, CommandRunResult, CommandRunner, Delivery, DeliveryEvent} from '../src/sdk/types.js';
import { testStateRoot } from "./test-state.js";
export const root = testStateRoot();

export async function storeFor(name: string): Promise<DurableStore> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

export async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function claimToken(attempt: number, variant = 0): string {
  return `20000000-0000-4000-${String(8000 + variant)}-${String(attempt).padStart(12, "0")}`;
}

export function delivery(id: string, epoch = 1, attempt = 1, claim = claimToken(attempt)): Delivery {
  return {
    type: "delivery",
    version: "3.0",
    delivery_id: id,
    event_id: `30000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    message_id: `00000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    request_id: `10000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    trace_id: `trace-${id}`,
    epoch,
    attempt,
    claim_token: claim,
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
    tenant_id: "Steven",
    room_id: "grp.steven",
    actor_alias: "kant",
    recipient_alias: "argos",
    origin: {
      adapter: "telegram",
      channel: "telegram",
      conversation_id: "room-42",
      external_message_id: "message-9",
      relay: [],
      metadata: {},
    },
    authenticated_context: {
      session_id: "session-42",
      channel: "telegram",
      origin: {
        adapter: "telegram",
        channel: "telegram",
        conversation_id: "room-42",
        external_message_id: "message-9",
        relay: [],
        metadata: {},
      },
    },
    body: { prompt: "perform the task", timeout_ms: 2_000, session_key: "thread-1" },
  };
}
export const SUCCESS = JSON.stringify({
  reply: "completed",
  messages: [],
  status: "done",
  retryable: false,
  artifacts: [],
});

export class ControlledRunner implements CommandRunner {
  calls = 0;
  readonly requests: CommandRunRequest[] = [];
  blockUntilAbort = false;
  stdout = SUCCESS;
  onRun: (() => void) | undefined;

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.calls += 1;
    this.requests.push(request);
    this.onRun?.();
    if (this.blockUntilAbort) {
      await new Promise<void>((resolveWait) => {
        if (request.signal.aborted) resolveWait();
        else request.signal.addEventListener("abort", () => { resolveWait(); }, { once: true });
      });
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        cancelled: true,
      };
    }
    return {
      stdout: this.stdout,
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
  }
}

export class CountingHarnessAdapter extends HarnessAdapter {
  executeCalls = 0;
  reserveSessionCalls = 0;

  override execute(
    request: Parameters<HarnessAdapter["execute"]>[0],
  ): ReturnType<HarnessAdapter["execute"]> {
    this.executeCalls += 1;
    return super.execute(request);
  }

  override reserveSession(
    sessionKey: Parameters<HarnessAdapter["reserveSession"]>[0],
  ): ReturnType<HarnessAdapter["reserveSession"]> {
    this.reserveSessionCalls += 1;
    return super.reserveSession(sessionKey);
  }
}

export class SessionConcurrencyRunner implements CommandRunner {
  readonly requests: CommandRunRequest[] = [];
  maxActive = 0;
  private active = 0;
  private readonly releases: (() => void)[] = [];

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise<void>((resolveRun) => {
      this.releases.push(resolveRun);
    });
    this.active -= 1;
    return {
      stdout: SUCCESS,
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
  }

  releaseNext(): void {
    const release = this.releases.shift();
    assert.ok(release, "No blocked harness execution to release");
    release();
  }

  async waitForCalls(count: number): Promise<void> {
    await waitFor(() => this.requests.length >= count, `${String(count)} harness calls`);
  }
}

export async function setup(
  name: string,
  runner = new ControlledRunner(),
  options: { ownTenantId?: string; isolateConsole?: boolean } = {},
): Promise<{
  store: DurableStore;
  runner: ControlledRunner;
  events: DeliveryEvent[];
  engine: AdapterEngine;
}> {
  const store = await storeFor(name);
  const events: DeliveryEvent[] = [];
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness,
    ...(options.isolateConsole === true ? {
      harnessForDelivery: humanHarnessSelector(harness,
        new HarnessAdapter({ definition: fakeDefinition, runner, store })),
    } : {}),
    publish: async (event) => {
      events.push(event);
    },
    ...(options.ownTenantId === undefined ? {} : { ownTenantId: options.ownTenantId }),
  });
  await engine.activateEpoch(1);
  return { store, runner, events, engine };
}

/** Native session the harness received in execution `index`. */
export function sessionOf(runner: ControlledRunner, index: number): string {
  const value = runner.requests[index]?.args.at(-1);
  assert.ok(value, `la ejecución ${String(index)} no llegó al harness`);
  return value;
}

/** Authenticated conversation: what a bridge publishes alongside the message. */
export function conversation(options: {
  adapter?: string;
  channel?: string;
  conversationId: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}): Pick<Delivery, "origin" | "authenticated_context"> {
  const origin = {
    adapter: options.adapter ?? "telegram",
    channel: options.channel ?? "telegram",
    conversation_id: options.conversationId,
    relay: [],
    metadata: options.metadata ?? {},
  };
  return {
    origin,
    authenticated_context: {
      session_id: options.sessionId ?? `tg-${options.conversationId}`,
      channel: options.channel ?? "telegram",
      origin,
    },
  };
}

/**
 * Publication without return route: console, adapter, ops tooling. `origin` is actually removed
 * (not overwritten with `undefined`) because the project compiles with `exactOptionalPropertyTypes`.
 */
export function originless(
  base: Delivery,
  sessionId: string,
  channel = "console",
): Delivery {
  const { origin: _origin, ...rest } = base;
  return { ...rest, authenticated_context: { session_id: sessionId, channel } };
}

export async function setupSessionConcurrency(name: string, claimRenewalMs = 25): Promise<{
  store: DurableStore;
  runner: SessionConcurrencyRunner;
  events: DeliveryEvent[];
  engine: AdapterEngine;
}> {
  const store = await storeFor(name);
  const runner = new SessionConcurrencyRunner();
  const events: DeliveryEvent[] = [];
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness,
    publish: async (event) => {
      events.push(event);
      if (event.claim_renewal === true) {
        engine.confirmClaim(event.delivery_id, event.attempt, event.claim_token);
      }
    },
    claimRenewalMs,
    queueWaitTimeoutMs: 10_000,
  });
  await engine.activateEpoch(1);
  return { store, runner, events, engine };
}

export async function waitFor(check: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
}

// Only a durable queue heartbeat proves the abort controller was registered after acceptance.
export async function waitForQueued(store: DurableStore, deliveryId: string): Promise<void> {
  await waitFor(() => {
    const record = store.getDelivery(deliveryId);
    if (record !== undefined && record.state !== "accepted") {
      throw new Error(`Delivery ${deliveryId} left the queue: ${record.state} (${record.error?.code ?? "no error"})`);
    }
    return record !== undefined && store.pendingEvents().some((event) => (
      event.delivery_id === deliveryId
      && event.attempt === record.attempt
      && event.claim_token === record.claim_token
      && event.phase === "accepted"
      && event.claim_renewal === true
    ));
  }, `delivery ${deliveryId} to emit a durable accepted queue heartbeat`);
}
