import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { waitUntil } from "./client-fixtures.js";
import { testStateRoot, testStateScope } from "./test-state.js";

test("the on-disk test root is seeded per process so a concurrent run cannot delete it", () => {
  const previous = process.env.CAUCE_TEST_STATE_ID;
  delete process.env.CAUCE_TEST_STATE_ID;
  try {
    assert.equal(testStateScope(), String(process.pid));
    assert.equal(testStateRoot(), resolve(tmpdir(), "cauce-adapter-sdk-test-state", String(process.pid)));
    assert.equal(
      testStateRoot("suite"),
      resolve(tmpdir(), "cauce-adapter-sdk-test-state", String(process.pid), "suite"),
    );
  } finally {
    if (previous === undefined) delete process.env.CAUCE_TEST_STATE_ID;
    else process.env.CAUCE_TEST_STATE_ID = previous;
  }
});

test("CAUCE_TEST_STATE_ID overrides the per-process seed for the whole run", () => {
  const previous = process.env.CAUCE_TEST_STATE_ID;
  process.env.CAUCE_TEST_STATE_ID = "run-a";
  try {
    assert.equal(testStateScope(), "run-a");
    assert.equal(testStateRoot("suite"), resolve(tmpdir(), "cauce-adapter-sdk-test-state", "run-a", "suite"));
    process.env.CAUCE_TEST_STATE_ID = "run-b";
    assert.notEqual(testStateRoot("suite"), resolve(tmpdir(), "cauce-adapter-sdk-test-state", "run-a", "suite"));
  } finally {
    if (previous === undefined) delete process.env.CAUCE_TEST_STATE_ID;
    else process.env.CAUCE_TEST_STATE_ID = previous;
  }
});

test("a segment that climbs out of the per-process root is rejected", () => {
  assert.ok(testStateRoot("a", "b").startsWith(`${testStateRoot()}/`));
  assert.throws(() => testStateRoot("..", "x"), /escapes its per-process root/);
});

test("a waitUntil timeout names the predicate source and the elapsed budget", async () => {
  await assert.rejects(
    () => waitUntil(() => false, 20),
    (error: Error) => {
      assert.match(error.message, /^condition timeout after \d+ms: /);
      assert.match(error.message, /false/);
      return true;
    },
  );
});
