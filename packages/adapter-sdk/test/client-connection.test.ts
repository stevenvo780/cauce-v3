import assert from "node:assert/strict";
import {rm} from 'node:fs/promises';
import { resolve } from "node:path";
import test from "node:test";
import { ExponentialBackoff } from "../src/sdk/backoff.js";
import {ConsumerLease} from '../src/sdk/durable-store.js';
import { AdapterError, StaleEpochError } from "../src/sdk/errors.js";
import type {ClientFrame, ConsumerConnection} from '../src/sdk/types.js';
import {root, FakeConnection, ScriptedConnector, makeClient} from './client-fixtures.js';
test("stale hello epoch is fenced without reconnecting", async () => {
  const connection = new FakeConnection(1);
  const connector = new ScriptedConnector(connection);
  const { client } = await makeClient("stale-welcome", connector, { epoch: 2 });
  await assert.rejects(client.run(new AbortController().signal), (error: unknown) => error instanceof StaleEpochError);
  assert.equal(connector.calls, 1);
});

test("consumer lease prohibits a second process owner for a stable alias", async () => {
  const directory = resolve(root, "lease");
  await rm(directory, { recursive: true, force: true });
  const first = await ConsumerLease.acquire(directory, "stable_agent", "instance-one");
  await assert.rejects(ConsumerLease.acquire(directory, "stable_agent", "instance-two"));
  await first.release();
  const replacement = await ConsumerLease.acquire(directory, "stable_agent", "instance-two");
  await replacement.release();
});

test("stable aliases reject an ephemeral transport before hello", async () => {
  const sent: ClientFrame[] = [];
  const ephemeral = {
    mode: "consumer",
    ephemeral: true,
    send: async (frame: ClientFrame) => {
      sent.push(frame);
    },
    frames: () => ({
      // eslint-disable-next-line require-yield -- the empty async iterator is the contract: no buffered frames
      async *[Symbol.asyncIterator]() {
        return;
      },
    }),
    close: async () => undefined,
  } as unknown as ConsumerConnection;
  const connector = new ScriptedConnector(ephemeral);
  const { client } = await makeClient("ephemeral-rejected", connector);
  await assert.rejects(
    client.run(new AbortController().signal),
    (error: unknown) => error instanceof AdapterError && error.code === "EPHEMERAL_CONNECTION",
  );
  assert.equal(sent.length, 0);
  assert.equal(connector.calls, 1);
});

test("exponential reconnect backoff is capped and jittered deterministically", () => {
  const backoff = new ExponentialBackoff(
    { initialMs: 100, maxMs: 250, factor: 2, jitter: 0.1 },
    () => 0,
  );
  assert.deepEqual([backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay()], [90, 180, 225]);
  backoff.reset();
  assert.equal(backoff.nextDelay(), 90);
});
