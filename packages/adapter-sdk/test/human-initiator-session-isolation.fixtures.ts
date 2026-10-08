import { randomUUID } from "node:crypto";
import type { Delivery } from "../src/sdk/types.js";
import { delivery } from "./engine-fixtures.js";

export const HUMAN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const HUMAN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
export function humanDelivery(humanId = HUMAN_A, conversationId = "conversation-one"): Delivery {
  const messageId = randomUUID();
  return { ...delivery(randomUUID()), message_id: messageId,
    authenticated_context: { channel: "mcp", session_id: "same-technical-session" },
    human_initiator: { human_id: humanId, tenant_id: "Steven",
      root_message_id: messageId, conversation_id: conversationId } };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { claudeDefinition } from "../src/harnesses/claude.js";
import { deliveryHarnesses } from "../src/bin/shared.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { humanInitiatorFromDelivery } from "../src/sdk/engine/delivery-context.js";
import { EmissionRuntime } from "../src/sdk/mcp-emission/runtime.js";
import type { EmissionTurn } from "../src/sdk/mcp-emission/tools.js";
import type { CommandRunner, CommandRunRequest, CommandRunResult, DeliveryEvent } from "../src/sdk/types.js";

export class IsolatedCommandRunner implements CommandRunner {
  private readonly nativeIds = new Map<string, string>();
  constructor(private readonly format: "claude" | "codex" = "claude") {}
  readonly requests: CommandRunRequest[] = [];
  private readonly pending = new Map<CommandRunRequest, () => void>();
  hold = false;
  release(): void { for (const resolve of this.pending.values()) resolve(); }
  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    if (this.hold) await new Promise<void>((resolve) => {
      this.pending.set(request, resolve);
      request.signal.addEventListener("abort", () => { resolve(); }, { once: true });
      if (request.signal.aborted) resolve();
    });
    this.pending.delete(request);
    const cancelled = request.signal.aborted;
    const human = request.stdin.includes(HUMAN_A) ? HUMAN_A : request.stdin.includes(HUMAN_B) ? HUMAN_B : "manual";
    const result = JSON.stringify({ reply: human, messages: [], status: "done", retryable: false, artifacts: [] });
    let stdout = JSON.stringify({ result });
    if (this.format === "codex") {
      const nativeId = this.nativeIds.get(human) ?? randomUUID();
      this.nativeIds.set(human, nativeId);
      stdout = [JSON.stringify({ type: "thread.started", thread_id: nativeId }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } })].join("\n");
    }
    if (!cancelled) request.onHarnessStart?.();
    return { stdout: cancelled ? "" : stdout, stderr: "",
      exitCode: cancelled ? null : 0, signal: cancelled ? "SIGTERM" : null, timedOut: false, cancelled };
  }
}

export class RecordedEmission extends EmissionRuntime {
  readonly recorded = new Map<string, EmissionTurn>();
  override begin(options: Parameters<EmissionRuntime["begin"]>[0]): EmissionTurn {
    const turn = super.begin(options);
    this.recorded.set(options.delivery.delivery_id, turn);
    return turn;
  }
}

export async function isolatedEngine(t: TestContext, ownTenantId = "Steven") {
  const directory = await mkdtemp(join(tmpdir(), "cauce-human-sdk-"));
  t.diagnostic(`Owned fixture directory: ${directory}`);
  const store = await DurableStore.open(directory);
  const manual = new IsolatedCommandRunner();
  const headless = new IsolatedCommandRunner();
  const adapters = deliveryHarnesses({ definition: claudeDefinition, runner: manual, store,
    sessionNamespace: "argos", sharedSession: { alias: "argos", harness: "claude", stateDirectory: directory } }, headless);
  const emission = new RecordedEmission(directory, "human-sdk-fixture", async () => { throw new Error("No external emission request expected"); });
  const events: DeliveryEvent[] = [];
  let selections = 0;
  const engine = new AdapterEngine({ store, emission, harness: adapters.harness, ownTenantId,
    harnessForDelivery: (input) => {
      selections += 1;
      const human = humanInitiatorFromDelivery(input);
      if (human === undefined) return adapters.harness;
      if (adapters.humanHarness === undefined) throw new Error("Missing headless adapter");
      return adapters.humanHarness;
    }, executionIntentMode: "local-test-only", publish: async (event) => { events.push(event); } });
  await engine.activateEpoch(1);
  const work = new Set<Promise<void>>();
  const run = (input: Delivery): Promise<void> => {
    const task = engine.handleDelivery(input); work.add(task); return task;
  };
  t.after(async () => {
    engine.stop(); manual.release(); headless.release();
    await Promise.allSettled(work);
    await emission.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { engine, run, store, directory, adapters, manual, headless, emission, events, selections: () => selections };
}

export async function waitForRequests(runner: IsolatedCommandRunner, count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (runner.requests.length < count) {
    if (Date.now() > deadline) throw new Error("Harness barrier timed out");
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}
