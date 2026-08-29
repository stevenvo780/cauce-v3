#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile,
} from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supervisor = path.join(ops, "scripts/container-adapter-supervisor.sh");
const runtimeHelper = path.join(ops, "container-runtime/cauce-container-runtime.py");
const fakeDockerSource = path.join(ops, "tests/fake-docker.mjs");
// The lifecycle half of this suite is an UNPRIVILEGED-controller suite: the helper refuses
// to change identity when it is not root, and refuses a root adapter when it is, so a root
// controller can never satisfy the fixture. Release hosts run the gate as root, so drop the
// whole test process to a deterministic non-root identity before any fixture exists. Never
// relax the runtime's own UID/GID 0 rejection to make this pass instead.
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
// kant is the host-branch operator alias (stev/ctrl-infra); atlas/kratos are the codex
// pair co-located on ws-humanizar; iza/jarvis are openclaw agents under /home/claw; argos moved to /home/dev (ctrl-infra);
// zeus is the fleet's only claude-harness alias.
const aliasState = {
  kant: "/var/lib/cauce-v3/aliases/kant", argos: "/home/dev/.local/state/cauce-v3/argos",
  atlas: "/home/dev/.local/state/cauce-v3/atlas", iza: "/home/claw/.openclaw/cauce-v3/iza",
  jarvis: "/home/claw/.openclaw/cauce-v3/jarvis", kratos: "/home/dev/.local/state/cauce-v3/kratos",
  zeus: "/home/dev/.local/state/cauce-v3/zeus",
};
// The real fleet never dedicates a mount to the state dir: the state lives inside a broad
// persistent bind. Physical co-location does not imply that aliases share the same mapped HOME.
const aliasMount = {
  kant: "/var/lib/cauce-v3/aliases", argos: "/home/dev/.local", atlas: "/home/dev/.local",
  iza: "/home/claw/.openclaw", jarvis: "/home/claw/.openclaw", kratos: "/home/dev/.local",
  zeus: "/home/dev/.local",
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
    BUNDLE_RELEASE: "release-1", BUNDLE_SHA256: bundleDigest, PKI_DIR: `${pkiRoot}/${alias}`,
    RELAY_URL: "wss://gateway.example.invalid/v3/ws", EXPECTED_IMAGE_ID: imageId,
    EXPECTED_LABEL_KEY: labelKey, EXPECTED_LABEL_VALUE: labelValue,
    MOUNT_TYPE: "bind", MOUNT_SOURCE: aliasMount[alias],
    MOUNT_NAME: "cauce-state", MOUNT_DESTINATION: aliasState[alias], MOUNT_RW: "1",
    DEFAULT_TIMEOUT_MS: "120000", CAUCE_SEMBRAR_PERFIL: "0",
    ...(alias === "kant" || alias === "atlas" || alias === "kratos" ? { CONFIG_POR_ALIAS: "1" } : {}),
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

async function dockerState(alias, overrides = {}) {
  const statePath = path.join(temporary, `docker-${alias}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const state = {
    containerName: alias === "jarvis" ? "claw"
      : alias === "iza" ? "claw-iza"
      : alias === "atlas" || alias === "kratos" ? "ws-humanizar"
      : alias === "zeus" ? "ws-zeus"
      : "ctrl-infra", // kant, argos
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
      {
        Type: "bind",
        Source: `${mountSourceRoot}/${alias}`,
        Destination: aliasMount[alias],
        RW: true,
      },
      ...(alias === "kant" ? [{
        Type: "bind",
        Source: `${mountSourceRoot}/${alias}-home`,
        Destination: "/home/stev",
        RW: true,
      }, {
        Type: "bind",
        Source: `${mountSourceRoot}/${alias}-workspace`,
        Destination: "/workspace",
        RW: true,
      }] : []),
      ...(alias === "atlas" || alias === "kratos" ? [{
        Type: "bind",
        Source: `${mountSourceRoot}/${alias}-codex`,
        Destination: "/home/dev/.codex",
        RW: true,
      }] : []),
      ...(alias === "zeus" ? [{
        Type: "bind",
        Source: `${mountSourceRoot}/${alias}-claude`,
        Destination: "/home/dev/.claude",
        RW: true,
      }, {
        Type: "bind",
        Source: `${mountSourceRoot}/${alias}-claude-json`,
        Destination: "/home/dev/.claude.json",
        RW: true,
      }] : []),
      ...(alias === "argos" ? [{
        Type: "bind",
        Source: `${mountSourceRoot}/${alias}-workspace`,
        Destination: "/home/dev/clawd",
        RW: true,
      }] : []),
      ...(alias === "iza" || alias === "jarvis" ? [{
        Type: "bind",
        Source: `${mountSourceRoot}/${alias}-workspace`,
        Destination: "/home/claw/clawd",
        RW: true,
      }] : []),
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

// A live JSONL reader may observe the final append after its body is visible but before the
// terminating newline. Only that in-flight tail is retryable; completed malformed records and
// post-exit truncation must remain hard failures so the fixture cannot manufacture a green gate.
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
      // The producer may have committed its final newline between the live read above and the
      // exit observation. Re-read strictly once: accept a completed barrier, but surface an
      // actually truncated or malformed post-exit log instead of converting it into a timeout.
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

// The adapter always runs under a non-root identity, so the fixture must request one
// too. An unprivileged run can only request its own identity; a root run (the release
// gate) must name a real unprivileged account, because child_credentials() rejects 0.
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
// Under root the mkdtemp fixture root is root-owned 0700, so the dropped adapter child
// could neither traverse it nor write its PID files. Hand that single directory to the
// same unprivileged identity: root keeps full access and no mode is widened for anyone.
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
  return [runtimeHelper, action, "--alias", "kant", "--state", state, "--control-dir", control,
    "--container-id", lifecycleContainerId, "--generation", generation, "--term-seconds", "0.2", "--kill-seconds", "1"];
}

function lifecycleEnv(state, control, generation, extra = {}) {
  return {
    ...process.env,
    CAUCE_ALIAS: "kant",
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
  for (const harness of ["codex", "claude", "opencode", "hermes", "openclaw"]) {
    await executable(path.join(release, `packages/adapter-sdk/dist/src/bin/${harness}.js`), "#!/usr/bin/env node\n");
  }
  await executable(path.join(release2, "packages/adapter-sdk/dist/src/bin/openclaw.js"),
    "#!/usr/bin/env node\n// independently pinned release-2\n");
  await immutableFixture();
  bundleDigest = bundleDigestFor(release);
  bundleDigest2 = bundleDigestFor(release2);
  await copyFile(fakeDockerSource, path.join(binRoot, "docker"));
  await chmod(path.join(binRoot, "docker"), 0o755);
  for (const alias of ["kant", "argos", "atlas", "iza", "jarvis", "kratos", "zeus"]) {
    await preparePki(alias, { bearer: alias !== "kant" });
    await mkdir(path.join(mountSourceRoot, alias), { recursive: true });
  }
  await writeFile(path.join(pkiRoot, "jarvis/openclaw-token"), "FAKE_OPENCLAW_TOKEN\n");
  await chmod(path.join(pkiRoot, "jarvis/openclaw-token"), 0o600);
  await writeConfig("kant");
  await writeConfig("argos");
  await writeConfig("atlas");
  await writeConfig("iza");
  await writeConfig("kratos");
  await writeConfig("zeus");
  await writeConfig("jarvis", [
    "OPENCLAW_TRANSPORT=api",
    "OPENCLAW_API_URL=http://127.0.0.1:18789/v1/chat/completions",
    "OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/openclaw-token",
  ]);

  // Offline fails before any copy.
  await clearLog();
  let statePath = await dockerState("kant", { running: false });
  let result = runSupervisor("start", "kant", statePath);
  assert.notEqual(result.status, 0);
  assert.equal((await records()).some(({ argv }) => argv[0] === "cp"), false);

  // The alias pin selects one direct release directory; a symlink alias is never accepted.
  await symlink("release-1", path.join(bundleRoot, "releases/release-link"));
  await writeConfig("kant", [], { BUNDLE_RELEASE: "release-link" });
  await clearLog();
  result = runSupervisor("start", "kant", await dockerState("kant"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-symlink release directory/u);
  assert.equal((await records()).length, 0, "release symlink must fail before Docker");
  await rm(path.join(bundleRoot, "releases/release-link"));
  await writeConfig("kant");

  // Full start: full ID only after discovery, structured mount, digest, safe state helper and path-only secrets.
  await clearLog();
  statePath = await dockerState("kant");
  result = runSupervisor("start", "kant", statePath);
  assert.equal(result.status, 0, result.stderr);
  let calls = await records();
  const firstInspect = calls.find(({ argv }) => argv[0] === "inspect" && argv[2] === "{{.Id}}");
  assert.equal(firstInspect?.target, "ctrl-infra");
  for (const call of calls.filter(({ argv }) => ["inspect", "exec", "cp"].includes(argv[0]) && argv[2] !== "{{.Id}}")) {
    assert.equal(call.target, firstId, `post-discovery Docker target must be full ID: ${JSON.stringify(call.argv)}`);
  }
  assert(calls.some(({ argv }) => argv.includes("prepare-control") && argv.includes("/run/cauce-v3-supervisor")));
  assert(calls.some(({ argv }) => argv.includes("prepare-state") && argv.includes(aliasState.kant)));
  assert(calls.some(({ argv }) => argv.includes("bundle-digest") && argv.includes("/opt/cauce-v3-adapter/kant/releases/release-1")));
  const stopIndex = calls.findIndex(({ argv }) => argv.includes("stop") && argv.includes("--container-id"));
  const bundleCopyIndex = calls.findIndex(({ argv }) => argv[0] === "cp" && argv[1] === `${release}/.`);
  assert(stopIndex >= 0 && stopIndex < bundleCopyIndex);
  // The pre-deploy stop of a prior consumer runs as root against the root-owned control dir.
  const stopCall = calls[stopIndex];
  assert(stopCall.argv.includes("--control-dir") && stopCall.argv.includes("/run/cauce-v3-supervisor/kant"));
  const stopUserIdx = stopCall.argv.indexOf("--user");
  assert(stopUserIdx >= 0 && stopCall.argv[stopUserIdx + 1] === "0", "stop must run as root");
  const final = calls.find(({ argv }) => argv[0] === "exec" && argv.includes("/usr/bin/env") && argv.includes("CAUCE_ALIAS=kant"));
  assert(final?.argv.includes("CAUCE_INSTANCE_ID=systemd-container-kant"));
  assert(final?.argv.includes(`CAUCE_CONTAINER_ID=${firstId}`));
  assert(final?.argv.some((value) => value.startsWith("CAUCE_CONTAINER_GENERATION=")));
  assert.equal(final?.argv.some((value) => value.startsWith("CAUCE_TOKEN_FILE=")), false,
    "mTLS-only kant must not receive a nonexistent bearer token path");
  assert(final?.argv.includes("CAUCE_TLS_CERT_FILE=/opt/cauce-v3-secrets/kant/client.crt"));
  assert(final?.argv.includes("CAUCE_TLS_KEY_FILE=/opt/cauce-v3-secrets/kant/client.key"));
  assert(final?.argv.includes("CAUCE_TLS_CA_FILE=/opt/cauce-v3-secrets/kant/ca.crt"));
  assert.equal(final?.argv.some((value) => value.includes("FAKE_TOKEN_kant") || value.includes("FAKE_KEY_kant")), false);
  assert(final?.argv.includes("--bundle-digest") && final.argv.includes(bundleDigest));
  // The lifecycle controller runs as root and drops the adapter to the mapped non-root UID/GID.
  const finalUserIdx = final.argv.indexOf("--user");
  assert(finalUserIdx >= 0 && final.argv[finalUserIdx + 1] === "0", "controller exec must run as root");
  assert(final.argv.includes("--control-dir") && final.argv.includes("/run/cauce-v3-supervisor/kant"));
  assert(final.argv.includes("--runtime-uid") && final.argv.includes("--runtime-gid"));
  assert(final.argv.includes("CAUCE_CONTROL_DIR=/run/cauce-v3-supervisor/kant"));
  assert(final.argv.includes("CAUCE_DEFAULT_TIMEOUT_MS=86400000"),
    "an omitted DEFAULT_TIMEOUT_MS must use the renewable 24-hour agentic default");
  result = runSupervisor("stop", "kant", statePath);
  assert.equal(result.status, 0, `mTLS-only kant stop must succeed: ${result.stderr}`);
  process.stdout.write("mTLS-only kant: start and stop passed without bearer token\n");

  // Adapter execution defaults to 24 hours, accepts a bounded per-alias override, and rejects
  // every malformed/ambiguous value before Docker. The effective value is explicitly carried
  // through the clean `env -i` boundary so no host environment can silently select another timeout.
  await writeConfig("kant", [], { DEFAULT_TIMEOUT_MS: "480000" });
  await clearLog();
  result = runSupervisor("start", "kant", await dockerState("kant"));
  assert.equal(result.status, 0, `valid DEFAULT_TIMEOUT_MS override must start: ${result.stderr}`);
  const timeoutOverrideFinal = (await records())
    .find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=kant"));
  assert(timeoutOverrideFinal?.argv.includes("CAUCE_DEFAULT_TIMEOUT_MS=480000"),
    "a valid DEFAULT_TIMEOUT_MS override must be exported verbatim");

  for (const [name, extra, override, expected] of [
    ["empty", [], { DEFAULT_TIMEOUT_MS: "" }, /config value is empty: DEFAULT_TIMEOUT_MS/u],
    ["non-numeric", [], { DEFAULT_TIMEOUT_MS: "480000ms" }, /DEFAULT_TIMEOUT_MS must be a decimal integer/u],
    ["below minimum", [], { DEFAULT_TIMEOUT_MS: "59999" }, /DEFAULT_TIMEOUT_MS must be a decimal integer/u],
    ["above maximum", [], { DEFAULT_TIMEOUT_MS: "604800001" }, /DEFAULT_TIMEOUT_MS must be a decimal integer/u],
    ["duplicate", ["DEFAULT_TIMEOUT_MS=420000"], { DEFAULT_TIMEOUT_MS: "480000" },
      /config key is duplicated: DEFAULT_TIMEOUT_MS/u],
  ]) {
    await writeConfig("kant", extra, override);
    await clearLog();
    result = runSupervisor("start", "kant", await dockerState("kant"));
    assert.notEqual(result.status, 0, `${name} DEFAULT_TIMEOUT_MS must fail`);
    assert.match(result.stderr, expected);
    assert.equal((await records()).length, 0, `${name} DEFAULT_TIMEOUT_MS must fail before Docker`);
  }
  await writeConfig("kant");
  process.stdout.write("default timeout: 86400000 default and 480000 override exported; invalid values rejected before Docker\n");

  // Claude containers are upgraded independently.  The version pin therefore belongs to each
  // alias config and must be exact; a source-global version would reject two healthy containers
  // whenever their prebuilt images differ.
  await writeConfig("zeus", [], {}, ["EXPECTED_CLI_VERSION"]);
  await clearLog();
  result = runSupervisor("start", "zeus", await dockerState("zeus"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claude requires EXPECTED_CLI_VERSION/u);
  assert.equal((await records()).length, 0, "missing Claude version must fail before Docker");

  await writeConfig("zeus", [], { EXPECTED_CLI_VERSION: "2.1" });
  await clearLog();
  result = runSupervisor("start", "zeus", await dockerState("zeus"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact semantic version/u);
  assert.equal((await records()).length, 0, "malformed Claude version must fail before Docker");

  await writeConfig("zeus");
  await clearLog();
  result = runSupervisor("start", "zeus", await dockerState("zeus"));
  assert.equal(result.status, 0, result.stderr);
  const claudeVersionProbe = (await records()).find(({ argv }) =>
    argv[0] === "exec" && argv.includes("bash") && argv.some((value) => value.includes("required_ver=\"2.1.220\"")));
  assert(claudeVersionProbe, "Claude version probe must use the alias-specific exact pin");
  process.stdout.write("claude version: alias-specific exact pin required and probed\n");

  // OpenClaw's mandatory persistent path is its workspace, not a CLI-version pin; a plain
  // start with no per-alias config-directory switch must still succeed under cli transport.
  await clearLog();
  result = runSupervisor("start", "argos", await dockerState("argos"));
  assert.equal(result.status, 0, result.stderr);
  const argosFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=argos"));
  assert(argosFinal?.argv.includes("CAUCE_OPENCLAW_WORKSPACE=/home/dev/clawd"));
  assert(argosFinal?.argv.includes("CAUCE_OPENCLAW_TRANSPORT=cli"));
  process.stdout.write("argos openclaw defaults: workspace-only persistence starts under cli transport\n");

  // ---- Shared session: a single conversation in the terminal and in Telegram. ----
  // The switch only exists for claude and codex, only accepts the exact value 1, and when on it
  // must reach the adapter along with a usable TERM: without TERM tmux creates the session with
  // an unknown terminal and the TUI renders broken for the owner.
  await writeConfig("kant", ["SHARED_SESSION=1", "SHARED_SESSION_WORKSPACE=/workspace"]);
  await clearLog();
  result = runSupervisor("start", "kant", await dockerState("kant"));
  assert.equal(result.status, 0, `shared session must start: ${result.stderr}`);
  const sharedFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=kant"));
  assert(sharedFinal?.argv.includes("CAUCE_SHARED_SESSION=1"));
  assert(sharedFinal?.argv.includes("CAUCE_SHARED_SESSION_WORKSPACE=/workspace"));
  assert(sharedFinal?.argv.includes("TERM=xterm-256color"),
    "con sesión compartida el adaptador necesita un TERM utilizable para crear la sesión tmux");

  // Without the switch, the behavior is byte-for-byte the same as always.
  await writeConfig("kant");
  await clearLog();
  result = runSupervisor("start", "kant", await dockerState("kant"));
  assert.equal(result.status, 0, result.stderr);
  const plainFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=kant"));
  assert(!plainFinal?.argv.some((value) => value.startsWith("CAUCE_SHARED_SESSION")),
    "sin SHARED_SESSION no se exporta ninguna variable de sesión compartida");
  assert(!plainFinal?.argv.some((value) => value.startsWith("TERM=")),
    "sin sesión compartida el entorno del adaptador no cambia");

  for (const [name, extra, expected] of [
    ["valor distinto de 1", ["SHARED_SESSION=true"], /SHARED_SESSION must be exactly 1/u],
    ["workspace relativo", ["SHARED_SESSION=1", "SHARED_SESSION_WORKSPACE=workspace"],
      /SHARED_SESSION_WORKSPACE must be a canonical absolute path/u],
    ["workspace sin interruptor", ["SHARED_SESSION_WORKSPACE=/workspace"],
      /SHARED_SESSION_WORKSPACE requires SHARED_SESSION=1/u],
  ]) {
    await writeConfig("kant", extra);
    await clearLog();
    result = runSupervisor("start", "kant", await dockerState("kant"));
    assert.notEqual(result.status, 0, `${name} debe fallar`);
    assert.match(result.stderr, expected);
    assert.equal((await records()).length, 0, `${name} debe fallar antes de tocar Docker`);
  }

  // A harness without a shareable TUI cannot declare the switch: accepting it would leave an
  // alias convinced it is sharing a conversation that does not exist.
  await writeConfig("iza", ["SHARED_SESSION=1"]);
  await clearLog();
  result = runSupervisor("start", "iza", await dockerState("iza"));
  assert.notEqual(result.status, 0, "openclaw no tiene sesión compartida");
  assert.match(result.stderr, /config key is not allowed for openclaw: SHARED_SESSION/u);
  await writeConfig("iza");
  await writeConfig("kant");
  process.stdout.write("shared session: switch exported with TERM for claude/codex, rejected elsewhere and for non-1 values\n");

  // ---- Per-alias configuration: each alias with its OWN configuration directory. ----
  // kratos and atlas run in the SAME container with the same HOME, and their ~/.codex/AGENTS.md is the
  // same INODE: per-file it is impossible to give them distinct identities. CODEX_HOME/CLAUDE_CONFIG_DIR
  // already govern where each CLI looks, so the supervisor can point each alias to its own.
  //
  // In every physical container with more than one alias, the separation is mandatory. Omitting
  // the switch must fail before Docker: never silently fall back to the shared HOME.
  await writeConfig("kant", [], {}, ["CONFIG_POR_ALIAS"]);
  await clearLog();
  result = runSupervisor("start", "kant", await dockerState("kant"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /multi-alias container requires CONFIG_POR_ALIAS=1/u);
  assert.equal((await records()).length, 0, "missing isolation policy must fail before Docker");

  await writeConfig("kant");
  await clearLog();
  result = runSupervisor("start", "kant", await dockerState("kant"));
  assert.equal(result.status, 0, `config por alias debe arrancar: ${result.stderr}`);
  const conInterruptor = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=kant"));
  // kant is codex and its mapped home is /home/stev. The path is DERIVED from the alias: the
  // same one computed by ops/scripts/separar-config-alias.mjs, which copies the files there.
  assert(conInterruptor?.argv.includes("CODEX_HOME=/home/stev/.local/share/cauce-v3/config/kant/.codex"),
    "el interruptor tiene que exportar el directorio derivado del alias");
  assert(!conInterruptor?.argv.some((value) => value.startsWith("CLAUDE_CONFIG_DIR=")),
    "un alias codex no puede recibir además la variable de claude");

  for (const [name, value, expected] of [
    ["valor distinto de 1", "true", /CONFIG_POR_ALIAS must be exactly 1/u],
    ["valor 0", "0", /CONFIG_POR_ALIAS must be exactly 1/u],
  ]) {
    await writeConfig("kant", [], { CONFIG_POR_ALIAS: value });
    await clearLog();
    result = runSupervisor("start", "kant", await dockerState("kant"));
    assert.notEqual(result.status, 0, `${name} debe fallar`);
    assert.match(result.stderr, expected);
    assert.equal((await records()).length, 0, `${name} debe fallar antes de tocar Docker`);
  }

  // A harness that does not read any directory governed by a variable cannot declare the switch:
  // exporting the variable to it would move a directory no one reads and leave someone convinced
  // that alias is already separated.
  await writeConfig("iza", ["CONFIG_POR_ALIAS=1"]);
  await clearLog();
  result = runSupervisor("start", "iza", await dockerState("iza"));
  assert.notEqual(result.status, 0, "openclaw no lee ~/.codex ni ~/.claude");
  assert.match(result.stderr, /config key is not allowed for openclaw: CONFIG_POR_ALIAS/u);
  await writeConfig("iza");

  await writeConfig("jarvis", [
    "OPENCLAW_TRANSPORT=api",
    "OPENCLAW_API_URL=http://127.0.0.1:18789/v1/chat/completions",
    "OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/openclaw-token",
    "CONFIG_POR_ALIAS=1",
  ]);
  await clearLog();
  result = runSupervisor("start", "jarvis", await dockerState("jarvis"));
  assert.notEqual(result.status, 0, "openclaw no lee ~/.codex ni ~/.claude");
  assert.match(result.stderr, /config key is not allowed for openclaw: CONFIG_POR_ALIAS/u);
  await writeConfig("jarvis", [
    "OPENCLAW_TRANSPORT=api",
    "OPENCLAW_API_URL=http://127.0.0.1:18789/v1/chat/completions",
    "OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/openclaw-token",
  ]);
  await writeConfig("kant");
  process.stdout.write("config por alias: mandatory for multi-alias containers, derived per alias, rejected outside claude/codex\n");

  // ---- Bundle layout regression guard: mini-monorepo vs legacy root layout. ----
  // The real production bundle ships adapters at packages/adapter-sdk/dist/src/bin/<harness>.js;
  // the supervisor must resolve exactly that path. Positive: the standard fixture uses that
  // layout and validate_bundle accepts it (a full start succeeds).
  await clearLog();
  assert.equal(runSupervisor("start", "kant", await dockerState("kant")).status, 0,
    "packages/adapter-sdk/dist/src/bin layout must pass validate_bundle");
  process.stdout.write("layout guard: packages/adapter-sdk/dist/src/bin bundle accepted by validate_bundle\n");
  // Negative: a bundle carrying only the legacy root layout dist/src/bin/<harness>.js (WITHOUT the
  // packages/adapter-sdk prefix) must be rejected as the missing executable adapter, before any copy.
  const legacyRoot = path.join(temporary, "bundle-legacy-layout");
  const legacyRelease = path.join(legacyRoot, "releases/release-legacy");
  await mkdir(path.join(legacyRelease, "dist/src/bin"), { recursive: true, mode: 0o700 });
  await executable(path.join(legacyRelease, "dist/src/bin/codex.js"), "#!/usr/bin/env node\n");
  for (const directory of [
    "releases/release-legacy/dist/src/bin",
    "releases/release-legacy/dist/src",
    "releases/release-legacy/dist",
    "releases/release-legacy",
  ]) await chmod(path.join(legacyRoot, directory), 0o555);
  const legacyDigest = bundleDigestFor(legacyRelease);
  await clearLog();
  const legacyConfig = {
    BUNDLE_RELEASE: "release-legacy",
    BUNDLE_SHA256: legacyDigest,
    PKI_DIR: `${pkiRoot}/kant`,
    RELAY_URL: "wss://gateway.example.invalid/v3/ws",
    EXPECTED_IMAGE_ID: imageId,
    CAUCE_SEMBRAR_PERFIL: "1",
    CONFIG_POR_ALIAS: "1",
  };
  await writeFile(path.join(configRoot, "kant.env"),
    `${Object.entries(legacyConfig).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  await chmod(path.join(configRoot, "kant.env"), 0o600);
  const legacyEnv = { ...environment(await dockerState("kant")), CAUCE_CONTAINER_BUNDLE_ROOT: legacyRoot };
  result = spawnSync(supervisor, ["start", "kant"], { encoding: "utf8", env: legacyEnv });
  assert.notEqual(result.status, 0, "legacy dist/src/bin layout (no packages/adapter-sdk) must fail validate_bundle");
  assert.match(result.stderr, /bundle does not contain the assigned executable adapter/u);
  assert.equal((await records()).some(({ argv }) => argv[0] === "cp"), false,
    "a layout-rejected bundle must fail before any container copy");
  await writeConfig("kant");
  // Restore write bits on the immutable legacy fixture so the final recursive cleanup can remove it.
  for (const directory of [
    "releases/release-legacy",
    "releases/release-legacy/dist",
    "releases/release-legacy/dist/src",
    "releases/release-legacy/dist/src/bin",
  ]) await chmod(path.join(legacyRoot, directory), 0o755).catch(() => undefined);
  process.stdout.write("layout guard: legacy dist/src/bin bundle rejected by validate_bundle before any copy\n");

  // OpenClaw receives only a token-file path, never the bearer token itself.
  await clearLog();
  statePath = await dockerState("jarvis");
  result = runSupervisor("start", "jarvis", statePath);
  assert.equal(result.status, 0, result.stderr);
  calls = await records();
  const jarvisFinal = calls.find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=jarvis"));
  assert(jarvisFinal?.argv.includes("CAUCE_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/token"),
    "bearer-enabled alias must export its copied CAUCE_TOKEN_FILE path");
  assert(jarvisFinal?.argv.includes("CAUCE_OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/openclaw-token"));
  assert(jarvisFinal?.argv.includes("CAUCE_DEFAULT_TIMEOUT_MS=86400000"),
    "OpenClaw agentic work defaults to 24 hours while its central claim is renewed");
  assert.equal(jarvisFinal?.argv.some((value) => value.includes("FAKE_OPENCLAW_TOKEN")), false);

  // OpenClaw CLI transport with a GLOBAL dist dir: openclaw can be installed system-wide, so
  // OPENCLAW_DIST_DIR need not live below the mapped user home. A canonical absolute path such as
  // /usr/lib/node_modules/openclaw/dist is accepted and exported verbatim. CLI transport also
  // requires the PKI directory to carry no openclaw-token, so it is removed for this scenario.
  await rm(path.join(pkiRoot, "jarvis/openclaw-token"));
  await writeConfig("jarvis", ["OPENCLAW_TRANSPORT=cli", "OPENCLAW_DIST_DIR=/usr/lib/node_modules/openclaw/dist"]);
  await clearLog();
  result = runSupervisor("start", "jarvis", await dockerState("jarvis"));
  assert.equal(result.status, 0, `global OPENCLAW_DIST_DIR (cli) must start: ${result.stderr}`);
  const jarvisCliFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=jarvis"));
  assert(jarvisCliFinal?.argv.includes("CAUCE_OPENCLAW_TRANSPORT=cli"));
  assert(jarvisCliFinal?.argv.includes("CAUCE_OPENCLAW_DIST_DIR=/usr/lib/node_modules/openclaw/dist"),
    "a global (non-home) OPENCLAW_DIST_DIR must be accepted and exported verbatim");
  // Restore the jarvis API fixture (token file + config) for a pristine post-test state.
  await writeFile(path.join(pkiRoot, "jarvis/openclaw-token"), "FAKE_OPENCLAW_TOKEN\n");
  await chmod(path.join(pkiRoot, "jarvis/openclaw-token"), 0o600);
  await writeConfig("jarvis", [
    "OPENCLAW_TRANSPORT=api",
    "OPENCLAW_API_URL=http://127.0.0.1:18789/v1/chat/completions",
    "OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/openclaw-token",
  ]);
  process.stdout.write("openclaw dist dir: global /usr/lib/node_modules/openclaw/dist accepted under cli transport\n");

  await clearLog();
  statePath = await dockerState("iza");
  result = runSupervisor("start", "iza", statePath);
  assert.equal(result.status, 0, result.stderr);
  const izaFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=iza"));
  assert(izaFinal?.argv.includes("CAUCE_OPENCLAW_WORKSPACE=/home/claw/clawd"));
  assert(izaFinal?.argv.includes("CAUCE_OPENCLAW_TRANSPORT=cli"));

  // Each alias consumes its exact BUNDLE_RELEASE pin. A canary pin for iza must copy and
  // execute release-2 directly, without consulting or changing a shared host `current` pointer.
  await writeConfig("iza", [], {
    BUNDLE_RELEASE: "release-2",
    BUNDLE_SHA256: bundleDigest2,
  });
  await clearLog();
  result = runSupervisor("start", "iza", await dockerState("iza", { bundleDigest: bundleDigest2 }));
  assert.equal(result.status, 0, `independently pinned release-2 must start: ${result.stderr}`);
  calls = await records();
  assert(calls.some(({ argv }) => argv[0] === "cp" && argv[1] === `${release2}/.`),
    "supervisor must copy the alias-pinned release directory");
  assert.equal(calls.some(({ argv }) => argv[0] === "cp" && argv[1] === `${release}/.`), false,
    "supervisor must not fall back to another alias release");
  const pinnedIzaFinal = calls.find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=iza"));
  assert(pinnedIzaFinal?.argv.includes("/opt/cauce-v3-adapter/iza/releases/release-2"));
  assert(pinnedIzaFinal?.argv.includes(bundleDigest2));
  assert.equal(calls.some(({ argv }) => argv.includes("ln") && argv.some((value) => value.includes("current"))), false,
    "supervisor must not create a mutable current symlink");
  await writeConfig("iza");
  process.stdout.write("per-alias release pin: iza release-2 selected directly without a current symlink\n");

  // Image is mandatory; the label and MOUNT_* keys are optional reinforcement. When declared,
  // each must match. The persistent mount is the bind/volume that CONTAINS the state dir, so
  // an ephemeral/read-write-off ancestor or a missing ancestor fails before any PKI copy.
  for (const [name, override, expected] of [
    ["image", { imageId: `sha256:${"f".repeat(64)}` }, /image ID/u],
    ["label", { labelValue: "wrong" }, /label/u],
    ["tmpfs", { mounts: [{ Type: "tmpfs", Source: "", Destination: aliasMount.kant, RW: true }] }, /mount/u],
    ["source", { mounts: [{ Type: "bind", Source: "/wrong", Destination: aliasMount.kant, RW: true }] }, /mount/u],
    ["readonly", { mounts: [{ Type: "bind", Source: `${mountSourceRoot}/kant`, Destination: aliasMount.kant, RW: false }] }, /mount/u],
    ["no-ancestor", { mounts: [{ Type: "bind", Source: `${mountSourceRoot}/kant`, Destination: "/unrelated/mount", RW: true }] }, /mount/u],
  ]) {
    await clearLog();
    statePath = await dockerState("kant", override);
    result = runSupervisor("start", "kant", statePath);
    assert.notEqual(result.status, 0, `${name} policy must fail`);
    assert.match(result.stderr, expected);
    assert.equal((await records()).some(({ argv }) => argv[0] === "cp"), false);
  }

  // A persistent state mount does not make an ephemeral harness home acceptable.  Codex
  // auth/config live on a separate mounted home and must survive the same container
  // recreation as the state.
  await clearLog();
  statePath = await dockerState("kant", { mounts: [{
    Type: "bind", Source: `${mountSourceRoot}/kant`, Destination: aliasMount.kant, RW: true,
  }] });
  result = runSupervisor("start", "kant", statePath);
  assert.notEqual(result.status, 0, "state persistence without persistent Codex auth/config must fail");
  assert.match(result.stderr, /required harness path/u);
  assert.equal((await records()).some(({ mutating }) => mutating), false,
    "harness persistence must fail before any Docker mutation");

  // The on-disk isolated layout is rechecked by start/check, not trusted merely because the env
  // points to its directory.  The fake models a broken/missing identity or a link redirected away
  // from the authorized single source.
  await clearLog();
  result = runSupervisor("start", "kant", await dockerState("kant", { isolatedConfigOk: false }));
  assert.notEqual(result.status, 0, "a broken isolated config must fail closed");
  assert.match(result.stderr, /isolated harness configuration verification failed/u);
  assert.equal((await records()).some(({ mutating }) => mutating), false,
    "isolated config verification must precede helper/state/bundle/PKI mutation");

  // A declared volume-name that differs from the discovered mount fails before any copy.
  await writeConfig("kant", [], {
    MOUNT_TYPE: "volume",
    MOUNT_SOURCE: `${mountSourceRoot}/kant-volume`,
    MOUNT_NAME: "expected-kant-volume",
  });
  await clearLog();
  statePath = await dockerState("kant", { mounts: [{
    Type: "volume",
    Source: `${mountSourceRoot}/kant-volume`,
    Name: "wrong-volume-name",
    Destination: aliasMount.kant,
    RW: true,
  }] });
  result = runSupervisor("start", "kant", statePath);
  assert.notEqual(result.status, 0);
  assert.equal((await records()).some(({ argv }) => argv[0] === "cp"), false);
  await writeConfig("kant");

  // `check` is a complete read-only preflight: it revalidates host PKI before accepting
  // lifecycle metadata.  Missing PKI cannot be hidden behind a healthy old adapter process.
  await rm(path.join(pkiRoot, "kant/ca.crt"));
  await clearLog();
  result = runSupervisor("check", "kant", await dockerState("kant"));
  assert.notEqual(result.status, 0, "check must reject missing PKI");
  assert.equal((await records()).some(({ argv }) => argv.includes("check")), false,
    "lifecycle check must not run after PKI preflight failure");
  await writeFile(path.join(pkiRoot, "kant/ca.crt"), "fake-ca\n");
  await chmod(path.join(pkiRoot, "kant/ca.crt"), 0o600);

  await clearLog();
  result = runSupervisor("check", "kant", await dockerState("kant"));
  assert.equal(result.status, 0, `full check must pass: ${result.stderr}`);
  process.stdout.write("complete check: PKI precedes lifecycle metadata\n");

  // Optional-key omission still starts. First: image ID correct, NO label declared, so the
  // label check is skipped even though the container reports an unverified label value.
  await clearLog();
  await writeConfig("kant", [], {}, ["EXPECTED_LABEL_KEY", "EXPECTED_LABEL_VALUE"]);
  assert.equal(runSupervisor("start", "kant", await dockerState("kant", { labelValue: "unverified" })).status, 0,
    "an image-verified container with no declared label must start");
  // Second: no MOUNT_* declared at all -- the supervisor discovers the ancestor bind itself
  // and bounds safe state creation to it.
  await clearLog();
  await writeConfig("kant", [], {}, ["EXPECTED_LABEL_KEY", "EXPECTED_LABEL_VALUE", "MOUNT_TYPE", "MOUNT_SOURCE", "MOUNT_DESTINATION", "MOUNT_RW"]);
  result = runSupervisor("start", "kant", await dockerState("kant"));
  assert.equal(result.status, 0, `discovery-only config must start: ${result.stderr}`);
  assert((await records()).some(({ argv }) => argv.includes("prepare-state") && argv.includes(aliasMount.kant) && argv.includes(aliasState.kant)),
    "prepare-state must bound creation to the discovered ancestor mount, not the state dir");
  await writeConfig("kant");

  // Alias/path/config injection remains fail-closed before Docker.
  await clearLog();
  result = runSupervisor("start", "kant;bad", await dockerState("kant"));
  assert.notEqual(result.status, 0);
  assert.equal((await records()).length, 0);
  await writeFile(path.join(configRoot, "kant.env"), "BUNDLE_RELEASE=../escape\nEVIL=$(touch /tmp/pwned)\n");
  await chmod(path.join(configRoot, "kant.env"), 0o600);
  await clearLog();
  result = runSupervisor("start", "kant", await dockerState("kant"));
  assert.notEqual(result.status, 0);
  assert.equal((await records()).length, 0);
  await writeConfig("kant");

  // atlas and kratos share ONE persistent bind (/home/dev/.local, one Source) in ws-humanizar.
  // Each alias state dir is a disjoint subtree, so both discover the same mount without
  // colliding: disjoint /opt trees and disjoint prepared state dirs prove the isolation.
  await clearLog();
  const sharedSource = `${mountSourceRoot}/ws-humanizar-dot-local`;
  const sharedBind = [
    { Type: "bind", Source: sharedSource, Destination: "/home/dev/.local", RW: true },
    { Type: "bind", Source: `${mountSourceRoot}/ws-humanizar-codex`, Destination: "/home/dev/.codex", RW: true },
    { Type: "bind", Source: `${mountSourceRoot}/ws-humanizar-claude`, Destination: "/home/dev/.claude", RW: true },
    { Type: "bind", Source: `${mountSourceRoot}/ws-humanizar-claude-json`, Destination: "/home/dev/.claude.json", RW: true },
  ];
  await writeConfig("atlas", [], { MOUNT_SOURCE: sharedSource, MOUNT_DESTINATION: aliasMount.atlas });
  await writeConfig("kratos", [], { MOUNT_SOURCE: sharedSource, MOUNT_DESTINATION: aliasMount.kratos });
  let arranqueCompartido = runSupervisor("start", "atlas", await dockerState("atlas", { mounts: sharedBind }));
  assert.equal(arranqueCompartido.status, 0, `atlas compartiendo .local: ${arranqueCompartido.stderr}`);
  arranqueCompartido = runSupervisor("start", "kratos", await dockerState("kratos", { mounts: sharedBind }));
  assert.equal(arranqueCompartido.status, 0, `kratos compartiendo .local: ${arranqueCompartido.stderr}`);
  calls = await records();
  assert(calls.some(({ argv }) => argv.some((value) => value.includes("/opt/cauce-v3-adapter/atlas/"))));
  assert(calls.some(({ argv }) => argv.some((value) => value.includes("/opt/cauce-v3-adapter/kratos/"))));
  assert(calls.some(({ argv }) => argv.includes("prepare-state") && argv.includes(aliasState.atlas)));
  assert(calls.some(({ argv }) => argv.includes("prepare-state") && argv.includes(aliasState.kratos)));
  assert.equal(calls.some(({ argv }) => argv.includes("rm") && argv.includes("/opt/cauce-v3-adapter")), false);
  await writeConfig("atlas");
  await writeConfig("kratos");

  // Recreate with same declared mount relaunches on the new ID and retains state/instance identity.
  await clearLog();
  assert.equal(runSupervisor("start", "kant", await dockerState("kant", { currentId: firstId })).status, 0);
  assert.equal(runSupervisor("start", "kant", await dockerState("kant", { currentId: secondId, replacementId: firstId, startedAt: secondGenerationStartedAt })).status, 0);
  calls = await records();
  const relaunches = calls.filter(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=kant"));
  assert.equal(relaunches.length, 2);
  assert(relaunches[0].argv.includes(`CAUCE_CONTAINER_ID=${firstId}`));
  assert(relaunches[1].argv.includes(`CAUCE_CONTAINER_ID=${secondId}`));
  assert(relaunches.every(({ argv }) => argv.includes(`CAUCE_STATE_DIR=${aliasState.kant}`) && argv.includes("CAUCE_INSTANCE_ID=systemd-container-kant")));

  // Every mutating Docker step aborts a recreate race without applying to the replacement ID.
  await clearLog();
  statePath = await dockerState("kant");
  assert.equal(runSupervisor("start", "kant", statePath).status, 0);
  const baseline = await records();
  const mutatingCalls = baseline.filter(({ mutating, applied, target }) => mutating && applied && target === firstId).map(({ call }) => call);
  assert(mutatingCalls.length > 10);
  for (const raceAt of mutatingCalls) {
    await clearLog();
    statePath = await dockerState("kant", { raceAt });
    result = runSupervisor("start", "kant", statePath);
    assert.notEqual(result.status, 0, `recreate race at Docker call ${raceAt} must abort`);
    const raced = await records();
    assert.equal(raced.some(({ mutating, applied, target }) => mutating && applied && target === secondId), false,
      `race at ${raceAt} touched replacement generation`);
  }
  const guardedMutationCalls = baseline
    .filter(({ mutating, applied, target, argv }) => mutating && applied && target === firstId && argv.includes("guard-exec"))
    .map(({ call }) => call);
  assert(guardedMutationCalls.length > 10);
  for (const restartRaceAt of guardedMutationCalls) {
    await clearLog();
    statePath = await dockerState("kant", { restartRaceAt });
    result = runSupervisor("start", "kant", statePath);
    assert.notEqual(result.status, 0, `same-ID restart race at guarded call ${restartRaceAt} must abort`);
    const raced = await records();
    assert.equal(raced.some(({ call, mutating, applied }) => call === restartRaceAt && mutating && applied), false,
      `same-ID restart at ${restartRaceAt} passed the in-container generation guard`);
  }

  // Host flock rejects a duplicate supervisor before its first Docker operation can run.
  await clearLog();
  const flockGate = path.join(temporary, `flock-owner-${Math.random().toString(16).slice(2)}.gate`);
  statePath = await dockerState("kant", { startGate: flockGate });
  const firstOwner = spawn(supervisor, ["start", "kant"], { stdio: "ignore", env: environment(statePath) });
  await waitForLogOrExit(firstOwner,
    (entries) => entries.some(({ call, argv }) => call === 1 && argv[0] === "inspect"));
  result = runSupervisor("start", "kant", statePath);
  assert.equal(result.status, 73);
  await writeFile(flockGate, "release\n");
  const firstOwnerExit = await waitForChildExit(firstOwner);
  assert.equal(firstOwnerExit.status, 0,
    `the explicit flock test owner must exit cleanly after its barrier: ${JSON.stringify(firstOwnerExit)}`);

  // Root state preparation never follows a leaf or parent symlink and leaves targets untouched.
  const safeRoot = path.join(temporary, "safe-state");
  const safeMount = path.join(safeRoot, "mount");
  const target = path.join(safeRoot, "target");
  await mkdir(safeMount, { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o755 });
  const originalMode = (await stat(target)).mode & 0o777;
  const leaf = path.join(safeMount, "leaf");
  await symlink(target, leaf);
  result = spawnSync("python3", [runtimeHelper, "prepare-state", "--mount", leaf, "--state", leaf,
    "--uid", String(process.getuid()), "--gid", String(process.getgid())], { encoding: "utf8" });
  assert.equal(result.status, 78);
  assert.equal((await stat(target)).mode & 0o777, originalMode);
  const parentLink = path.join(safeMount, "parent");
  await symlink(target, parentLink);
  result = spawnSync("python3", [runtimeHelper, "prepare-state", "--mount", safeMount,
    "--state", path.join(parentLink, "child"), "--uid", String(process.getuid()), "--gid", String(process.getgid())], { encoding: "utf8" });
  assert.equal(result.status, 78);
  assert.equal((await stat(target)).mode & 0o777, originalMode);

  // Real process-group stop kills a TERM-resistant descendant but not an unrelated process.
  const lifecycleBundle = path.join(temporary, "lifecycle-fixtures");
  await mkdir(lifecycleBundle, { mode: 0o755 });
  const resistant = path.join(lifecycleBundle, "resistant.py");
  const childPidFile = path.join(temporary, "resistant-child.pid");
  await executable(resistant, `#!/usr/bin/env python3
import signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c', "import os,signal,time; os.setsid(); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"])
open(sys.argv[1], 'w', encoding='utf-8').write(str(child.pid))
time.sleep(60)
`);
  const simple = path.join(lifecycleBundle, "simple.py");
  await executable(simple, "#!/usr/bin/env python3\nimport time\ntime.sleep(60)\n");
  const earlyExit = path.join(lifecycleBundle, "early-exit.py");
  await executable(earlyExit, "#!/usr/bin/env python3\nimport sys,time\ntime.sleep(0.03)\nsys.exit(78)\n");
  const invalidIdentity = path.join(lifecycleBundle, "invalid-identity.py");
  await executable(invalidIdentity,
    "#!/usr/bin/env python3\nimport os\nos.execv('/bin/sleep', ['/bin/sleep', '60'])\n");
  const reexec = path.join(lifecycleBundle, "reexec.py");
  await executable(reexec, `#!/usr/bin/env python3
import os, sys, time
while not os.path.exists(sys.argv[1]):
    time.sleep(0.01)
os.execv('/bin/sleep', ['/bin/sleep', '60'])
`);
  const atomicMover = path.join(lifecycleBundle, "atomic-mover.py");
  await executable(atomicMover, `#!/usr/bin/env python3
import os, subprocess, sys, time
move, moved, pidfile = sys.argv[1:]
code = """import os,sys,time
move,moved=sys.argv[1:]
while not os.path.exists(move): time.sleep(0.01)
os.setsid()
with open(moved, 'w', encoding='utf-8') as stream: stream.write(str(os.getpid()))
os.execve('/bin/sleep', ['/bin/sleep', '60'], {})
"""
child = subprocess.Popen([sys.executable, '-c', code, move, moved])
with open(pidfile, 'w', encoding='utf-8') as stream: stream.write(str(child.pid))
time.sleep(60)
`);
  const lifecycleState = path.join(temporary, "lifecycle-state");
  const lifecycleControl = await makeControl("lifecycle");
  await mkdir(lifecycleState, { mode: 0o700 });

  // A child may fail transiently after successful exec but before the controller
  // samples two stable identity snapshots. Propagate its outcome through the
  // restartable adapter code instead of stranding systemd on permanent exit 78.
  const earlyExitState = path.join(temporary, "early-exit-state");
  const earlyExitControl = await makeControl("early-exit");
  await mkdir(earlyExitState, { mode: 0o700 });
  result = spawnSync("python3", runArgs(earlyExitState, earlyExitControl, earlyExit), {
    encoding: "utf8",
    env: lifecycleEnv(earlyExitState, earlyExitControl, lifecycleGeneration),
  });
  assert.equal(result.status, 70,
    `reserved early adapter exit must remap to the restartable code: ${result.stdout} ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /did not establish its executable identity/u);
  await assert.rejects(lstat(path.join(earlyExitControl, metadataName)),
    "early child exit must clean starting metadata before systemd retries");

  // A live process that replaced the requested command before identity was
  // established is still a permanent mismatch and must not enter a retry loop.
  const invalidIdentityState = path.join(temporary, "invalid-identity-state");
  const invalidIdentityControl = await makeControl("invalid-identity");
  await mkdir(invalidIdentityState, { mode: 0o700 });
  result = spawnSync("python3", runArgs(invalidIdentityState, invalidIdentityControl, invalidIdentity), {
    encoding: "utf8",
    env: lifecycleEnv(invalidIdentityState, invalidIdentityControl, lifecycleGeneration),
    timeout: 10_000,
  });
  assert.equal(result.status, 78,
    `live invalid executable identity must remain permanent: ${result.stdout} ${result.stderr}`);
  assert.match(result.stderr, /did not establish its executable identity/u);
  process.stdout.write("early child exit: restartable 70; live invalid identity: permanent 78\n");

  const unrelated = spawn("/bin/sleep", ["60"], { stdio: "ignore", detached: true });
  cleanupGroups.push(unrelated.pid);
  let managed = await startManaged(lifecycleState, lifecycleControl, resistant, [childPidFile]);
  await waitForFile(childPidFile);
  const descendantPid = Number((await readFile(childPidFile, "utf8")).trim());
  const leaderPid = managed.document.pid;
  assert.equal(managed.document.pid, managed.document.pgid);
  assert.equal(managed.document.pid, managed.document.sid);
  // The metadata and lock live in the control dir, never in the runtime-owned state dir.
  await lstat(path.join(lifecycleControl, metadataName));
  await lstat(path.join(lifecycleControl, lockName));
  assert.equal(await stat(lifecycleState).then((s) => s.isDirectory()), true);
  await assert.rejects(lstat(path.join(lifecycleState, metadataName)), "metadata must not live in the state dir");
  result = stopManaged(lifecycleState, lifecycleControl);
  assert.equal(result.status, 0, result.stderr);
  await waitProcessGone(leaderPid);
  await waitProcessGone(descendantPid);
  // The controller exits and releases the control lock on its own after a running-phase stop.
  await waitProcessGone(managed.child.pid);
  assert.equal(processAlive(unrelated.pid), true);
  result = spawnSync("python3", lifecycleArgs("stopped", lifecycleState, lifecycleControl), { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  process.kill(-unrelated.pid, "SIGTERM");

  // Non-lineage metadata mismatches are preserved and never signalled. An
  // executable-only mismatch is different: the proven same lineage must be stopped.
  async function tamperCase(mutator, { terminate = false } = {}) {
    const state = path.join(temporary, `tamper-${Math.random().toString(16).slice(2)}`);
    const control = await makeControl("tamper");
    await mkdir(state, { mode: 0o700 });
    const running = await startManaged(state, control, simple);
    const original = running.document;
    const tampered = mutator(JSON.parse(JSON.stringify(original)));
    await writeFile(running.metadata, typeof tampered === "string" ? tampered : `${JSON.stringify(tampered)}\n`);
    const before = await readFile(running.metadata, "utf8");
    const stopped = stopManaged(state, control);
    if (terminate) {
      assert.equal(stopped.status, 0, stopped.stderr);
      await waitProcessGone(original.pid);
      await assert.rejects(lstat(running.metadata), "successful stop must remove lifecycle metadata");
    } else {
      assert.equal(stopped.status, 78);
      assert.equal(processAlive(original.pid), true);
      assert.equal(await readFile(running.metadata, "utf8"), before);
      await lstat(path.join(control, lockName));
      await writeFile(running.metadata, `${JSON.stringify(original)}\n`);
      assert.equal(stopManaged(state, control).status, 0);
      await waitProcessGone(original.pid);
    }
  }
  await tamperCase((value) => ({ ...value, alias: "argos" }));
  await tamperCase((value) => ({ ...value, starttime: value.starttime + 1 }));
  const unrelatedTamper = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  cleanupProcesses.push(unrelatedTamper);
  await tamperCase((value) => ({ ...value, pid: unrelatedTamper.pid }));
  assert.equal(processAlive(unrelatedTamper.pid), true);
  unrelatedTamper.kill("SIGTERM");
  await tamperCase(
    (value) => ({ ...value, executable: { ...value.executable, sha256: `sha256:${"0".repeat(64)}` } }),
    { terminate: true },
  );
  process.stdout.write("same-lineage executable-only mismatch: terminated\n");
  await tamperCase((value) => ({ ...value, runtimeUid: value.runtimeUid + 100000 }));
  await tamperCase((value) => `{"pid":${value.pid}}\n`);

  // A real execve keeps PID/starttime/PGID/SID/UID/env but changes executable
  // identity. It must not evade stop, and stop must not return before it is gone.
  const reexecState = path.join(temporary, "same-lineage-reexec-state");
  const reexecControl = await makeControl("same-lineage-reexec");
  const reexecMarker = path.join(temporary, "same-lineage-reexec.go");
  await mkdir(reexecState, { mode: 0o700 });
  const reexecManaged = await startManaged(reexecState, reexecControl, reexec, [reexecMarker]);
  await writeFile(reexecMarker, "go\n");
  await waitForCommand(reexecManaged.document.pid, "/bin/sleep");
  const afterExec = processIdentity(reexecManaged.document.pid);
  assert.equal(afterExec.starttime, reexecManaged.document.starttime);
  assert.equal(afterExec.pgid, reexecManaged.document.pgid);
  assert.equal(afterExec.sid, reexecManaged.document.sid);
  result = stopManaged(reexecState, reexecControl);
  assert.equal(result.status, 0, `same-lineage re-exec must be terminated: ${result.stderr}`);
  await waitProcessGone(reexecManaged.document.pid);
  process.stdout.write("same-lineage real re-exec: terminated and gone before stop returned\n");

  // Pin the complete observed target set before the first signal. While stop is
  // gated, kill the controller and move a child to a new session with an empty
  // environment. The pre-opened pidfd must still target that exact child.
  const atomicState = path.join(temporary, "atomic-stop-state");
  const atomicControl = await makeControl("atomic-stop");
  const atomicMove = path.join(temporary, "atomic-stop.move");
  const atomicMoved = path.join(temporary, "atomic-stop.moved");
  const atomicPidFile = path.join(temporary, "atomic-stop-child.pid");
  const atomicGate = path.join(temporary, "atomic-stop.pinned");
  const atomicRelease = path.join(temporary, "atomic-stop.release");
  await mkdir(atomicState, { mode: 0o700 });
  const atomicManaged = await startManaged(atomicState, atomicControl, atomicMover, [atomicMove, atomicMoved, atomicPidFile]);
  await waitForFile(atomicPidFile);
  const atomicChildPid = Number((await readFile(atomicPidFile, "utf8")).trim());
  const gatedAtomicStop = await stopManagedAtGate(atomicState, atomicControl, atomicGate, atomicRelease);
  atomicManaged.child.kill("SIGKILL");
  await waitProcessGone(atomicManaged.child.pid);
  await writeFile(atomicMove, "move\n");
  await waitForFile(atomicMoved);
  assert.notEqual(processIdentity(atomicChildPid).pgid, atomicManaged.document.pgid,
    "the child moved out of the metadata process group during the stop barrier");
  await writeFile(atomicRelease, "release\n");
  const atomicStop = await gatedAtomicStop.completed;
  assert.equal(atomicStop.status, 0, `pidfd-pinned stop must succeed: ${atomicStop.stderr}`);
  await waitProcessGone(atomicManaged.document.pid);
  await waitProcessGone(atomicChildPid);
  process.stdout.write("atomic stop barrier: moved identity-cleared child terminated through pinned pidfd\n");

  // ---- PGID reuse AFTER the leader is reaped: an alien in the freed process group
  // must NEVER be signalled. The gated stop pins the leader (and controller) BEFORE the
  // alien exists. The controller is then removed so its own run-path teardown never runs;
  // an env-scrubbed alien joins the leader's process group; the leader is reaped, freeing
  // its PID/PGID number. On release, a numeric PGID re-sweep would catch the alien -- the
  // fix forbids re-enumerating a PGID once its pinned leader has exited, so the alien lives.
  const pgidLeader = path.join(lifecycleBundle, "pgid-leader.py");
  await executable(pgidLeader, `#!/usr/bin/env python3
import os, subprocess, sys, time
trigger, npidfile = sys.argv[1:3]
while not os.path.exists(trigger):
    time.sleep(0.01)
# The alien inherits our PGID/SID (== leader PID == recorded metadata PGID) but carries
# NO CAUCE_* identity, so it is a true outsider that merely occupies the reused group.
alien = subprocess.Popen(['/bin/sleep', '60'], env={'PATH': '/usr/bin:/bin'})
with open(npidfile, 'w', encoding='utf-8') as stream:
    stream.write(str(alien.pid))
time.sleep(60)
`);
  const reuseState = path.join(temporary, "pgid-reuse-state");
  const reuseControl = await makeControl("pgid-reuse");
  const reuseTrigger = path.join(temporary, "pgid-reuse.trigger");
  const reuseNpid = path.join(temporary, "pgid-reuse.npid");
  const reuseGate = path.join(temporary, "pgid-reuse.pinned");
  const reuseRelease = path.join(temporary, "pgid-reuse.release");
  await mkdir(reuseState, { mode: 0o700 });
  const reuseManaged = await startManaged(reuseState, reuseControl, pgidLeader, [reuseTrigger, reuseNpid]);
  const reuseLeader = reuseManaged.document.pid;
  // Pin the leader (and controller) while the alien does not yet exist.
  const gatedReuse = await stopManagedAtGate(reuseState, reuseControl, reuseGate, reuseRelease);
  // Remove the controller so only the already-pinned external stop is in play; the
  // starting/running metadata stays intact because a SIGKILL runs no cleanup.
  reuseManaged.child.kill("SIGKILL");
  await waitProcessGone(reuseManaged.child.pid);
  // The alien joins the leader's process group AFTER pinning, so it is unpinned.
  await writeFile(reuseTrigger, "go\n");
  await waitForFile(reuseNpid);
  const alienPid = Number((await readFile(reuseNpid, "utf8")).trim());
  cleanupProcesses.push({ kill(sig) { try { process.kill(alienPid, sig); } catch { /* gone */ } } });
  assert.equal(processIdentity(alienPid).pgid, reuseManaged.document.pgid,
    "the alien occupies the reaped leader's numeric process group");
  // Reap the leader: its PID/PGID number is now reusable, exactly the dangerous window.
  process.kill(reuseLeader, "SIGKILL");
  await waitProcessGone(reuseLeader);
  // Release the barrier; the signalling sweep must not re-enumerate the defunct PGID.
  await writeFile(reuseRelease, "release\n");
  const reuseStop = await gatedReuse.completed;
  assert.equal(reuseStop.status, 0, `stop must complete after the leader is reaped: ${reuseStop.stderr}`);
  assert.equal(processAlive(alienPid), true, "the alien in the reused PGID must NEVER be signalled");
  process.kill(alienPid, "SIGKILL");
  await waitProcessGone(alienPid);
  process.stdout.write("PGID reuse after leader reap: alien in the freed process group was not signalled\n");

  // PID-reuse analogue: metadata points at a genuinely different live process
  // whose starttime and process group differ. It remains untouched and metadata
  // remains preserved with a permanent (78) refusal.
  const reusedState = path.join(temporary, "different-process-state");
  const reusedControl = await makeControl("different-process");
  await mkdir(reusedState, { mode: 0o700 });
  const reusedManaged = await startManaged(reusedState, reusedControl, simple);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const differentProcess = spawn("/bin/sleep", ["60"], { stdio: "ignore", detached: true });
  cleanupGroups.push(differentProcess.pid);
  const differentIdentity = processIdentity(differentProcess.pid);
  assert.notEqual(differentIdentity.starttime, reusedManaged.document.starttime);
  assert.notEqual(differentIdentity.pgid, reusedManaged.document.pgid);
  const reusedDocument = { ...reusedManaged.document, pid: differentProcess.pid };
  const reusedBody = `${JSON.stringify(reusedDocument)}\n`;
  await writeFile(reusedManaged.metadata, reusedBody);
  result = stopManaged(reusedState, reusedControl);
  assert.equal(result.status, 78, result.stderr);
  assert.equal(processAlive(differentProcess.pid), true, "different current process must be preserved");
  assert.equal(processAlive(reusedManaged.document.pid), true, "original adapter must also be preserved on refusal");
  assert.equal(await readFile(reusedManaged.metadata, "utf8"), reusedBody);
  await writeFile(reusedManaged.metadata, `${JSON.stringify(reusedManaged.document)}\n`);
  assert.equal(stopManaged(reusedState, reusedControl).status, 0);
  await waitProcessGone(reusedManaged.document.pid);
  process.kill(-differentProcess.pid, "SIGTERM");
  await waitProcessGone(differentProcess.pid);
  process.stdout.write("different-process PID-reuse mismatch: preserved with exit 78\n");

  // Environment identity is an ambiguity detector, never targeting authority.
  // A same-UID process in another session can copy every CAUCE identity variable;
  // stop/stopped must refuse with 78 without touching it or the real leader.
  const forgedEnvState = path.join(temporary, "forged-env-state");
  const forgedEnvControl = await makeControl("forged-env");
  await mkdir(forgedEnvState, { mode: 0o700 });
  const forgedEnvManaged = await startManaged(forgedEnvState, forgedEnvControl, simple);
  const forgedEnvProcess = spawn("/bin/sleep", ["60"], {
    stdio: "ignore",
    detached: true,
    env: lifecycleEnv(forgedEnvState, forgedEnvControl, lifecycleGeneration),
  });
  cleanupGroups.push(forgedEnvProcess.pid);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.notEqual(processIdentity(forgedEnvProcess.pid).pgid, forgedEnvManaged.document.pgid);
  const forgedMetadataBody = await readFile(forgedEnvManaged.metadata, "utf8");
  result = stopManaged(forgedEnvState, forgedEnvControl);
  assert.equal(result.status, 78, result.stderr);
  assert.equal(processAlive(forgedEnvProcess.pid), true, "environment-only process must not be signalled");
  assert.equal(processAlive(forgedEnvManaged.document.pid), true, "real leader is preserved on ambiguous stop");
  assert.equal(await readFile(forgedEnvManaged.metadata, "utf8"), forgedMetadataBody);
  const forgedStopped = spawnSync("python3", lifecycleArgs("stopped", forgedEnvState, forgedEnvControl), { encoding: "utf8" });
  assert.equal(forgedStopped.status, 78, forgedStopped.stderr);
  process.kill(-forgedEnvProcess.pid, "SIGKILL");
  await waitProcessGone(forgedEnvProcess.pid);
  result = stopManaged(forgedEnvState, forgedEnvControl);
  assert.equal(result.status, 0, `registered leader must remain stoppable after ambiguity clears: ${result.stderr}`);
  await waitProcessGone(forgedEnvManaged.document.pid);
  process.stdout.write("forged environment outsider: preserved with exit 78; registered leader later stopped with exit 0\n");

  // If the registered leader is absent, an env-matching outsider still cannot be
  // promoted into a target. Metadata remains for operator/container resolution.
  const absentLeaderState = path.join(temporary, "absent-leader-forged-env-state");
  const absentLeaderControl = await makeControl("absent-leader-forged-env");
  await mkdir(absentLeaderState, { mode: 0o700 });
  const absentLeaderManaged = await startManaged(absentLeaderState, absentLeaderControl, simple);
  const absentLeaderDocument = absentLeaderManaged.document;
  absentLeaderManaged.child.kill("SIGKILL");
  await waitProcessGone(absentLeaderManaged.child.pid);
  process.kill(-absentLeaderDocument.pgid, "SIGKILL");
  await waitProcessGone(absentLeaderDocument.pid);
  await writeFile(absentLeaderManaged.metadata, `${JSON.stringify(absentLeaderDocument)}\n`);
  const absentLeaderOutsider = spawn("/bin/sleep", ["60"], {
    stdio: "ignore",
    detached: true,
    env: lifecycleEnv(absentLeaderState, absentLeaderControl, lifecycleGeneration),
  });
  cleanupGroups.push(absentLeaderOutsider.pid);
  result = stopManaged(absentLeaderState, absentLeaderControl);
  assert.equal(result.status, 78, result.stderr);
  assert.equal(processAlive(absentLeaderOutsider.pid), true, "env match cannot replace an absent registered leader");
  assert.equal(await readFile(absentLeaderManaged.metadata, "utf8"), `${JSON.stringify(absentLeaderDocument)}\n`);
  process.kill(-absentLeaderOutsider.pid, "SIGKILL");
  await waitProcessGone(absentLeaderOutsider.pid);
  process.stdout.write("absent registered leader plus forged environment outsider: preserved with exit 78\n");

  // EACCES on an otherwise valid 0700 control path is a clean permanent error,
  // never a traceback or a false stopped result.
  const inaccessibleState = path.join(temporary, "inaccessible-control-state");
  const inaccessibleControl = await makeControl("inaccessible-control");
  await mkdir(inaccessibleState, { mode: 0o700 });
  const inaccessibleManaged = await startManaged(inaccessibleState, inaccessibleControl, simple);
  // Root bypasses DAC, so mode 0000 denies nothing to a root controller. The equivalent
  // fail-closed refusal there is a control dir that is no longer owned by the controller
  // (exactly the adapter-UID-owned control plane the runtime must reject).
  if (runningAsRoot) await chown(inaccessibleControl, testIdentity.uid, testIdentity.gid);
  else await chmod(inaccessibleControl, 0o000);
  try {
    const deniedStop = stopManaged(inaccessibleState, inaccessibleControl);
    assert.equal(deniedStop.status, 78, deniedStop.stderr);
    assert.doesNotMatch(deniedStop.stderr, /Traceback/);
    const deniedStopped = spawnSync("python3", lifecycleArgs("stopped", inaccessibleState, inaccessibleControl), { encoding: "utf8" });
    assert.equal(deniedStopped.status, 78, deniedStopped.stderr);
    assert.doesNotMatch(deniedStopped.stderr, /Traceback/);
    assert.equal(processAlive(inaccessibleManaged.document.pid), true);
  } finally {
    if (runningAsRoot) await chown(inaccessibleControl, 0, 0);
    else await chmod(inaccessibleControl, 0o700);
  }
  assert.equal(stopManaged(inaccessibleState, inaccessibleControl).status, 0);
  await waitProcessGone(inaccessibleManaged.document.pid);
  process.stdout.write("inaccessible control directory: clean exit 78 without traceback\n");

  // A different current container ID/generation never signals a valid live process.
  const identityState = path.join(temporary, "identity-state");
  const identityControl = await makeControl("identity");
  await mkdir(identityState, { mode: 0o700 });
  managed = await startManaged(identityState, identityControl, simple);
  result = spawnSync("python3", [runtimeHelper, "stop", "--alias", "kant", "--state", identityState,
    "--control-dir", identityControl, "--container-id", "e".repeat(64), "--generation", replacementGeneration], { encoding: "utf8" });
  assert.equal(result.status, 78);
  assert.equal(processAlive(managed.document.pid), true);
  assert.equal(stopManaged(identityState, identityControl).status, 0);

  // Dead metadata is cleaned only for a verifiably stale generation; same-generation death is permanent.
  const staleState = path.join(temporary, "stale-state");
  const staleControl = await makeControl("stale");
  await mkdir(staleState, { mode: 0o700 });
  managed = await startManaged(staleState, staleControl, simple);
  const staleDocument = managed.document;
  assert.equal(stopManaged(staleState, staleControl).status, 0);
  await waitProcessGone(staleDocument.pid);
  await writeFile(managed.metadata, `${JSON.stringify(staleDocument)}\n`);
  const sameGeneration = spawnSync("python3", runArgs(staleState, staleControl, simple), {
    encoding: "utf8",
    env: lifecycleEnv(staleState, staleControl, lifecycleGeneration),
  });
  assert.equal(sameGeneration.status, 78);
  assert.equal(await readFile(managed.metadata, "utf8"), `${JSON.stringify(staleDocument)}\n`);
  const stalePreStartStop = stopManaged(staleState, staleControl, replacementGeneration);
  assert.equal(stalePreStartStop.status, 0,
    `pre-start stop must tolerate quiescent metadata from a prior container generation: ${stalePreStartStop.stderr}`);
  assert.equal(await readFile(managed.metadata, "utf8"), `${JSON.stringify(staleDocument)}\n`,
    "pre-start stop leaves stale metadata for the lock-owning run path to clean");
  const staleReplacementProof = spawnSync(
    "python3",
    lifecycleArgs("stopped", staleState, staleControl, replacementGeneration),
    { encoding: "utf8" },
  );
  assert.equal(staleReplacementProof.status, 0,
    `replacement generation must be provably stopped despite stale metadata: ${staleReplacementProof.stderr}`);
  managed = await startManaged(staleState, staleControl, simple, [], replacementGeneration);
  assert.equal(managed.document.containerGeneration, replacementGeneration);
  assert.equal(stopManaged(staleState, staleControl, replacementGeneration).status, 0);
  process.stdout.write("same-container restart: stale generation stop/stopped passed and run replaced metadata safely\n");

  // Exercise that same stale-generation contract through the host supervisor, not only by
  // calling the lifecycle helper directly.  Fake Docker delegates the pre-deploy `stop` to the
  // real helper while keeping all other container operations observable.  An inert metadata
  // document from the prior generation must not strand the unit before its guarded final exec.
  await writeFile(managed.metadata, `${JSON.stringify(staleDocument)}\n`);
  await writeConfig("kant");
  await clearLog();
  statePath = await dockerState("kant", {
    runtimeStopFixture: {
      helper: runtimeHelper,
      state: staleState,
      control: staleControl,
    },
  });
  result = runSupervisor("start", "kant", statePath);
  assert.equal(result.status, 0,
    `supervisor restart must tolerate inert prior-generation metadata: ${result.stderr}`);
  calls = await records();
  assert(calls.some(({ argv }) => argv.includes("stop") && argv.includes("--generation")),
    "supervisor must ask the real lifecycle helper to stop the prior generation");
  assert(calls.some(({ argv }) => argv.includes("guard-exec") && argv.includes("CAUCE_ALIAS=kant")),
    "supervisor must reach the guarded adapter exec after stale-generation stop");
  process.stdout.write("host supervisor restart: inert prior-generation metadata reached guarded exec\n");

  // ---- No published leader => a metadata-based stop NEVER signals the controller. ----
  async function startGated(phase, marker, executablePath, generation = lifecycleGeneration) {
    const state = path.join(temporary, `phase-${phase}-state-${Math.random().toString(16).slice(2)}`);
    const control = await makeControl(`phase-${phase}`);
    await mkdir(state, { mode: 0o700 });
    const child = spawn("python3", runArgs(state, control, executablePath, [], generation), {
      stdio: "ignore",
      env: lifecycleEnv(state, control, generation, { CAUCE_CONTAINER_TEST_PHASE_GATE: `${phase}|${marker}|8` }),
    });
    cleanupProcesses.push(child);
    await waitForFile(marker);
    return { child, state, control };
  }
  // While the controller is still starting -- either pre-metadata (lock held, nothing
  // published) or "starting" metadata whose leader PID/PGID/SID are still null -- the
  // controller PID/starttime is lifecycle bookkeeping, not authority to signal an
  // unregistered target. Both stop and stopped must refuse fail-closed (78) and preserve
  // every byte, WITHOUT signalling the controller. The controller cancels itself and any
  // nascent child only on a direct SIGTERM (its own graceful-cancellation contract).
  for (const phase of ["pre-metadata", "starting", "pre-child", "post-child"]) {
    const marker = path.join(temporary, `gate-${phase}-${Math.random().toString(16).slice(2)}.marker`);
    const gated = await startGated(phase, marker, simple);
    const gatedMetadata = path.join(gated.control, metadataName);
    const beforeStop = phase === "pre-metadata" ? null : await readFile(gatedMetadata, "utf8");
    if (beforeStop !== null) {
      assert.equal(JSON.parse(beforeStop).phase, "starting", `${phase} must publish only starting metadata`);
      assert.equal(JSON.parse(beforeStop).pid, null, `${phase} must not publish a leader PID`);
    }
    const gatedStop = stopManaged(gated.state, gated.control);
    assert.equal(gatedStop.status, 78, `${phase} stop must be fail-closed (78), got ${gatedStop.status}: ${gatedStop.stderr}`);
    assert.equal(processAlive(gated.child.pid), true, `${phase}: stop must never signal the still-starting controller`);
    if (beforeStop !== null) {
      assert.equal(await readFile(gatedMetadata, "utf8"), beforeStop, `${phase}: starting metadata must be preserved byte-for-byte`);
    }
    const proof = spawnSync("python3", lifecycleArgs("stopped", gated.state, gated.control), { encoding: "utf8" });
    assert.equal(proof.status, 78, `${phase} stopped must be fail-closed (78), got ${proof.status}: ${proof.stderr}`);
    assert.equal(processAlive(gated.child.pid), true, `${phase}: stopped must never signal the controller either`);
    // Only a direct SIGTERM cancels the controller (and tears down any nascent child).
    gated.child.kill("SIGTERM");
    await waitProcessGone(gated.child.pid);
  }
  process.stdout.write("no published leader across startup phases: stop/stopped refuse with 78 and never signal the controller\n");

  // Starting metadata whose controller PID now names an unrelated process is a
  // PID-reuse analogue. Neither that process nor its child may become traversal
  // roots or signal targets; stop must preserve metadata and return 78.
  const reusedControllerMarker = path.join(temporary, "controller-reuse-starting.marker");
  const reusedController = await startGated("starting", reusedControllerMarker, simple);
  const reusedControllerMetadata = path.join(reusedController.control, metadataName);
  const originalStartingDocument = await waitForMetadataPhase(reusedControllerMetadata, "starting");
  reusedController.child.kill("SIGKILL");
  await waitProcessGone(reusedController.child.pid);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const foreignChildPidFile = path.join(temporary, "foreign-controller-child.pid");
  const foreignController = spawn(resistant, [foreignChildPidFile], { stdio: "ignore", detached: true });
  cleanupGroups.push(foreignController.pid);
  await waitForFile(foreignChildPidFile);
  const foreignControllerChild = Number((await readFile(foreignChildPidFile, "utf8")).trim());
  cleanupGroups.push(foreignControllerChild);
  const reusedControllerDocument = { ...originalStartingDocument, controllerPid: foreignController.pid };
  const reusedControllerBody = `${JSON.stringify(reusedControllerDocument)}\n`;
  await writeFile(reusedControllerMetadata, reusedControllerBody);
  const refusedControllerStop = stopManaged(reusedController.state, reusedController.control);
  assert.equal(refusedControllerStop.status, 78, refusedControllerStop.stderr);
  assert.equal(processAlive(foreignController.pid), true, "reused controller PID must not be signalled");
  assert.equal(processAlive(foreignControllerChild), true, "child of reused controller PID must not be signalled");
  assert.equal(await readFile(reusedControllerMetadata, "utf8"), reusedControllerBody);
  process.kill(foreignController.pid, "SIGKILL");
  process.kill(foreignControllerChild, "SIGKILL");
  await waitProcessGone(foreignController.pid);
  await waitProcessGone(foreignControllerChild);
  process.stdout.write("controller PID reuse: unrelated process and child preserved with exit 78\n");

  // ---- Killing the docker-exec client leaves no orphan and no second consumer. ----
  const orphanState = path.join(temporary, "orphan-state");
  const orphanControl = await makeControl("orphan");
  await mkdir(orphanState, { mode: 0o700 });
  const orphanPidFile = path.join(temporary, "orphan-child.pid");
  managed = await startManaged(orphanState, orphanControl, resistant, [orphanPidFile]);
  await waitForFile(orphanPidFile);
  const orphanDescendant = Number((await readFile(orphanPidFile, "utf8")).trim());
  const orphanLeader = managed.document.pid;
  // The docker-exec client dying == the controller dying abruptly; the adapter is orphaned.
  process.kill(managed.child.pid, "SIGKILL");
  await waitProcessGone(managed.child.pid);
  assert.equal(processAlive(orphanLeader), true, "the adapter survives the controller death");
  assert.equal(processAlive(orphanDescendant), true, "the resistant descendant survives too");
  // A same-generation restart must refuse rather than create a second consumer.
  const secondConsumer = spawnSync("python3", runArgs(orphanState, orphanControl, simple), {
    encoding: "utf8",
    env: lifecycleEnv(orphanState, orphanControl, lifecycleGeneration),
  });
  assert.equal(secondConsumer.status, 78, `a second consumer must be refused: ${secondConsumer.stdout} ${secondConsumer.stderr}`);
  assert.equal(processAlive(orphanLeader), true, "the refused restart never touched the live adapter");
  // stop reaps the orphaned leader and its TERM-resistant setsid descendant, leaving no residue.
  const orphanStop = stopManaged(orphanState, orphanControl);
  assert.equal(orphanStop.status, 0, `stop must reap the orphan: ${orphanStop.stderr}`);
  await waitProcessGone(orphanLeader);
  await waitProcessGone(orphanDescendant);
  const orphanProof = spawnSync("python3", lifecycleArgs("stopped", orphanState, orphanControl), { encoding: "utf8" });
  assert.equal(orphanProof.status, 0, `the orphan must be provably stopped: ${orphanProof.stderr}`);

  // ---- A real non-root UID cannot unlink the root-owned control plane (metadata + lock). ----
  function sudo(args, opts = {}) { return spawnSync("sudo", ["-n", ...args], { encoding: "utf8", ...opts }); }
  const privileged = sudo(["true"]).status === 0 && sudo(["-u", "#65534", "true"]).status === 0;
  if (privileged) {
    const priv = `/tmp/cauce-adv-${process.pid}-${Math.random().toString(16).slice(2)}`;
    privilegedRoots.push(priv);
    assert.equal(sudo(["mkdir", "-m", "0755", priv]).status, 0);
    const psimple = path.join(priv, "simple.py");
    assert.equal(sudo(["cp", simple, psimple]).status, 0);
    assert.equal(sudo(["chmod", "0555", psimple]).status, 0);
    const pstate = path.join(priv, "state");
    const pctl = path.join(priv, "control");
    assert.equal(sudo(["mkdir", "-m", "0700", pstate]).status, 0);
    assert.equal(sudo(["mkdir", "-m", "0700", pctl]).status, 0);
    const rootEnv = ["env", "CAUCE_ALIAS=kant", `CAUCE_STATE_DIR=${pstate}`, `CAUCE_CONTROL_DIR=${pctl}`,
      `CAUCE_CONTAINER_ID=${lifecycleContainerId}`, `CAUCE_CONTAINER_GENERATION=${lifecycleGeneration}`];
    const rootRun = ["python3", runtimeHelper, "run", "--alias", "kant", "--state", pstate, "--control-dir", pctl,
      "--runtime-uid", "65534", "--runtime-gid", "65534", "--container-id", lifecycleContainerId,
      "--generation", lifecycleGeneration, "--term-seconds", "1", "--kill-seconds", "2",
      "--bundle", release, "--bundle-digest", bundleDigest, psimple];
    const rootChild = spawn("sudo", ["-n", ...rootEnv, ...rootRun], { stdio: "ignore" });
    privilegedChildren.push(rootChild);
    let rootDoc = null;
    for (let attempt = 0; attempt < 200 && !rootDoc; attempt += 1) {
      const seen = sudo(["cat", path.join(pctl, metadataName)]);
      if (seen.status === 0) {
        try { const parsed = JSON.parse(seen.stdout); if (parsed.phase === "running" && parsed.pid) rootDoc = parsed; } catch { /* not published yet */ }
      }
      if (!rootDoc) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(rootDoc, "the root-owned lifecycle metadata reached the running phase");
    assert.equal(rootDoc.runtimeUid, 65534, "the adapter dropped to the non-root runtime UID");
    assert.equal(rootDoc.runtimeGid, 65534, "the adapter dropped to the non-root runtime GID");
    // A real, unprivileged UID (nobody) must be denied unlink of the metadata and the lock.
    const deny = "import os,sys\ntry:\n os.unlink(sys.argv[1]); print('UNLINKED'); sys.exit(9)\nexcept OSError as e:\n print('DENIED', e.errno); sys.exit(0)";
    const denyMeta = sudo(["-u", "#65534", "python3", "-c", deny, path.join(pctl, metadataName)]);
    assert.equal(denyMeta.status, 0, `non-root metadata unlink must be denied cleanly: ${denyMeta.stdout} ${denyMeta.stderr}`);
    assert.match(denyMeta.stdout, /DENIED/);
    assert.doesNotMatch(denyMeta.stdout, /UNLINKED/);
    const denyLock = sudo(["-u", "#65534", "python3", "-c", deny, path.join(pctl, lockName)]);
    assert.equal(denyLock.status, 0, `non-root lock unlink must be denied cleanly: ${denyLock.stdout} ${denyLock.stderr}`);
    assert.match(denyLock.stdout, /DENIED/);
    assert.doesNotMatch(denyLock.stdout, /UNLINKED/);
    // The control plane and the adapter survived the tampering attempt.
    assert.equal(sudo(["test", "-f", path.join(pctl, metadataName)]).status, 0, "metadata survived the failed unlink");
    assert.equal(sudo(["test", "-f", path.join(pctl, lockName)]).status, 0, "lock survived the failed unlink");
    assert.equal(sudo(["kill", "-0", String(rootDoc.pid)]).status, 0, "the adapter is still alive after the failed tampering");
    // A root runtime identity is rejected outright before the control plane is touched.
    const rootRuntime = sudo([...rootEnv, "python3", runtimeHelper, "run", "--alias", "kant", "--state", pstate,
      "--control-dir", pctl, "--runtime-uid", "0", "--runtime-gid", "0", "--container-id", lifecycleContainerId,
      "--generation", lifecycleGeneration, "--bundle", release, "--bundle-digest", bundleDigest, psimple]);
    assert.equal(rootRuntime.status, 78, `a root runtime identity must be rejected: ${rootRuntime.stdout} ${rootRuntime.stderr}`);
    // Tear the root-owned adapter down and prove it stopped.
    const rootStop = sudo(["python3", runtimeHelper, "stop", "--alias", "kant", "--state", pstate, "--control-dir", pctl,
      "--container-id", lifecycleContainerId, "--generation", lifecycleGeneration, "--term-seconds", "1", "--kill-seconds", "2"]);
    assert.equal(rootStop.status, 0, `the root-owned stop must succeed: ${rootStop.stderr}`);
    process.stdout.write("privileged root-owned control-plane reproductions passed\n");
  } else if (droppedFromRoot) {
    // Do not let the root release host silently buy a green gate with less coverage than a
    // developer machine gets. Name what was not exercised and how to exercise it.
    process.stdout.write(
      "WARNING: privileged root-owned control-plane reproductions were NOT exercised: this run "
      + "started as root and dropped its own privileges, so passwordless sudo is unavailable. "
      + "Run this suite from a non-root account that has passwordless sudo for root and #65534 "
      + "to cover root-owned metadata/lock tamper resistance.\n");
  } else {
    process.stdout.write("skipping privileged reproductions: passwordless sudo for root and #65534 is unavailable\n");
  }

  process.stdout.write("container supervisor adversarial tests passed\n");
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
