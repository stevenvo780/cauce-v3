import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const packageName = "@cauce/adapter-sdk";
const requiredBridges = [
  "dist/bridge/hermes-stdin-bridge.py",
  "dist/bridge/openclaw-stdin-bridge.mjs",
];
const maxReportBytes = 1_048_576;
const maxFiles = 20_000;

function validateReport(report) {
  assert.ok(report && typeof report === "object" && !Array.isArray(report));
  assert.equal(report.name, packageName);
  assert.ok(Array.isArray(report.files) && report.files.length > 0);
  assert.ok(report.files.length <= maxFiles, "package file list is too large");

  const files = new Map();
  for (const entry of report.files) {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
    assert.ok(typeof entry.path === "string" && entry.path.length > 0);
    assert.ok(Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o7777);
    assert.ok(!files.has(entry.path), `duplicate package path: ${entry.path}`);
    files.set(entry.path, entry);
  }

  for (const path of requiredBridges) {
    const entry = files.get(path);
    assert.ok(entry, `${path} is missing from the package`);
    assert.notEqual(entry.mode & 0o111, 0, `${path} is not executable in the package`);
  }
}

export function parsePackReport(stdout) {
  assert.ok(typeof stdout === "string" && Buffer.byteLength(stdout, "utf8") <= maxReportBytes,
    "npm package report is missing or too large");
  const parsed = JSON.parse(stdout);
  let report;
  if (Array.isArray(parsed)) {
    assert.equal(parsed.length, 1, "expected exactly one npm package report");
    [report] = parsed;
  } else {
    assert.ok(parsed && typeof parsed === "object");
    const keys = Object.keys(parsed);
    assert.deepEqual(keys, [packageName], "expected exactly one adapter SDK report");
    report = parsed[packageName];
  }
  validateReport(report);
  return report;
}

function runPackageSmoke() {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: maxReportBytes,
  });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error("npm package dry-run failed");
  parsePackReport(packed.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPackageSmoke();
}
