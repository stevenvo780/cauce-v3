#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile,
} from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escenariosA } from "./container-supervisor-escenarios-a.mjs";
import { escenariosB } from "./container-supervisor-escenarios-b.mjs";

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supervisor = path.join(ops, "scripts/container-adapter-supervisor.sh");
const runtimeHelper = path.join(ops, "container-runtime/cauce-container-runtime.py");
const fakeDockerSource = path.join(ops, "tests/fake-docker.mjs");
// The lifecycle fixtures require an unprivileged controller before any fixture is created.
const droppedFromRoot = typeof process.getuid === "function" && process.getuid() === 0;
if (droppedFromRoot) {
  const testUid = Number.parseInt(process.env.CAUCE_TEST_RUNTIME_UID ?? process.env.SUDO_UID ?? "65534", 10);
  const testGid = Number.parseInt(process.env.CAUCE_TEST_RUNTIME_GID ?? process.env.SUDO_GID ?? "65534", 10);
  assert(Number.isInteger(testUid) && testUid > 0 && Number.isInteger(testGid) && testGid > 0,
    "the container supervisor suite requires a non-root test identity");
  process.setgid(testGid);
  process.setgroups([testGid]);
  process.setuid(testUid);
  assert.equal(process.getuid(), testUid, "the supervisor suite must run under the requested non-root identity");
  assert.notEqual(process.getuid(), 0, "the supervisor suite must never run as root");
  process.stdout.write(`dropped the supervisor suite to the non-root test identity ${testUid}:${testGid}\n`);
}

test("container supervisor adversarial scenarios", async () => {
const temporary = await mkdtemp(path.join(os.tmpdir(), "cauce-container-supervisor-"));
const configRoot = path.join(temporary, "config");
const bundleRoot = path.join(temporary, "bundle");
const release = path.join(bundleRoot, "releases/release-1");
const release2 = path.join(bundleRoot, "releases/release-2");
const pkiRoot = path.join(temporary, "pki");
const mountSourceRoot = path.join(temporary, "persistent");
const lockRoot = path.join(temporary, "locks");
const binRoot = path.join(temporary, "bin");
const log = path.join(temporary, "docker.jsonl");
const imageId = `sha256:${"a".repeat(64)}`;
const firstId = "1".repeat(64);
const secondId = "2".repeat(64);
const firstGenerationStartedAt = "2026-07-22T10:00:00.000000000Z";
const secondGenerationStartedAt = "2026-07-22T10:01:00.000000000Z";
const labelKey = "com.example.runtime";
const labelValue = "approved-runtime";
// Atlas and Kratos share ws-humanizar with distinct Codex and Claude profiles.
const aliasState = {
  argos: "/home/dev/.local/state/cauce-v3/argos",
  atlas: "/home/dev/.local/state/cauce-v3/atlas", iza: "/home/claw/.openclaw/cauce-v3/iza",
  jarvis: "/home/claw/.openclaw/cauce-v3/jarvis", kratos: "/home/dev/.local/state/cauce-v3/kratos",
  zeus: "/home/dev/.local/state/cauce-v3/zeus", hades: "/home/claw/.local/state/cauce-v3/hades",
};
// The real fleet never dedicates a mount to the state dir: the state lives inside a broad
// persistent bind. Physical co-location does not imply that aliases share the same mapped HOME.
const aliasMount = {
  argos: "/home/dev/.local", atlas: "/home/dev/.local",
  iza: "/home/claw/.openclaw", jarvis: "/home/claw/.openclaw", kratos: "/home/dev/.local",
  zeus: "/home/dev/.local", hades: "/home/claw",
};
let bundleDigest;
let bundleDigest2;
const cleanupGroups = [];
const cleanupProcesses = [];
const privilegedChildren = [];
const privilegedRoots = [];

async function executable(pathname, body) {
  await writeFile(pathname, body);
  await chmod(pathname, 0o555);
}

function bundleDigestFor(pathname) {
  const result = spawnSync("python3", [runtimeHelper, "bundle-digest", pathname], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function writeConfig(alias, extra = [], overrides = {}, omit = []) {
  const values = {
    BUNDLE_RELEASE: "release-1",
    BUNDLE_SHA256: bundleDigest,
    PKI_DIR: `${pkiRoot}/${alias}`,
    RELAY_URL: "wss://gateway.example.invalid/v3/ws",
    EXPECTED_IMAGE_ID: imageId,
    EXPECTED_LABEL_KEY: labelKey,
    EXPECTED_LABEL_VALUE: labelValue,
    MOUNT_TYPE: "bind",
    MOUNT_SOURCE: `${mountSourceRoot}/${alias}`,
    MOUNT_DESTINATION: aliasMount[alias],
    MOUNT_RW: "true",
    CAUCE_SEMBRAR_PERFIL: "1",
    ...(alias === "atlas" || alias === "kratos" ? { CONFIG_POR_ALIAS: "1" } : {}),
    ...(alias === "zeus" || alias === "kratos" ? { EXPECTED_CLI_VERSION: "2.1.220" } : {}),
    ...(alias === "argos" ? { OPENCLAW_WORKSPACE: "/home/dev/clawd" } : {}),
    ...(alias === "iza" || alias === "jarvis" ? { OPENCLAW_WORKSPACE: "/home/claw/clawd" } : {}),
    ...overrides,
  };
  for (const key of omit) delete values[key];
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  lines.push(...extra);
  const destination = path.join(configRoot, `${alias}.env`);
  await writeFile(destination, `${lines.join("\n")}\n`);
  await chmod(destination, 0o600);
}

async function preparePki(alias, { bearer = true } = {}) {
  const directory = path.join(pkiRoot, alias);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const material = [
    ["client.crt", "fake-certificate"],
    ["client.key", `FAKE_KEY_${alias}`],
    ["ca.crt", "fake-ca"],
  ];
  if (bearer) material.unshift(["token", `FAKE_TOKEN_${alias}`]);
  for (const [name, value] of material) {
    const destination = path.join(directory, name);
    await writeFile(destination, `${value}\n`);
    await chmod(destination, 0o600);
  }
}

const bind = (source, destination) => ({ Type: "bind", Source: `${mountSourceRoot}/${source}`, Destination: destination, RW: true });

async function dockerState(alias, overrides = {}) {
  const statePath = path.join(temporary, `docker-${alias}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const state = {
    containerName: alias === "jarvis" ? "claw"
      : alias === "iza" ? "claw-iza"
      : alias === "atlas" || alias === "kratos" ? "ws-humanizar"
      : alias === "zeus" ? "ws-zeus"
      : alias === "hades" ? "agv2-steven-hades-oc"
      : "ctrl-infra", // argos
    currentId: firstId,
    replacementId: secondId,
    running: true,
    startedAt: firstGenerationStartedAt,
    replacementStartedAt: secondGenerationStartedAt,
    initStarttime: 1000,
    replacementInitStarttime: 2000,
    restartCount: 0,
    imageId,
    labelKey,
    labelValue,
    mounts: [
      bind(alias, aliasMount[alias]),
      ...(alias === "atlas" ? [bind(`${alias}-workspace`, "/workspace")] : []),
      ...(alias === "atlas" || alias === "kratos" ? [bind(`${alias}-codex`, "/home/dev/.codex")] : []),
      ...(alias === "zeus" ? [bind(`${alias}-claude`, "/home/dev/.claude"), bind(`${alias}-claude-json`, "/home/dev/.claude.json")] : []),
      ...(alias === "argos" ? [bind(`${alias}-workspace`, "/home/dev/clawd")] : []),
      ...(alias === "iza" || alias === "jarvis" ? [bind(`${alias}-workspace`, "/home/claw/clawd")] : []),
    ],
    bundleDigest,
    controlExists: true,
    stateExists: true,
    callCount: 0,
    raceAt: -1,
    finalDelayMs: 0,
    log,
    ...overrides,
  };
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  return statePath;
}

function environment(statePath) {
  return {
    // systemd (CI) starts without HOME after dropping to nobody; the supervisor derives XDG from HOME.
    HOME: temporary,
    ...process.env,
    PATH: `${binRoot}:${process.env.PATH ?? ""}`,
    CAUCE_CONTAINER_TEST_MODE: "1",
    CAUCE_ALLOW_ROOT_TEST_MODE: "1",
    CAUCE_CONTAINER_CONFIG_ROOT: configRoot,
    CAUCE_CONTAINER_BUNDLE_ROOT: bundleRoot,
    CAUCE_CONTAINER_PKI_ROOT: pkiRoot,
    CAUCE_CONTAINER_LOCK_ROOT: lockRoot,
    CAUCE_CONTAINER_WAIT_SECONDS: "0",
    FAKE_DOCKER_STATE: statePath,
  };
}

function runSupervisor(action, alias, statePath) {
  return spawnSync(supervisor, [action, alias], { encoding: "utf8", env: environment(statePath) });
}

async function clearLog() { await writeFile(log, ""); }
function parseRecords(contents, { allowIncompleteTail = false } = {}) {
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  else if (allowIncompleteTail) lines.pop();
  else throw new SyntaxError("JSONL record is not committed by a newline");
  return lines.map((line) => JSON.parse(line));
}
async function records(options) {
  return parseRecords(await readFile(log, "utf8"), options);
}

// A live JSONL reader may observe the final append after its body is visible but before the terminating
// newline. Only that in-flight tail is retryable; malformed or post-exit-truncated records stay hard failures.
assert.deepEqual(
  parseRecords('{"call":1}\n{"call":', { allowIncompleteTail: true }),
  [{ call: 1 }],
);
assert.throws(() => parseRecords('{"call":1}\nnot-json\n', { allowIncompleteTail: true }), SyntaxError);
assert.throws(() => parseRecords('{"call":'), SyntaxError);
assert.throws(() => parseRecords('{"call":1}'), /not committed by a newline/u);

async function waitForFile(pathname, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { await lstat(pathname); return; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error(`timed out waiting for ${pathname}`);
}

async function waitForMetadata(pathname, generation, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const document = JSON.parse(await readFile(pathname, "utf8"));
      if (document.containerGeneration === generation && document.phase === "running"
        && document.pid && processAlive(document.pid)) return document;
    } catch { /* publication is not complete yet */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for lifecycle metadata ${pathname}`);
}

async function waitForMetadataPhase(pathname, phase, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const document = JSON.parse(await readFile(pathname, "utf8"));
      if (document.phase === phase) return document;
    } catch { /* publication is not complete yet */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for lifecycle phase ${phase}`);
}

async function waitForLogOrExit(child, predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate(await records({ allowIncompleteTail: true }))) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      // The producer may have committed its final newline between the live read and the exit observation.
      // Re-read strictly once: accept a completed barrier, but surface a truncated/malformed log as such.
      if (predicate(await records())) return;
      throw new Error(`supervisor exited before fake Docker barrier: status=${child.exitCode} signal=${child.signalCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for live supervisor at fake Docker barrier");
}

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { status: child.exitCode, signalName: child.signalCode };
  }
  return new Promise((resolve) => child.once("exit",
    (status, signalName) => resolve({ status, signalName })));
}

function processAlive(pid) {
  // A zombie is terminated (awaiting reaping) and counts as gone. This matters here
  // because the sandbox PID 1 is not a reaping init and stop runs synchronously.
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = raw.slice(raw.lastIndexOf(")") + 2).trimStart()[0];
    return state !== "Z";
  } catch { return false; }
}

function processIdentity(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
  return {
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    starttime: Number(fields[19]),
  };
}

async function waitProcessGone(pid, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!processAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} remained alive`);
}

async function waitForCommand(pid, fragment, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const command = await readFile(`/proc/${pid}/cmdline`);
      if (command.includes(Buffer.from(fragment))) return;
    } catch { /* process has not completed exec yet */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} did not exec ${fragment}`);
}

const lifecycleContainerId = "b".repeat(64);
const lifecycleGeneration = "c".repeat(64);
const replacementGeneration = "d".repeat(64);

// The adapter always runs non-root: an unprivileged run can only request its own identity; a root run
// (the release gate) must name a real unprivileged account, because child_credentials() rejects 0.
const runningAsRoot = process.getuid() === 0;
const testIdentity = (() => {
  if (!runningAsRoot) return { uid: process.getuid(), gid: process.getgid() };
  const uid = Number(process.env.CAUCE_CONTAINER_TEST_RUNTIME_UID ?? 65534);
  const gid = Number(process.env.CAUCE_CONTAINER_TEST_RUNTIME_GID ?? 65534);
  assert.ok(Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0,
    "a root fixture run needs a non-root CAUCE_CONTAINER_TEST_RUNTIME_UID/GID pair");
  return { uid, gid };
})();
const runtimeUid = String(testIdentity.uid);
const runtimeGid = String(testIdentity.gid);
// Under root the mkdtemp fixture root is root-owned 0700, so the dropped adapter child could neither
// traverse it nor write PID files; hand it to the same unprivileged identity, widening no mode.
if (runningAsRoot) await chown(temporary, testIdentity.uid, testIdentity.gid);
const metadataName = "cauce-v3-adapter.json";
const lockName = "cauce-v3-adapter.lock";

async function makeControl(name) {
  // Root-owned in production; in the unprivileged test the controller runs as the
  // current user, so the control dir is owned by that same user with mode 0700.
  const control = path.join(temporary, `control-${name}-${Math.random().toString(16).slice(2)}`);
  await mkdir(control, { recursive: true, mode: 0o700 });
  await chmod(control, 0o700);
  return control;
}

function lifecycleArgs(action, state, control, generation = lifecycleGeneration) {
  return [runtimeHelper, action, "--alias", "atlas", "--state", state, "--control-dir", control,
    "--container-id", lifecycleContainerId, "--generation", generation, "--term-seconds", "0.2", "--kill-seconds", "1"];
}

function lifecycleEnv(state, control, generation, extra = {}) {
  return {
    ...process.env,
    CAUCE_ALIAS: "atlas",
    CAUCE_STATE_DIR: state,
    CAUCE_CONTROL_DIR: control,
    CAUCE_CONTAINER_ID: lifecycleContainerId,
    CAUCE_CONTAINER_GENERATION: generation,
    ...extra,
  };
}

function runArgs(state, control, executablePath, executableArgs = [], generation = lifecycleGeneration) {
  return [...lifecycleArgs("run", state, control, generation), "--runtime-uid", runtimeUid, "--runtime-gid", runtimeGid,
    "--bundle", release, "--bundle-digest", bundleDigest, executablePath, ...executableArgs];
}

async function startManaged(state, control, executablePath, executableArgs = [], generation = lifecycleGeneration) {
  const metadata = path.join(control, metadataName);
  const child = spawn("python3", runArgs(state, control, executablePath, executableArgs, generation), {
    stdio: "ignore",
    env: lifecycleEnv(state, control, generation),
  });
  const document = await waitForMetadata(metadata, generation);
  cleanupGroups.push(document.pgid);
  cleanupProcesses.push(child);
  return { child, metadata, control, document };
}

function stopManaged(state, control, generation = lifecycleGeneration) {
  return spawnSync("python3", lifecycleArgs("stop", state, control, generation), { encoding: "utf8" });
}

async function stopManagedAtGate(state, control, marker, release, generation = lifecycleGeneration) {
  const child = spawn("python3", lifecycleArgs("stop", state, control, generation), {
    env: { ...process.env, CAUCE_CONTAINER_TEST_STOP_GATE: `${marker}|${release}|8` },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const completed = new Promise((resolve) => child.once("exit", (status, signalName) => resolve({ status, signalName, stderr })));
  await waitForFile(marker);
  return { child, completed };
}

async function immutableFixture() {
  // The real bundle is a mini-monorepo: adapters live under packages/adapter-sdk/dist/src/bin,
  // so the immutable fixture must freeze that exact nesting (deepest first).
  for (const directory of [
    "releases/release-1/packages/adapter-sdk/dist/src/bin",
    "releases/release-1/packages/adapter-sdk/dist/src",
    "releases/release-1/packages/adapter-sdk/dist",
    "releases/release-1/packages/adapter-sdk",
    "releases/release-1/packages",
    "releases/release-1",
  ]) await chmod(path.join(bundleRoot, directory), 0o555);
  for (const directory of [
    "releases/release-2/packages/adapter-sdk/dist/src/bin",
    "releases/release-2/packages/adapter-sdk/dist/src",
    "releases/release-2/packages/adapter-sdk/dist",
    "releases/release-2/packages/adapter-sdk",
    "releases/release-2/packages",
    "releases/release-2",
  ]) await chmod(path.join(bundleRoot, directory), 0o555);
}

async function writableFixture() {
  for (const directory of [
    "releases/release-1",
    "releases/release-1/packages",
    "releases/release-1/packages/adapter-sdk",
    "releases/release-1/packages/adapter-sdk/dist",
    "releases/release-1/packages/adapter-sdk/dist/src",
    "releases/release-1/packages/adapter-sdk/dist/src/bin",
    "releases/release-2",
    "releases/release-2/packages",
    "releases/release-2/packages/adapter-sdk",
    "releases/release-2/packages/adapter-sdk/dist",
    "releases/release-2/packages/adapter-sdk/dist/src",
    "releases/release-2/packages/adapter-sdk/dist/src/bin",
  ]) await chmod(path.join(bundleRoot, directory), 0o755).catch(() => undefined);
}

try {
  await Promise.all([configRoot, path.join(release, "packages/adapter-sdk/dist/src/bin"),
    path.join(release2, "packages/adapter-sdk/dist/src/bin"), pkiRoot, mountSourceRoot, lockRoot, binRoot]
    .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));

  // Deterministic reproduction of a live append: polling ignores only the unfinished tail and
  // observes it after the producer commits the newline, without hiding the prior complete row.
  await writeFile(log, '{"call":1}\n{"call":');
  const liveCommit = new Promise((resolve, reject) => {
    setTimeout(() => {
      writeFile(log, '{"call":1}\n{"call":2}\n').then(resolve, reject);
    }, 40);
  });
  await waitForLogOrExit(
    { exitCode: null, signalCode: null },
    (entries) => entries.some(({ call }) => call === 2),
    2000,
  );
  await liveCommit;

  // Deterministic reproduction of the poll/exit boundary: the first live read sees an
  // uncommitted tail; observing exit commits the final record, which the strict re-read accepts.
  await writeFile(log, '{"call":');
  const commitOnExit = {
    get exitCode() {
      writeFileSync(log, '{"call":2}\n');
      return 0;
    },
    signalCode: null,
  };
  await waitForLogOrExit(commitOnExit, (entries) => entries.some(({ call }) => call === 2), 2000);
  await writeFile(log, '{"call":');
  await assert.rejects(
    waitForLogOrExit({ exitCode: 1, signalCode: null }, () => false, 2000),
    /not committed by a newline/u,
  );
  await clearLog();

  await chmod(configRoot, 0o700);
  await chmod(lockRoot, 0o700);
  for (const harness of ["codex", "claude", "opencode", "hermes", "openclaw", "grok"]) {
    await executable(path.join(release, `packages/adapter-sdk/dist/src/bin/${harness}.js`), "#!/usr/bin/env node\n");
  }
  await executable(path.join(release2, "packages/adapter-sdk/dist/src/bin/openclaw.js"),
    "#!/usr/bin/env node\n// independently pinned release-2\n");
  await immutableFixture();
  bundleDigest = bundleDigestFor(release);
  bundleDigest2 = bundleDigestFor(release2);
  await copyFile(fakeDockerSource, path.join(binRoot, "docker"));
  await chmod(path.join(binRoot, "docker"), 0o755);
  for (const alias of ["atlas", "argos", "iza", "jarvis", "kratos", "zeus", "hades"]) {
    await preparePki(alias, { bearer: alias !== "atlas" });
    await mkdir(path.join(mountSourceRoot, alias), { recursive: true });
  }
  await writeFile(path.join(pkiRoot, "jarvis/openclaw-token"), "FAKE_OPENCLAW_TOKEN\n");
  await chmod(path.join(pkiRoot, "jarvis/openclaw-token"), 0o600);
  await writeConfig("atlas");
  await writeConfig("argos");
  await writeConfig("iza");
  await writeConfig("kratos");
  await writeConfig("zeus");
  await writeConfig("hades");
  await writeConfig("jarvis", [
    "OPENCLAW_TRANSPORT=api",
    "OPENCLAW_API_URL=http://127.0.0.1:18789/v1/chat/completions",
    "OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/openclaw-token",
  ]);

  // Offline fails before any copy.
  await clearLog();

  // Escenarios en modulos hermanos (poda T060-D): mismo flujo secuencial, mismo proceso.
  const ctx = {
      aliasMount, aliasState, bundleDigest, bundleDigest2, bundleDigestFor, bundleRoot, cleanupGroups,
      cleanupProcesses, clearLog, configRoot, dockerState, droppedFromRoot, environment, executable, firstId, imageId,
      lifecycleArgs, lifecycleContainerId, lifecycleEnv, lifecycleGeneration, lockName, makeControl, metadataName,
      mountSourceRoot, pkiRoot, privilegedChildren, privilegedRoots, processAlive, processIdentity, records, release,
      release2, replacementGeneration, runArgs, runSupervisor, runningAsRoot, runtimeHelper, secondGenerationStartedAt,
      secondId, startManaged, stopManaged, stopManagedAtGate, supervisor, temporary, testIdentity, waitForChildExit,
      waitForCommand, waitForFile, waitForLogOrExit, waitForMetadataPhase, waitProcessGone, writeConfig,
  };
  await escenariosA(ctx);
  await escenariosB(ctx);
} finally {
  for (const pgid of cleanupGroups) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
  }
  for (const child of cleanupProcesses) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const child of privilegedChildren) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const root of privilegedRoots) {
    try { spawnSync("sudo", ["-n", "rm", "-rf", root], { stdio: "ignore" }); } catch { /* best effort */ }
  }
  await writableFixture();
  await rm(temporary, { recursive: true, force: true });
}
});
