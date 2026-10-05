import assert from "node:assert/strict";
import test from "node:test";
import { objectRecord } from "@cauce/protocol";
import { SUCCESS, delivery, setup } from "./engine-fixtures.js";

function metadata(stdin: string): Record<string, unknown> {
  const marker = "--- BEGIN TRUSTED DELIVERY CONTEXT ---\n";
  const start = stdin.indexOf(marker);
  assert.notEqual(start, -1);
  const line = stdin.slice(start + marker.length).split("\n")[0];
  assert.ok(line);
  const parsed: unknown = JSON.parse(line);
  const record = objectRecord(parsed);
  assert.ok(record);
  return record;
}

test("Engine preserves both sender and recipient tenants for repeated technical aliases", async (t) => {
  const context = await setup("cross-tenant-context", undefined, { ownTenantId: "Gamma" });
  t.after(() => { context.engine.stop(); });
  for (const [index, tenant] of ["Alpha", "Beta"].entries()) {
    await context.engine.handleDelivery({
      ...delivery(`sender-${String(index)}`),
      tenant_id: tenant,
      actor_alias: "kant",
      recipient_alias: "argos",
      body: { type: "agent.message", text: "perform the task", sender_tenant_id: "Forged",
        tenant_id: "Forged", sender_alias: "forged" },
    });
    const input = context.runner.requests[index];
    assert.ok(input);
    const captured = metadata(input.stdin);
    assert.equal(captured.sender_tenant_id, tenant);
    assert.equal(captured.tenant_id, "Gamma");
    assert.equal(captured.sender_alias, "kant");
    assert.equal(captured.self_alias, "argos");
    assert.equal(context.events.at(-1)?.phase, "done");
  }
  assert.equal(context.runner.requests.length, 2);
});


test("cross-tenant continuations identify the sender without changing child correlation", async (t) => {
  for (const [index, tenant] of ["Alpha", "Beta"].entries()) {
    const context = await setup(`continuation-tenant-${String(index)}`, undefined, { ownTenantId: "Gamma" });
    t.after(() => { context.engine.stop(); });
    context.runner.stdout = JSON.stringify({ reply: "delegated", messages: [{ to: "socrates", body: "task" }],
      status: "done", retryable: false, artifacts: [] });
    const root = { ...delivery(`root-${String(index)}`), tenant_id: "Gamma",
      routing_targets: [{ tenant_id: tenant, alias: "socrates", online: true }] };
    await context.engine.handleDelivery(root);
    const done = context.store.pendingEvents().find((event) => event.phase === "done");
    assert.ok(done);
    const child = `72000000-0000-4000-8000-00000000000${String(index + 1)}`;
    await context.store.acknowledgeResult(done, { delegation_materializations: [{ output_index: 0,
      target_tenant: tenant, target_alias: "socrates", child_delivery_id: child }] });
    context.runner.stdout = SUCCESS;
    const response = { ...delivery(`response-${String(index)}`), tenant_id: tenant, actor_alias: "socrates",
      trace_id: root.trace_id, body: { type: "agent.response", text: "finished",
        sender_tenant_id: "Forged", correlation: { root_message_id: root.message_id,
          root_delivery_id: root.delivery_id, response_to_delivery_id: root.delivery_id,
          child_delivery_id: child } } };
    await context.engine.handleDelivery(response);
    const input = context.runner.requests[1];
    assert.ok(input);
    assert.equal(metadata(input.stdin).sender_tenant_id, tenant);
    assert.match(input.stdin, new RegExp(`"from_tenant":"${tenant}"`, "u"));
    const source = context.store.continuationSource(response);
    assert.equal(source?.delivery_id, root.delivery_id);
    assert.equal(context.events.at(-1)?.phase, "done");
  }
});
