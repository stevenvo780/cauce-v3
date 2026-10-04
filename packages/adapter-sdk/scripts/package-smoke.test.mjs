import assert from "node:assert/strict";
import test from "node:test";
import { parsePackReport } from "./package-smoke.mjs";

const packageName = "@cauce/adapter-sdk";
const bridgePaths = [
  "dist/bridge/hermes-stdin-bridge.py",
  "dist/bridge/openclaw-stdin-bridge.mjs",
];

function report(files = bridgePaths.map((path) => ({ path, size: 12, mode: 0o755 }))) {
  return { name: packageName, version: "0.2.0", files };
}

test("accepts the legacy npm one-report array", () => {
  const expected = report();
  assert.deepEqual(parsePackReport(JSON.stringify([expected])), expected);
});

test("accepts npm's object keyed by the package name", () => {
  const expected = report();
  assert.deepEqual(parsePackReport(JSON.stringify({ [packageName]: expected })), expected);
});

test("rejects empty, multiple, malformed, and unrelated reports", () => {
  for (const input of [
    "[]",
    JSON.stringify([report(), report()]),
    JSON.stringify({}),
    JSON.stringify({ "@cauce/other": report() }),
    "{invalid",
  ]) {
    assert.throws(() => parsePackReport(input));
  }
});

test("rejects invalid file lists and duplicate paths", () => {
  for (const files of [null, [], [{ path: "missing-mode" }], [
    { path: bridgePaths[0], mode: 0o755 },
    { path: bridgePaths[0], mode: 0o755 },
  ]]) {
    assert.throws(() => parsePackReport(JSON.stringify([report(files)])));
  }
});

test("rejects missing bridges, non-executable bridges, and invalid modes", () => {
  assert.throws(() => parsePackReport(JSON.stringify([report([{
    path: bridgePaths[0], mode: 0o755,
  }])])));
  assert.throws(() => parsePackReport(JSON.stringify([report(bridgePaths.map((path) => ({
    path, mode: 0o644,
  })))])));
  assert.throws(() => parsePackReport(JSON.stringify([report(bridgePaths.map((path) => ({
    path, mode: -1,
  })))])));
});

test("rejects oversized report output", () => {
  assert.throws(() => parsePackReport(" ".repeat(1_048_577)), /too large/);
});
