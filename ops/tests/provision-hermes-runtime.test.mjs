#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(ops, "scripts/provision-hermes-runtime.sh");
const lockHelper = path.join(ops, "scripts/alias-lock-exec.py");
const runtimeVerifier = path.join(ops, "scripts/verify-hermes-runtime.py");
const aliasGenerator = path.join(ops, "scripts/generate-container-aliases.py");
const hermesRuntime = path.join(ops, "hermes-runtime.json");
const fleetFixture = path.join(ops, "tests/fixtures/fleet_snapshot/minimal/flota.json");
const HERMES_ALIAS = "fixture-hermes";
const NON_HERMES_ALIAS = "fixture-codex";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cauce-hermes-provision-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "docker.log");
  const fixtureOps = path.join(root, "ops");
  const fixtureScripts = path.join(fixtureOps, "scripts");
  const fixtureLockHelper = path.join(fixtureScripts, "alias-lock-exec.py");
  await Promise.all([
    mkdir(bin),
    mkdir(path.join(root, "locks"), { mode: 0o700 }),
    mkdir(fixtureScripts, { recursive: true }),
  ]);
  const generated = spawnSync("python3", [
    aliasGenerator,
    "--snapshot", fleetFixture,
    "--output", path.join(fixtureOps, "container-aliases.json"),
  ], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  await Promise.all([
    copyFile(hermesRuntime, path.join(fixtureOps, "hermes-runtime.json")),
    copyFile(lockHelper, fixtureLockHelper),
    copyFile(runtimeVerifier, path.join(fixtureScripts, "verify-hermes-runtime.py")),
  ]);
  await writeFile(path.join(bin, "docker"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CAUCE_FAKE_DOCKER_LOG"
case "\${1:-}" in
  ps) printf '%s\\n' deadbeef ;;
  exec) while IFS= read -r _line; do :; done ;;
  *) exit 91 ;;
esac
`);
  await chmod(path.join(bin, "docker"), 0o755);
  const runtime = JSON.parse(await readFile(hermesRuntime, "utf8"));
  return { root, bin, log, fixtureOps, fixtureLockHelper, runtimeVersion: runtime.packageVersion };
}

function run(args, f) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      CAUCE_CONTAINER_OPS_ROOT: f.fixtureOps,
      CAUCE_CONTAINER_LOCK_ROOT: path.join(f.root, "locks"),
      CAUCE_FAKE_DOCKER_LOG: f.log,
    },
  });
}

async function recoveryProgram() {
  const source = await readFile(script, "utf8");
  const match = source.match(
    /# BEGIN HERMES_PARTIAL_RECOVERY_PY\n(?<program>[\s\S]*?)# END HERMES_PARTIAL_RECOVERY_PY/u,
  );
  assert(match?.groups?.program, "the functional recovery program must remain directly testable");
  return match.groups.program;
}

function runRecovery(program, runtimeParent, ownerUid = process.getuid()) {
  return spawnSync("python3", [
    "-c", program,
    runtimeParent,
    "runtime-fixture",
    String(ownerUid),
    "a".repeat(40),
    "0.20.5",
    "0.11.21",
    "test-target",
    "b".repeat(64),
    "c".repeat(64),
    "https://example.invalid/uv.tgz",
    "d".repeat(64),
  ], { encoding: "utf8" });
}

test("provision/check resolves a declared local Hermes fixture and never exposes credentials", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = run(["--check", HERMES_ALIAS], f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    `Hermes ${HERMES_ALIAS}: runtime inmutable ${f.runtimeVersion} verificado; `
      + "perfil persistente separado (credenciales no copiadas).",
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /token|password|credential|\.env/iu);
  const calls = await readFile(f.log, "utf8");
  assert.match(calls, /^ps --no-trunc --filter name=\^\/fixture-hermes-runtime\$/mu);
  assert.match(calls, /^exec -i --user dev deadbeef \/usr\/bin\/python3 -c /mu);
  assert.match(calls, /^exec -i --user 0 deadbeef sh -s -- check /mu);
});

test("a non-Hermes alias fails before Docker", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = run([NON_HERMES_ALIAS], f);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no usa Hermes/u);
  await assert.rejects(readFile(f.log, "utf8"), { code: "ENOENT" });
});

test("the provisioner pins Git, uv and a root-owned immutable runtime without copying auth", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /GIT_TERMINAL_PROMPT=0[\s\S]*git .* fetch/u);
  assert.match(source, /rev-parse FETCH_HEAD/u);
  assert.match(source, /sha256sum "\$runtime_stage\/uv"/u);
  assert.match(source, /uv" sync --frozen --no-dev --link-mode copy --no-cache/u);
  assert.match(source, /status --porcelain=v1 --untracked-files=all --ignored=matching/u);
  assert.match(source, /verify-hermes-runtime\.py/u);
  assert.match(source, /--uv-archive-sha256/u);
  assert.match(source, /chown -R 0:0 "\$runtime_stage"/u);
  assert.match(source, /find "\$runtime_stage"[\s\S]*chmod 0444/u);
  assert.doesNotMatch(source, /curl[^\n]*\|[^\n]*(?:sh|bash)/u);
  assert.doesNotMatch(source, /cp[^\n]*(?:\.env|credential|auth|token)/iu);
});

test("a SIGKILL partial release is recovered exactly under lock and a sealed release is idempotent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cauce-hermes-recovery-"));
  const runtimeParent = path.join(root, HERMES_ALIAS);
  const runtime = path.join(runtimeParent, "runtime-fixture");
  t.after(async () => {
    await chmod(runtime, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const pending = path.join(runtime, ".cauce-build-pending");
  await mkdir(runtimeParent, { mode: 0o755 });
  const program = await recoveryProgram();

  const first = runRecovery(program, runtimeParent);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), "build");
  assert.deepEqual(await readdir(runtime), [".cauce-build-pending"]);
  await lstat(pending);

  // Reproduce the durable state left by SIGKILL: exact marker plus an incomplete build entry.
  await writeFile(path.join(runtime, "source-fragment"), "partial\n", { mode: 0o600 });
  const recovered = runRecovery(program, runtimeParent);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout.trim(), "build");
  assert.deepEqual(await readdir(runtime), [".cauce-build-pending"],
    "the old partial tree must be removed before a clean exact-path rebuild");
  assert.equal((await lstat(pending)).isFile(), true);

  // SIGKILL can also land after the ready marker rename but before the durable build marker is
  // removed. Both markers still mean uncommitted: recover rather than blessing the mixed state.
  await writeFile(path.join(runtime, ".cauce-runtime"), "not committed yet\n", { mode: 0o400 });
  const finalizationCrash = runRecovery(program, runtimeParent);
  assert.equal(finalizationCrash.status, 0, finalizationCrash.stderr);
  assert.equal(finalizationCrash.stdout.trim(), "build");
  assert.deepEqual(await readdir(runtime), [".cauce-build-pending"]);

  // Once a ready marker exists, recovery is read-only and repeatable; the full verifier owns the
  // content check that follows this classifier in the provisioner.
  await rm(runtime, { recursive: true });
  await mkdir(runtime, { mode: 0o700 });
  const ready = path.join(runtime, ".cauce-runtime");
  await writeFile(ready, "sealed fixture\n", { mode: 0o400 });
  await chmod(runtime, 0o555);
  const readyBefore = await lstat(ready);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const idempotent = runRecovery(program, runtimeParent);
    assert.equal(idempotent.status, 0, idempotent.stderr);
    assert.equal(idempotent.stdout.trim(), "ready");
  }
  assert.equal((await lstat(ready)).ino, readyBefore.ino, "a published release is never rebuilt");
});

test("partial recovery fails closed on exact-path symlinks and ambiguous ownership/mode", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cauce-hermes-recovery-negative-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeParent = path.join(root, HERMES_ALIAS);
  const runtime = path.join(runtimeParent, "runtime-fixture");
  const external = path.join(root, "external");
  const sentinel = path.join(external, "sentinel");
  await mkdir(runtimeParent, { mode: 0o755 });
  await mkdir(external);
  await writeFile(sentinel, "untouched\n");
  await symlink(external, runtime);
  const program = await recoveryProgram();

  const linked = runRecovery(program, runtimeParent);
  assert.notEqual(linked.status, 0);
  assert.equal(await readFile(sentinel, "utf8"), "untouched\n");
  assert.equal((await lstat(runtime)).isSymbolicLink(), true);

  await rm(runtime);
  const prepared = runRecovery(program, runtimeParent);
  assert.equal(prepared.status, 0, prepared.stderr);
  await chmod(runtime, 0o777);
  const ambiguous = runRecovery(program, runtimeParent);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /ownership|mode/iu);
  assert.equal((await lstat(path.join(runtime, ".cauce-build-pending"))).isFile(), true,
    "ambiguous state must remain for operator inspection, never be deleted into compliance");
});

test("a symlink lock is rejected without truncating its target", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const lockDirectory = path.join(f.root, "locks", `cauce-v3-alias-locks-${process.getuid()}`);
  await mkdir(lockDirectory, { mode: 0o700 });
  const target = path.join(f.root, "do-not-touch");
  await writeFile(target, "intacto\n");
  await symlink(target, path.join(lockDirectory, `${HERMES_ALIAS}.lock`));

  const result = run([HERMES_ALIAS], f);
  assert.equal(result.status, 73);
  assert.match(result.stderr, /alias-lock-exec: .*lock/u);
  assert.equal(await readFile(target, "utf8"), "intacto\n");
});

test("a live supervisor lock blocks Hermes provisioning for the same alias", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const marker = path.join(f.root, "supervisor-ready");
  const holder = spawn("python3", [
    f.fixtureLockHelper, "run", "--lock-root", path.join(f.root, "locks"),
    "--alias", HERMES_ALIAS, "--",
    process.execPath, "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'ready\\n'); setInterval(() => {}, 1000)",
    marker,
  ], { stdio: "ignore" });
  t.after(() => { if (holder.exitCode === null) holder.kill("SIGTERM"); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(marker, "utf8");
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  assert.equal(await readFile(marker, "utf8"), "ready\n");
  const blocked = run([HERMES_ALIAS], f);
  assert.equal(blocked.status, 73);
  assert.match(blocked.stderr, /lock is already held/u);
  holder.kill("SIGTERM");
});
