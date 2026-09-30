import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../src/sdk/durable-store.js";
import { HarnessAdapter } from "../src/harnesses/shared/adapter.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import { fakeDefinition } from "../src/harnesses/fake.js";
import type { EgressReceiptSource } from "../src/sdk/notify-history.js";
import { ControlledRunner, delivery, originless } from "./engine-fixtures.js";
import { scope } from "./notify-history-fixtures.js";

/**
 * socrates: 177 inbox records from July predate `output.notify`. Reading the notice
 * history hit `record.output.notify.length` on them and every human-channel delivery died in
 * 0.35 s as INTERNAL, while agent deliveries (no origin, no history) went through.
 */
for (const [where, inline] of [["inline", undefined], ["archived", 0]] as const) test(`a legacy ${where} record without output.notify does not kill a human-channel delivery`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "notify-legacy-"));
  let store = await DurableStore.open(directory);
  try {
    await store.activateEpoch(1);
    const accepted = await store.acceptAndEnqueue(originless(delivery("legacy-july"), "s"), new Date().toISOString());
    assert.ok(accepted.event); await store.acknowledge(accepted.event);
    const terminal = await store.transitionAndEnqueue("legacy-july", "done", new Date().toISOString(), {
      output: { reply: "old", messages: [], artifacts: [], status: "done", retryable: false, notify: [] },
    });
    await store.acknowledge(terminal.event);
    store.close();
    const path = join(directory, "inbox.json");
    const inbox = JSON.parse(await readFile(path, "utf8")) as { deliveries: Record<string, { output?: Record<string, unknown> }> };
    const legacy = inbox.deliveries["legacy-july"]?.output; assert.ok(legacy);
    delete legacy.notify;
    await writeFile(path, JSON.stringify(inbox), { mode: 0o600 });
    store = await DurableStore.open(directory, inline === undefined ? {} : { maxInlineTerminalRecords: inline });
    assert.doesNotThrow(() => store.notificationHistory(), "the history must skip records that predate notify");

    const runner = new ControlledRunner();
    const receipts: EgressReceiptSource = { read: () => Promise.resolve([]) };
    const engine = new AdapterEngine({ store, harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
      ownTenantId: "Steven", executionIntentMode: "local-test-only", publish: async () => undefined,
      egressReceipts: receipts });
    const input = delivery("human-after-legacy");
    await engine.handleDelivery({ ...input, authenticated_context: { session_id: "human-thread", channel: "telegram",
      origin: { adapter: scope.adapter, channel: scope.channel, conversation_id: scope.conversation_id,
        relay: [], metadata: {} } } });
    assert.equal(runner.calls, 1, "the harness never received the human turn");
    assert.equal(store.getDelivery(input.delivery_id)?.state, "done");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
