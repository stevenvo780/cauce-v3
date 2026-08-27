#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(ops, "scripts/pin-container-release.py");
const runtimeHelper = path.join(ops, "container-runtime/cauce-container-runtime.py");
const temporary = await mkdtemp(path.join(os.tmpdir(), "cauce-container-release-pin-"));
const configRoot = path.join(temporary, "config");
const bundleRoot = path.join(temporary, "bundle");
const releasesRoot = path.join(bundleRoot, "releases");

function runHelper(action, alias, release, digest, expectedRelease, expectedDigest) {
  const args = [
    helper, action, alias,
    "--release", release,
    "--sha256", digest,
    "--expected-release", expectedRelease,
    "--expected-sha256", expectedDigest,
    "--config-root", configRoot,
    "--bundle-root", bundleRoot,
    "--runtime-helper", runtimeHelper,
  ];
  return spawnSync("python3", args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
  });
}

function runHelperAsync(action, alias, release, digest, expectedRelease, expectedDigest) {
  const args = [
    helper, action, alias,
    "--release", release,
    "--sha256", digest,
    "--expected-release", expectedRelease,
    "--expected-sha256", expectedDigest,
    "--config-root", configRoot,
    "--bundle-root", bundleRoot,
    "--runtime-helper", runtimeHelper,
  ];
  return new Promise((resolve) => {
    const child = spawn("python3", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("exit", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function migrateHelper(alias, release, digest, expectedCurrent, expectedDigest) {
  return spawnSync("python3", [
    helper, "migrate", alias,
    "--release", release,
    "--sha256", digest,
    "--expected-current", expectedCurrent,
    "--expected-sha256", expectedDigest,
    "--config-root", configRoot,
    "--bundle-root", bundleRoot,
    "--runtime-helper", runtimeHelper,
  ], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
  });
}

function digestFor(releasePath) {
  const result = spawnSync("python3", [runtimeHelper, "bundle-digest", releasePath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function createRelease(name, marker) {
  const release = path.join(releasesRoot, name);
  const bin = path.join(release, "packages/adapter-sdk/dist/src/bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await writeFile(path.join(bin, "adapter.js"), `#!/usr/bin/env node\n// ${marker}\n`);
  await chmod(path.join(bin, "adapter.js"), 0o555);
  for (const relative of [
    "packages/adapter-sdk/dist/src/bin",
    "packages/adapter-sdk/dist/src",
    "packages/adapter-sdk/dist",
    "packages/adapter-sdk",
    "packages",
    ".",
  ]) await chmod(path.join(release, relative), 0o555);
  return { path: release, digest: digestFor(release) };
}

function body(release, digest, marker) {
  return [
    `# ${marker}: comments and unrelated keys must survive byte-for-byte.`,
    `BUNDLE_RELEASE=${release}`,
    "PKI_DIR=/not-opened/by-release-pin",
    `BUNDLE_SHA256=${digest}`,
    "RELAY_URL=wss://gateway.example.invalid/v3/ws",
    "",
  ].join("\n");
}

async function writeConfig(alias, contents) {
  const destination = path.join(configRoot, `${alias}.env`);
  await writeFile(destination, contents);
  await chmod(destination, 0o600);
  return destination;
}

async function assertNoTemporaryFiles() {
  const names = await readdir(configRoot);
  assert.equal(names.some((name) => name.includes(".env.pin-")), false,
    `atomic helper leaked a staging file: ${JSON.stringify(names)}`);
}

let releaseA;
let releaseB;
try {
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  await chmod(configRoot, 0o700);
  await chmod(bundleRoot, 0o700);
  await chmod(releasesRoot, 0o700);
  releaseA = await createRelease("release-a", "stable");
  releaseB = await createRelease("release-b", "canary");

  const kantConfig = await writeConfig("kant", body("release-a", releaseA.digest, "kant"));
  const argosConfig = await writeConfig("argos", body("release-a", releaseA.digest, "argos"));
  const legacyCurrent = "/srv/cauce-v3-adapter/current";
  const socratesConfig = await writeConfig("socrates", [
    "# socrates legacy migration: comments and unrelated keys must survive byte-for-byte.",
    `BUNDLE_CURRENT=${legacyCurrent}`,
    "PKI_DIR=/not-opened/by-release-pin",
    `BUNDLE_SHA256=${releaseA.digest}`,
    "RELAY_URL=wss://gateway.example.invalid/v3/ws",
    "",
  ].join("\n"));
  const kantBefore = await stat(kantConfig);
  const argosBefore = await readFile(argosConfig, "utf8");

  // Pin only the canary alias.  The second alias remains on its own independent release.
  let result = runHelper("pin", "kant", "release-b", releaseB.digest, "release-a", releaseA.digest);
  assert.equal(result.status, 0, result.stderr);
  const pinned = await readFile(kantConfig, "utf8");
  assert.equal(pinned, body("release-b", releaseB.digest, "kant"));
  assert.equal(await readFile(argosConfig, "utf8"), argosBefore,
    "pinning kant must not change argos");
  const kantAfter = await stat(kantConfig);
  assert.equal(kantAfter.mode & 0o777, 0o600);
  assert.equal(kantAfter.uid, kantBefore.uid);
  assert.equal(kantAfter.gid, kantBefore.gid);
  await assertNoTemporaryFiles();

  // The one-time migration CASes the exact legacy pointer and configured
  // digest, then validates and publishes one direct immutable release.
  result = migrateHelper(
    "socrates", "release-a", releaseA.digest, legacyCurrent, releaseA.digest,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(socratesConfig, "utf8"),
    body("release-a", releaseA.digest, "socrates legacy migration"),
  );
  result = migrateHelper(
    "socrates", "release-b", releaseB.digest, legacyCurrent, releaseA.digest,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /legacy migration requires only BUNDLE_CURRENT/u);

  // Rollback is the same guarded atomic transition in reverse.
  result = runHelper("rollback", "kant", "release-a", releaseA.digest, "release-b", releaseB.digest);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(kantConfig, "utf8"), body("release-a", releaseA.digest, "kant"));

  // Two concurrent writers with the same expected state cannot both win.
  const concurrent = await Promise.all([
    runHelperAsync("pin", "kant", "release-b", releaseB.digest, "release-a", releaseA.digest),
    runHelperAsync("pin", "kant", "release-b", releaseB.digest, "release-a", releaseA.digest),
  ]);
  assert.deepEqual(concurrent.map(({ status }) => status).sort((left, right) => left - right), [0, 78],
    `exactly one concurrent CAS must succeed: ${JSON.stringify(concurrent)}`);
  assert.equal(await readFile(kantConfig, "utf8"), body("release-b", releaseB.digest, "kant"));
  result = runHelper("rollback", "kant", "release-a", releaseA.digest, "release-b", releaseB.digest);
  assert.equal(result.status, 0, result.stderr);

  // Stale operators cannot overwrite a newer pin.
  result = runHelper("pin", "kant", "release-b", releaseB.digest, "wrong-release", releaseA.digest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /compare-and-swap failed/u);
  assert.equal(await readFile(kantConfig, "utf8"), body("release-a", releaseA.digest, "kant"));

  // The declared digest must describe the target immutable release exactly.
  const falseDigest = `sha256:${"f".repeat(64)}`;
  result = runHelper("pin", "kant", "release-b", falseDigest, "release-a", releaseA.digest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /digest differs/u);
  assert.equal(await readFile(kantConfig, "utf8"), body("release-a", releaseA.digest, "kant"));

  // A mutable release is never eligible for pinning, even with its prior valid digest.
  await chmod(releaseB.path, 0o755);
  result = runHelper("pin", "kant", "release-b", releaseB.digest, "release-a", releaseA.digest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /immutable/u);
  await chmod(releaseB.path, 0o555);

  // The release selector itself must be a direct directory, never an aliasing symlink.
  await symlink("release-b", path.join(releasesRoot, "release-link"));
  result = runHelper("pin", "kant", "release-link", releaseB.digest, "release-a", releaseA.digest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Too many levels of symbolic links|Not a directory|failed/u);
  await unlink(path.join(releasesRoot, "release-link"));

  // Config symlinks and relaxed config modes fail before a replacement is published.
  await unlink(argosConfig);
  await symlink("kant.env", argosConfig);
  result = runHelper("pin", "argos", "release-b", releaseB.digest, "release-a", releaseA.digest);
  assert.notEqual(result.status, 0);
  await unlink(argosConfig);
  await writeConfig("argos", argosBefore);
  await chmod(argosConfig, 0o644);
  result = runHelper("pin", "argos", "release-b", releaseB.digest, "release-a", releaseA.digest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mode 0600/u);
  await chmod(argosConfig, 0o600);

  await assertNoTemporaryFiles();
  assert.equal((await lstat(releaseA.path)).isSymbolicLink(), false);
  assert.equal((await lstat(releaseB.path)).isSymbolicLink(), false);
  process.stdout.write("container release pin tests passed: independent pin/rollback, CAS, digest, mode and symlink guards\n");
} finally {
  for (const release of [releaseA?.path, releaseB?.path]) {
    if (!release) continue;
    for (const relative of [
      ".",
      "packages",
      "packages/adapter-sdk",
      "packages/adapter-sdk/dist",
      "packages/adapter-sdk/dist/src",
      "packages/adapter-sdk/dist/src/bin",
    ]) await chmod(path.join(release, relative), 0o755).catch(() => undefined);
  }
  await rm(temporary, { recursive: true, force: true });
}
