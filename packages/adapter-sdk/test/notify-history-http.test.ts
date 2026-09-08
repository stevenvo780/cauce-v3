import assert from "node:assert/strict";
import test from "node:test";
import { HttpEgressReceiptSource } from "../src/sdk/egress-receipt-source.js";
import { pertinentNotices } from "../src/sdk/notify-history.js";
import { scope, incidentId, wireReceipt, record, now } from "./notify-history-fixtures.js";

const signal = () => new AbortController().signal;

test("agent egress batches and deduplicates UUIDs without query identity", async () => {
  const calls: string[][] = [];
  const source = new HttpEgressReceiptSource(async (method, path, body) => {
    assert.equal(method, "GET"); assert.equal(body, undefined);
    const url = new URL(path, "http://contract.test");
    assert.equal(url.pathname, "/v3/agent/egress");
    assert.deepEqual([...url.searchParams.keys()], ["delivery_ids"]);
    const requested = url.searchParams.get("delivery_ids")?.split(",") ?? [];
    assert.ok(requested.length >= 1 && requested.length <= 20);
    calls.push(requested);
    return { requested, items: [] };
  }, scope);
  const deliveryIds = Array.from({ length: 41 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  await source.read(scope, [...deliveryIds, ...deliveryIds], signal());
  assert.deepEqual(calls.map(batch => batch.length), [20, 20, 1]);
  assert.deepEqual(calls.flat(), deliveryIds);
  await source.read(scope, [], signal()); assert.equal(calls.length, 3);
});

for (const field of ["tenant_id", "alias"] as const) {
  test(`HTTP client rejects a foreign ${field} before requesting`, async () => {
    let calls = 0;
    const source = new HttpEgressReceiptSource(async () => { calls++; return {}; }, scope);
    await assert.rejects(source.read({ ...scope, [field]: "foreign" }, [incidentId], signal()), /identity mismatch/u);
    assert.equal(calls, 0);
  });
}

test("HTTP client does not query invalid delivery ids", async () => {
  const source = new HttpEgressReceiptSource(async () => assert.fail("HTTP must not run"), scope);
  await assert.rejects(source.read(scope, ["not-a-uuid"], signal()), /UUID/u);
});

test("a foreign delivery in a response fails closed", async () => {
  const source = new HttpEgressReceiptSource(async () => ({ requested: [incidentId],
    items: [wireReceipt({ source_delivery_id: "00000000-0000-4000-8000-000000000009" })] }), scope);
  await assert.rejects(source.read(scope, [incidentId], signal()), /Invalid agent egress item/u);
});

for (const state of ["sent", "partial", "pending", "ambiguous", "dead", "denied", "unconfirmed", "unknown"]) {
  test(`HTTP projection preserves public state ${state}`, async () => {
    const source = new HttpEgressReceiptSource(async () => ({ requested: [incidentId],
      items: [wireReceipt({ state })] }), scope);
    const rows = await source.read(scope, [incidentId], signal());
    assert.equal(rows[0]?.status, state);
  });
}

for (const state of ["prepared", "sending"]) {
  test(`HTTP projection rejects internal state ${state}`, async () => {
    const source = new HttpEgressReceiptSource(async () => ({ requested: [incidentId], items: [wireReceipt({ state })] }), scope);
    await assert.rejects(source.read(scope, [incidentId], signal()), /Invalid agent egress item/u);
  });
}

test("a missing destination is excluded without dropping an accredited notice", async () => {
  const source = new HttpEgressReceiptSource(async () => ({ requested: [incidentId],
    items: [wireReceipt({ destination: null }), wireReceipt()] }), scope);
  const rows = await source.read(scope, [incidentId], signal());
  assert.equal(rows.length, 1);
  assert.equal(pertinentNotices([record()], scope, rows, now).records.length, 1);
});

test("HTTP projection correlates separate notifications and destinations", async () => {
  const r = record(); assert.ok(r.output);
  const second = { to: "different_destination", kind: "alert" as const, body: "Other recipient" };
  const source = new HttpEgressReceiptSource(async () => ({ requested: [incidentId], items: [wireReceipt(),
    wireReceipt({ notification_id: "notice-2", notify_index: 1, effect_ids: ["effect-2"],
      destination: { adapter: "telegram", channel: "telegram", conversation_id: "other", handle: second.to },
      provider_message_ids: ["different-message"], provider_message_id: "different-message" })] }), scope);
  const rows = await source.read(scope, [incidentId], signal());
  const selected = pertinentNotices([{ ...r, output: { ...r.output, notify: [...r.output.notify, second] } }], scope, rows, now);
  assert.equal(selected.records.length, 1);
  assert.deepEqual(selected.records[0]?.provider_message_ids, ["2703"]);
});

test("an older attempt cannot attach its receipt to a newer inbox body", async () => {
  const source = new HttpEgressReceiptSource(async () => ({ requested: [incidentId], items: [wireReceipt()] }), scope);
  const rows = await source.read(scope, [incidentId], signal());
  const selected = pertinentNotices([{ ...record(), attempt: 2 }], scope, rows, now);
  assert.equal(selected.records.length, 0); assert.equal(selected.unclassified, 1);
});

test("legacy singular provider evidence is usable only for completely sent output", async () => {
  const source = new HttpEgressReceiptSource(async () => ({ requested: [incidentId],
    items: [wireReceipt({ provider_message_ids: undefined })] }), scope);
  const rows = await source.read(scope, [incidentId], signal());
  assert.deepEqual(rows[0]?.provider_message_ids, ["2703"]);
});

test("an aborted lookup does not issue HTTP requests", async () => {
  let calls = 0;
  const source = new HttpEgressReceiptSource(async () => { calls++; return {}; }, scope);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(source.read(scope, [incidentId], controller.signal));
  assert.equal(calls, 0);
});
