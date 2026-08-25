#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cutover = path.join(ops, "scripts/cutover.sh");
const rollback = path.join(ops, "scripts/cutover-rollback.sh");
const migrationGate = path.join(ops, "scripts/migration-gate.mjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "cauce-container-cutover-"));
const bin = path.join(temporary, "bin");
const lockDir = path.join(temporary, "locks");
const xdgRuntime = path.join(temporary, "xdg-runtime");
const unwritableSystemLock = path.join(temporary, "unwritable-system-lock");
const snapshots = path.join(temporary, "snapshots");
const systemctlState = path.join(temporary, "systemctl.json");
const systemctlLog = path.join(temporary, "systemctl.log");
const supervisorLog = path.join(temporary, "supervisor.log");
const probeLog = path.join(temporary, "probe.log");
const fakeSupervisor = path.join(temporary, "fake-supervisor");
const collector = path.join(temporary, "collector");
const probe = path.join(temporary, "probe");

function snapshot({ v3 = 0, phase = "drain", leaseOwners = v3 } = {}) {
  return {
    schemaVersion: 2,
    tenant: "Steven",
    alias: "kant",
    capturedAt: new Date().toISOString(),
    v2: { consumers: 0, pollers: 0, leaseOwners: 0 },
    v3: { consumers: v3, pollers: v3, leaseOwners },
    drain: { inflight: 0, overdueInflight: 0, ownershipMismatch: 0 },
    acks: { rejectedRecent: 0, staleAccepted: 0 },
    queues: { wakePending: 0, outboxPending: 0, relayPending: 0, dlqOpen: 0, dlqNewSinceBaseline: 0 },
    roundTrip: phase === "post-cutover"
      ? { status: "passed", completedAt: new Date().toISOString(), terminalAckApplied: true, activeLeaseMatch: true }
      : { status: "not-run", completedAt: null, terminalAckApplied: false, activeLeaseMatch: false },
  };
}

async function writeSnapshots() {
  await writeFile(path.join(snapshots, "drain.json"), `${JSON.stringify(snapshot())}\n`);
  await writeFile(path.join(snapshots, "post-cutover.json"), `${JSON.stringify(snapshot({ v3: 1, phase: "post-cutover" }))}\n`);
  await writeFile(path.join(snapshots, "rollback-drain.json"), `${JSON.stringify(snapshot({ v3: 1 }))}\n`);
  await writeFile(path.join(snapshots, "rollback-ready.json"), `${JSON.stringify(snapshot())}\n`);
}

async function state(active = [], enabled = [], extra = {}) {
  await writeFile(systemctlState, `${JSON.stringify({ active, enabled, log: systemctlLog, ...extra })}\n`);
  await writeFile(systemctlLog, "");
  await writeFile(supervisorLog, "");
  await writeFile(probeLog, "");
}

function environment(extra = {}) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_SYSTEMCTL_STATE: systemctlState,
    FAKE_GATE_SNAPSHOT_DIR: snapshots,
    FAKE_SUPERVISOR_LOG: supervisorLog,
    FAKE_GATE_PROBE_LOG: probeLog,
    CAUCE_CUTOVER_TEST_MODE: "1",
    CAUCE_CUTOVER_TEST_SUPERVISOR: fakeSupervisor,
    CAUCE_GATE_CAPTURE_PATH: collector,
    CAUCE_GATE_PROBE_PATH: probe,
    CAUCE_CHANGE_ID: "CHG-1",
    CAUCE_CUTOVER_LOCK_DIR: lockDir,
    CAUCE_SYSTEMD_SCOPE: "system",
    ...extra,
  };
}

function run(script, family, snapshotPath, extra = {}) {
  const confirmation = script === cutover
    ? { CAUCE_CUTOVER_CONFIRM: `cutover:${family}:kant:CHG-1` }
    : { CAUCE_ROLLBACK_CONFIRM: `stop-v3:${family}:kant:CHG-1` };
  return spawnSync(script, [family, "kant", snapshotPath], { encoding: "utf8", env: environment({ ...confirmation, ...extra }) });
}

try {
  await mkdir(bin, { recursive: true });
  await mkdir(lockDir, { recursive: true });
  await mkdir(xdgRuntime, { recursive: true });
  // The fallback case needs a system lock dir the cutover cannot use. A 0555 directory
  // expresses that for a normal user, but root bypasses DAC, so bash's -w still reports it
  // as writable and the fallback is never taken. Release hosts run this gate as root, so
  // deny it there by making the path not a directory at all, which no uid can override.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await writeFile(unwritableSystemLock, "", { mode: 0o444 });
  } else {
    await mkdir(unwritableSystemLock, { recursive: true, mode: 0o555 });
    await chmod(unwritableSystemLock, 0o555);
  }
  await mkdir(snapshots, { recursive: true });
  await copyFile(path.join(ops, "tests/fake-systemctl.mjs"), path.join(bin, "systemctl"));
  await copyFile(path.join(ops, "tests/fake-container-supervisor.mjs"), fakeSupervisor);
  await copyFile(path.join(ops, "tests/fake-gate-collector.mjs"), collector);
  await copyFile(path.join(ops, "tests/fake-gate-roundtrip-probe.mjs"), probe);
  await Promise.all([path.join(bin, "systemctl"), fakeSupervisor, collector, probe].map((file) => chmod(file, 0o755)));
  await writeSnapshots();
  const drain = path.join(snapshots, "drain.json");
  const live = path.join(snapshots, "rollback-drain.json");

  // Explicit family is mandatory; an active or enabled alternate family blocks cutover.
  let result = spawnSync(cutover, ["kant", drain], { encoding: "utf8", env: environment() });
  assert.notEqual(result.status, 0);
  await state(["cauce-v3-alias-kant.service"]);
  result = run(cutover, "container", drain);
  assert.equal(result.status, 73);
  await state([], ["cauce-v3-alias-kant.service"]);
  result = run(cutover, "container", drain);
  assert.equal(result.status, 73);

  // Without an explicit lock root, an unprivileged cutover falls back to a
  // user-writable XDG runtime directory instead of requiring /run/lock.
  await state();
  const fallbackEnvironment = environment({
    CAUCE_CUTOVER_CONFIRM: "cutover:container:kant:CHG-1",
    CAUCE_CUTOVER_SYSTEM_LOCK_DIR: unwritableSystemLock,
    XDG_RUNTIME_DIR: xdgRuntime,
  });
  delete fallbackEnvironment.CAUCE_CUTOVER_LOCK_DIR;
  result = spawnSync(cutover, ["container", "kant", drain], { encoding: "utf8", env: fallbackEnvironment });
  assert.equal(result.status, 0, result.stderr);
  await lstat(path.join(xdgRuntime, "cauce-v3/cauce-v3-cutover-kant.lock"));
  process.stdout.write("rootless cutover lock fallback: XDG runtime path used\n");

  // User scope must reach every systemctl invocation as the real --user prefix.
  await state();
  result = run(cutover, "container", drain, { CAUCE_SYSTEMD_SCOPE: "user" });
  assert.equal(result.status, 0, result.stderr);
  const userSystemctlCalls = (await readFile(systemctlLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert(userSystemctlCalls.length > 0);
  assert(userSystemctlCalls.every(({ scope }) => scope === "user"), "every cutover systemctl call must use --user");
  assert(userSystemctlCalls.some(({ action }) => action === "start"));
  assert(userSystemctlCalls.some(({ action }) => action === "enable"));
  process.stdout.write("rootless cutover scope: systemctl --user exercised\n");

  // A negative container supervisor check aborts cutover and rolls the just-started
  // unit back down before the post-cutover gate or enable step can succeed.
  await state();
  result = run(cutover, "container", drain, { FAKE_SUPERVISOR_CHECK_EXIT: "78" });
  assert.equal(result.status, 78, result.stderr);
  let supervisorCalls = (await readFile(supervisorLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(supervisorCalls, [{ action: "check", alias: "kant" }]);
  let current = JSON.parse(await readFile(systemctlState, "utf8"));
  assert.deepEqual(current.active, [], "failed supervisor check must roll the selected unit back down");
  assert.deepEqual(current.enabled, [], "failed supervisor check must not leave the selected unit enabled");
  process.stdout.write("negative supervisor check: cutover aborted and unit rolled back\n");

  // Container cutover starts only its family, runs positive supervisor check and migration gate.
  await state();
  result = run(cutover, "container", drain);
  assert.equal(result.status, 0, result.stderr);
  supervisorCalls = (await readFile(supervisorLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(supervisorCalls, [{ action: "check", alias: "kant" }]);
  current = JSON.parse(await readFile(systemctlState, "utf8"));
  assert.deepEqual(current.active, ["cauce-v3-container-kant.service"]);
  assert.deepEqual(current.enabled, ["cauce-v3-container-kant.service"]);
  assert.deepEqual((await readFile(probeLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [{ alias: "kant" }]);

  // An authentic probe failure is a hard gate: the just-started runtime is stopped and never enabled.
  await state();
  result = run(cutover, "container", drain, { FAKE_GATE_PROBE_EXIT: "79" });
  assert.equal(result.status, 79, result.stderr);
  current = JSON.parse(await readFile(systemctlState, "utf8"));
  assert.deepEqual(current.active, [], "failed round-trip probe must roll the selected unit back down");
  assert.deepEqual(current.enabled, [], "failed round-trip probe must not leave the selected unit enabled");

  // Rollback disables/stops, proves negative process state, then and only then accepts rollback-ready.
  await state(["cauce-v3-container-kant.service"], ["cauce-v3-container-kant.service"]);
  result = run(rollback, "container", live);
  assert.equal(result.status, 0, result.stderr);
  current = JSON.parse(await readFile(systemctlState, "utf8"));
  assert.deepEqual(current.active, []);
  assert.deepEqual(current.enabled, []);
  const negativeCalls = (await readFile(supervisorLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(negativeCalls, [{ action: "stopped", alias: "kant" }]);

  // Auto-resurrection or alternate-family overlap blocks rollback readiness.
  await state(["cauce-v3-alias-kant.service"], ["cauce-v3-container-kant.service"]);
  result = run(rollback, "container", live);
  assert.equal(result.status, 73);
  await state(["cauce-v3-container-kant.service"], ["cauce-v3-container-kant.service"], { disableKeepsEnabled: true });
  result = run(rollback, "container", live);
  assert.notEqual(result.status, 0);
  assert.equal((await readFile(supervisorLog, "utf8")).trim(), "", "negative check must not run while unit can resurrect");

  // Migration gate independently enforces exactly one V3 consumer/poller/lease owner.
  const badLease = path.join(snapshots, "bad-lease.json");
  await writeFile(badLease, `${JSON.stringify(snapshot({ v3: 1, phase: "post-cutover", leaseOwners: 0 }))}\n`);
  result = spawnSync("node", [migrationGate, "post-cutover", badLease, "kant"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  const duplicate = path.join(snapshots, "duplicate.json");
  await writeFile(duplicate, `${JSON.stringify(snapshot({ v3: 2, phase: "post-cutover", leaseOwners: 2 }))}\n`);
  result = spawnSync("node", [migrationGate, "post-cutover", duplicate, "kant"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);

  // Rollback is refused when the alternate family is merely enabled (even if inactive):
  // both V3 families must be inactive AND disabled before rollback-ready.
  await state([], ["cauce-v3-alias-kant.service"]);
  result = run(rollback, "container", live);
  assert.equal(result.status, 73, `rollback must refuse an enabled alternate family: ${result.stderr}`);
  assert.equal((await readFile(supervisorLog, "utf8")).trim(), "", "no negative check runs while the alternate stays enabled");

  // Two cutovers cannot run concurrently for the same alias: the shared host flock serializes them.
  await state();
  const aliasLock = path.join(lockDir, "cauce-v3-cutover-kant.lock");
  const holder = spawn("flock", ["-x", aliasLock, "-c", "sleep 3"], { stdio: "ignore" });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (spawnSync("flock", ["-n", aliasLock, "-c", "true"]).status !== 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const blocked = run(cutover, "container", drain);
    assert.equal(blocked.status, 73, `a concurrent cutover must be refused by the alias flock: ${blocked.stderr}`);
    const stillDown = JSON.parse(await readFile(systemctlState, "utf8"));
    assert.deepEqual(stillDown.active, [], "the refused concurrent cutover must not start any unit");
  } finally {
    holder.kill("SIGKILL");
  }

  process.stdout.write("container cutover and rollback tests passed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
