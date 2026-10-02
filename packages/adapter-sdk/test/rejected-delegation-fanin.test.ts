import assert from "node:assert/strict";
import test from "node:test";
import type { EventDeliveryFeedback } from "../src/sdk/durable-store/contracts.js";
import type { Delivery } from "../src/sdk/types.js";
import { ControlledRunner, delivery, setup } from "./engine-fixtures.js";

const rejection = {
  code: "hop_budget_exhausted" as const,
  reason: "Budget exhausted",
  guidance: "Return the recorded progress",
  output_index: 0,
};

async function blockedResponse(name: string, feedback?: EventDeliveryFeedback, count = 1) {
  const runner = new ControlledRunner();
  const context = await setup(`rejected-fanin-${name}`, runner, { ownTenantId: "Hospital" });
  const root: Delivery = {
    ...delivery(`rejected-root-${name}`),
    tenant_id: "Hospital", room_id: "grp.hospital", actor_alias: "operador", recipient_alias: "operador",
    body: { type: "telegram.message", text: "Complete the approved project" },
    routing_targets: [{ tenant_id: "Hospital", alias: "teseo", online: true }],
  };
  runner.stdout = JSON.stringify({
    reply: "I assigned the bounded work", messages: [{ to: "teseo", body: "Implement the first task" }],
    status: "done", retryable: false, artifacts: [],
  });
  await context.engine.handleDelivery(root);
  const childId = "40000000-0000-4000-8000-000000000001";
  const response: Delivery = {
    ...delivery(`rejected-response-${name}`),
    tenant_id: "Hospital", room_id: "grp.hospital", actor_alias: "teseo", recipient_alias: "operador",
    trace_id: root.trace_id,
    body: {
      type: "agent.response", text: "The first task is implemented", outcome: "done",
      correlation: {
        root_message_id: root.message_id, root_delivery_id: root.delivery_id,
        response_to_delivery_id: root.delivery_id, child_delivery_id: childId,
      },
    },
    routing_targets: [{ tenant_id: "Hospital", alias: "perseo", online: true }],
  };
  runner.stdout = JSON.stringify({
    reply: "Verifiqué la primera tarea. Se la encargué a Perseo para continuar.",
    messages: Array.from({ length: count }, (_, index) => ({ to: "perseo", body: `Next task ${String(index)}` })),
    status: "done", retryable: false, artifacts: [],
  });
  await context.engine.handleDelivery(response);
  const terminal = context.events.at(-1);
  assert.equal(terminal?.phase, "done");
  assert.ok(terminal);
  if (feedback !== undefined) {
    assert.equal(await context.store.acknowledgeResult(terminal, feedback), true);
  }
  const fanin: Delivery = {
    ...delivery(`rejected-fanin-${name}`),
    tenant_id: "Hospital", room_id: "grp.hospital", actor_alias: "cauce", recipient_alias: "operador",
    trace_id: root.trace_id,
    body: {
      type: "agent.fanin",
      correlation: { root_message_id: root.message_id, root_delivery_id: root.delivery_id },
      fanin_data_v1: {
        schema: "cauce.agent_fanin_data.v1", expected: 1, completed: 1,
        responses: [{ tenant_id: "Hospital", alias: "teseo", delivery_id: childId, untrusted_text: "raw evidence" }],
      },
    },
  };
  return { context, fanin, runner };
}

test("a fully rejected next delegation preserves the local review and reports the actual limit", async () => {
  const { context, fanin, runner } = await blockedResponse("all", {
    terminal_receipt: "applied", delegation_materializations: [], delegation_rejections: [rejection],
  });
  assert.equal(context.store.processedRepliesForFanin(fanin).length, 1);
  await context.engine.handleDelivery(fanin);
  const output = context.events.at(-1)?.output;
  assert.ok(output);
  assert.equal(runner.calls, 2);
  assert.equal(output.status, "failed");
  assert.match(output.reply ?? "", /límite de pasos/u);
  assert.doesNotMatch(output.reply ?? "", /no tengo un resumen|Se la encargué|raw evidence/u);
  assert.deepEqual(output.messages, []);
});

test("an outgoing request without terminal feedback remains unproven", async () => {
  const { context, fanin } = await blockedResponse("missing");
  assert.equal(context.store.processedRepliesForFanin(fanin).length, 0);
});

test("partial rejection feedback cannot close two outgoing requests", async () => {
  const { context, fanin } = await blockedResponse("partial", {
    terminal_receipt: "applied", delegation_materializations: [], delegation_rejections: [rejection],
  }, 2);
  assert.equal(context.store.processedRepliesForFanin(fanin).length, 0);
});

test("duplicate rejection indices cannot masquerade as complete feedback", async () => {
  const { context, fanin } = await blockedResponse("duplicate", {
    terminal_receipt: "applied", delegation_materializations: [], delegation_rejections: [rejection, rejection],
  }, 2);
  assert.equal(context.store.processedRepliesForFanin(fanin).length, 0);
});

test("an out-of-range rejection index cannot close the outgoing request", async () => {
  const { context, fanin } = await blockedResponse("range", {
    terminal_receipt: "applied", delegation_materializations: [],
    delegation_rejections: [{ ...rejection, output_index: 2 }],
  });
  assert.equal(context.store.processedRepliesForFanin(fanin).length, 0);
});

test("rejections without a materialization receipt remain unproven", async () => {
  const { context, fanin } = await blockedResponse("receipt", {
    terminal_receipt: "applied", delegation_rejections: [rejection],
  });
  assert.equal(context.store.processedRepliesForFanin(fanin).length, 0);
});

test("a materialized outgoing branch remains pending despite a rejected sibling", async () => {
  const { context, fanin } = await blockedResponse("accepted", {
    terminal_receipt: "applied",
    delegation_materializations: [{ output_index: 1, target_tenant: "Hospital", target_alias: "perseo", child_delivery_id: "40000000-0000-4000-8000-000000000002" }],
    delegation_rejections: [rejection],
  }, 2);
  assert.equal(context.store.processedRepliesForFanin(fanin).length, 0);
});

test("an empty outgoing list with contradictory rejection feedback remains unproven", async () => {
  const { context, fanin } = await blockedResponse("contradiction", {
    terminal_receipt: "applied", delegation_materializations: [], delegation_rejections: [rejection],
  }, 0);
  assert.equal(context.store.processedRepliesForFanin(fanin).length, 0);
});

test("an empty outgoing list retains legacy terminal review without feedback", async () => {
  const { context, fanin } = await blockedResponse("legacy", undefined, 0);
  assert.equal(context.store.processedRepliesForFanin(fanin).length, 1);
});
