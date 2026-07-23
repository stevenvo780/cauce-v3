import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  timeout: 30_000,
});
if (packed.status !== 0) throw new Error("npm package dry-run failed");
const reports = JSON.parse(packed.stdout);
assert.ok(Array.isArray(reports) && reports.length === 1);
const files = new Map(reports[0].files.map((entry) => [entry.path, entry]));
for (const path of [
  "dist/bridge/hermes-stdin-bridge.py",
  "dist/bridge/openclaw-stdin-bridge.mjs",
]) {
  const entry = files.get(path);
  assert.ok(entry, `${path} is missing from the package`);
  assert.notEqual(entry.mode & 0o111, 0, `${path} is not executable in the package`);
}
