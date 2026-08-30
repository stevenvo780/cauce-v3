import assert from "node:assert/strict";
import test from "node:test";
import {BlockingRunner, FakeConnection, ScriptedConnector, makeClient, renewableDelivery, startedAcks, waitUntil, waitUntilTimestamp} from './client-fixtures.js';
test("a rejected exact renewal aborts the active harness before another attempt can run", async () => {
  const connection = new FakeConnection(1);
  const runner = new BlockingRunner();
  const context = await makeClient(
    "renewal-rejected",
    new ScriptedConnector(connection),
    {
      runner,
      // This case exercises ownership loss, not admission against a nearly-expired claim.
      // Keep the cadence short and the watchdog generous enough for a loaded full-suite run.
      claimRenewalMs: 100,
      claimWatchdogMs: 5_000,
    },
  );
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    connection.push({
      type: "delivery",
      version: "3.0",
      event_id: "30000000-0000-4000-8000-000000000091",
      delivery_id: "20000000-0000-4000-8000-000000000091",
      message_id: "00000000-0000-4000-8000-000000000091",
      request_id: "10000000-0000-4000-8000-000000000091",
      trace_id: "trace-renewal-rejected",
      epoch: 1,
      attempt: 1,
      claim_token: "40000000-0000-4000-8000-000000000091",
      ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
      tenant_id: "Steven",
      room_id: "grp.steven",
      actor_alias: "kant",
      recipient_alias: "agent_renewal_rejected",
      body: { prompt: "block until ownership is lost", timeout_ms: 60_000 },
    });
    await waitUntil(() => runner.started);
    await waitUntil(() => context.store.pendingEvents().some(
      (event) => event.claim_renewal === true && event.execution_started !== true,
    ));
    const renewalEvent = context.store.pendingEvents().find(
      (event) => event.claim_renewal === true && event.execution_started !== true,
    );
    assert.ok(renewalEvent);
    const renewal = connection.sent.find(
      (frame) => frame.type === "ack" && frame.event_id === renewalEvent.event_id,
    );
    assert.ok(renewal, "expected a renewal ACK");
    if (renewal.type !== "ack") throw new Error("expected a renewal ACK");

    connection.push({
      type: "ack_result",
      event_id: renewal.event_id,
      delivery_id: renewal.delivery_id,
      attempt: renewal.attempt,
      claim_token: renewal.claim_token,
      status: "retry",
      applied: false,
      receipt: "ownership_lost",
    });
    await waitUntil(() => runner.aborted);
    await waitUntil(() => connection.sent.some(
      (frame) => frame.type === "ack" && frame.status === "failed",
    ));
    assert.equal(context.store.getDelivery(renewal.delivery_id)?.state, "failed");
  } finally {
    stop.abort();
    await running;
  }
});

test("an unconfirmed renewal watchdog aborts the harness before the claim deadline", async () => {
  const name = "renewal-unconfirmed";
  const connection = new FakeConnection(1);
  const runner = new BlockingRunner();
  const context = await makeClient(name, new ScriptedConnector(connection), {
    runner,
    claimRenewalMs: 100,
    claimWatchdogMs: 1_000,
  });
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    const claimDeadline = Date.now() + 30_000;
    const input = renewableDelivery(name, "000000000092", claimDeadline);
    connection.push(input);

    await waitUntil(() => runner.started);
    await waitUntil(() => startedAcks(connection).length >= 2);
    await waitUntil(() => runner.aborted, 3_000);

    assert.ok(
      Date.now() < claimDeadline,
      "The harness must stop before an unconfirmed claim can expire",
    );
    await waitUntil(() => connection.sent.some(
      (frame) => frame.type === "ack"
        && frame.delivery_id === input.delivery_id
        && frame.status === "failed",
    ));
    assert.equal(context.store.getDelivery(input.delivery_id)?.state, "failed");
  } finally {
    stop.abort();
    await running;
  }
});

test("applied and duplicate renewal receipts each extend the claim watchdog", async (t) => {
  const variants = [
    { name: "renewal-applied", suffix: "000000000093", applied: true, receipt: "applied" as const },
    { name: "renewal-duplicate", suffix: "000000000094", applied: false, receipt: "duplicate" as const },
  ];

  for (const variant of variants) {
    await t.test(variant.receipt, async () => {
      const connection = new FakeConnection(1);
      const runner = new BlockingRunner();
      const context = await makeClient(
        variant.name,
        new ScriptedConnector(connection),
        { runner, claimRenewalMs: 100, claimWatchdogMs: 1_000 },
      );
      const stop = new AbortController();
      const running = context.client.run(stop.signal);
      try {
        await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
        const claimDeadline = Date.now() + 30_000;
        const input = renewableDelivery(variant.name, variant.suffix, claimDeadline);
        connection.push(input);

        await waitUntil(() => runner.started);
        await waitUntil(() => startedAcks(connection).length >= 2);
        const originalWatchdogStartedAt = Date.now();
        await waitUntilTimestamp(originalWatchdogStartedAt + 400);
        const renewal = startedAcks(connection).at(-1);
        assert.ok(renewal, "Expected a renewable started ACK");

        connection.push({
          type: "ack_result",
          event_id: renewal.event_id,
          delivery_id: renewal.delivery_id,
          attempt: renewal.attempt,
          claim_token: renewal.claim_token,
          status: "started",
          applied: variant.applied,
          receipt: variant.receipt,
        });
        await waitUntil(() => !context.store.pendingEvents().some(
          (event) => event.event_id === renewal.event_id,
        ));

        await waitUntilTimestamp(originalWatchdogStartedAt + 1_100);
        assert.equal(
          runner.aborted,
          false,
          `${variant.receipt} must keep the blocked harness alive past the original watchdog`,
        );

        runner.complete();
        await waitUntil(() => connection.sent.some(
          (frame) => frame.type === "ack"
            && frame.delivery_id === input.delivery_id
            && frame.status === "done",
        ));
        assert.equal(context.store.getDelivery(input.delivery_id)?.state, "done");
      } finally {
        stop.abort();
        await running;
      }
    });
  }
});

