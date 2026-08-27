#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digestScript = path.join(ops, "scripts/container_ops_digest.py");

// 1. The operational digest must cover the critical adversarial suites, their fakes and
//    the operator runbooks, not only the shipped scripts. --list prints exactly what is hashed.
const list = spawnSync("python3", [digestScript, "--rootless", "--list"], { encoding: "utf8" });
assert.equal(list.status, 0, list.stderr);
const covered = new Set(list.stdout.trim().split("\n"));
assert(!covered.has("cli/cauce.bak-login-20260823T000500Z"),
  "ignored operator backups must not contaminate the committed operations digest");
for (const required of [
  "container-runtime/cauce-container-runtime.py",
  "hermes-runtime.json",
  "scripts/container-adapter-supervisor.sh",
  "scripts/alias-lock-exec.py",
  "scripts/verify-hermes-runtime.py",
  "scripts/alias-runner.sh",
  "scripts/cutover.sh",
  "scripts/create-inactive-override-manifest.py",
  "scripts/migration-integrity-gate.sh",
  "scripts/reconcile-stale-console-outbox.sh",
  "scripts/provision-terminal-client.sh",
  "scripts/provision-hermes-runtime.sh",
  "tests/test_alias_lock_exec.py",
  "tests/test_verify_hermes_runtime.py",
  "scripts/host-backup.sh",
  "scripts/host-backup-monitor.sh",
  "tests/container-supervisor.test.mjs",
  "tests/test_container_runtime_reaping.py",
  "tests/alias-runner.test.mjs",
  "tests/container-cutover.test.mjs",
  "tests/container-ops-evidence.test.mjs",
  "tests/fake-docker.mjs",
  "tests/fake-systemctl.mjs",
  "tests/fake-container-supervisor.mjs",
  "tests/fake-gate-collector.mjs",
  "runbooks/container-adapters.md",
  "runbooks/alias-cutover.md",
  "runbooks/backup-restore.md",
  "config/prod.env.example",
  "config/host-backup.env.example",
  "observability/alerts.yaml",
]) {
  assert(covered.has(required), `operational digest must cover ${required}`);
}

// 2. The checked-in OPERATIONS.sha256 must match the current operational inputs.
const check = spawnSync("python3", [digestScript, "--rootless", "--check"], { encoding: "utf8" });
assert.equal(check.status, 0, `${check.stdout} ${check.stderr}`);

// Mutating the evidence test itself in an isolated mirror must move the system
// operational digest. This proves the guard cannot be weakened without evidence.
const mutationCheck = spawnSync("python3", ["-c", [
  "import importlib.util, pathlib, shutil, sys, tempfile",
  "source = pathlib.Path(sys.argv[1]).resolve()",
  "spec = importlib.util.spec_from_file_location('container_ops_digest', source / 'scripts/container_ops_digest.py')",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "with tempfile.TemporaryDirectory() as temporary:",
  "    root = pathlib.Path(temporary) / 'ops'",
  "    generated_source = source / 'generated/container-systemd/rootless'",
  "    for input_path in module.operational_files(source, generated_source, rootless=True):",
  "        if input_path.is_relative_to(generated_source):",
  "            continue",
  "        relative = input_path.relative_to(source)",
  "        destination = root / relative",
  "        destination.parent.mkdir(parents=True, exist_ok=True)",
  "        shutil.copy2(input_path, destination)",
  "    shutil.copytree(generated_source, root / 'generated/container-systemd/rootless')",
  "    generated = root / 'generated/container-systemd/rootless'",
  "    before = module.operational_digest(root, generated, rootless=True)",
  "    evidence = root / 'tests/container-ops-evidence.test.mjs'",
  "    evidence.write_bytes(evidence.read_bytes() + b'\\n// isolated mutation\\n')",
  "    after = module.operational_digest(root, generated, rootless=True)",
  "    assert before != after, 'evidence-test mutation must change operations digest'",
  "print('evidence-test-mutation-moves-digest')",
].join("\n"), ops], { encoding: "utf8" });
assert.equal(mutationCheck.status, 0, mutationCheck.stderr);
assert.match(mutationCheck.stdout, /evidence-test-mutation-moves-digest/u);
process.stdout.write("container ops evidence mutation: operational digest changed\n");

// A checkout may contain ignored operator backups, while the release context is
// a git archive.  Both must calculate the same digest from committed inputs.
const ignoredBackupCheck = spawnSync("python3", ["-c", [
  "import importlib.util, pathlib, shutil, subprocess, sys, tempfile",
  "source = pathlib.Path(sys.argv[1]).resolve()",
  "spec = importlib.util.spec_from_file_location('container_ops_digest', source / 'scripts/container_ops_digest.py')",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "with tempfile.TemporaryDirectory() as temporary:",
  "    repository = pathlib.Path(temporary) / 'repository'",
  "    root = repository / 'ops'",
  "    generated_source = source / 'generated/container-systemd/rootless'",
  "    for input_path in module.operational_files(source, generated_source, rootless=True):",
  "        if input_path.is_relative_to(generated_source):",
  "            continue",
  "        destination = root / input_path.relative_to(source)",
  "        destination.parent.mkdir(parents=True, exist_ok=True)",
  "        shutil.copy2(input_path, destination)",
  "    shutil.copytree(generated_source, root / 'generated/container-systemd/rootless')",
  "    subprocess.run(['git', 'init', '-q', str(repository)], check=True)",
  "    subprocess.run(['git', '-C', str(repository), 'add', 'ops'], check=True)",
  "    exclude = repository / '.git/info/exclude'",
  "    exclude.write_text(exclude.read_text() + 'ops/cli/*.bak-local\\n')",
  "    generated = root / 'generated/container-systemd/rootless'",
  "    before = module.operational_digest(root, generated, rootless=True)",
  "    ignored = root / 'cli/operator.bak-local'",
  "    ignored.write_text('operator backup, never a release input\\n')",
  "    after_ignored = module.operational_digest(root, generated, rootless=True)",
  "    assert before == after_ignored, 'ignored backup changed committed operations digest'",
  "    untracked = root / 'scripts/new-operational-source.py'",
  "    untracked.write_text('print(\\\"new release source\\\")\\n')",
  "    after_untracked = module.operational_digest(root, generated, rootless=True)",
  "    assert before != after_untracked, 'non-ignored new operational source evaded the digest'",
  "    tracked = root / 'tests/container-ops-evidence.test.mjs'",
  "    tracked.write_bytes(tracked.read_bytes() + b'\\n// tracked mutation\\n')",
  "    after_tracked = module.operational_digest(root, generated, rootless=True)",
  "    assert before != after_tracked, 'tracked source mutation did not change operations digest'",
  "print('ignored-backup-excluded-new-and-tracked-source-covered')",
].join("\n"), ops], { encoding: "utf8" });
assert.equal(ignoredBackupCheck.status, 0, ignoredBackupCheck.stderr);
assert.match(ignoredBackupCheck.stdout, /ignored-backup-excluded-new-and-tracked-source-covered/u);

// Rootless user units/configs have their own source-bound operational digest and checksum set.
const rootlessList = spawnSync("python3", [digestScript, "--rootless", "--list"], { encoding: "utf8" });
assert.equal(rootlessList.status, 0, rootlessList.stderr);
const rootlessCovered = new Set(rootlessList.stdout.trim().split("\n"));
assert(rootlessCovered.has("generated/container-systemd/rootless/cauce-v3-container-kant.service"));
assert(rootlessCovered.has("generated/container-systemd/rootless/configs/kant.env.example"));
assert(rootlessCovered.has("scripts/pin-container-release.py"));
const rootlessCheck = spawnSync("python3", [digestScript, "--rootless", "--check"], { encoding: "utf8" });
assert.equal(rootlessCheck.status, 0, `${rootlessCheck.stdout} ${rootlessCheck.stderr}`);
const rootless = path.join(ops, "generated/container-systemd/rootless");
/*
 * El número de units NO se escribe a mano. Estuvo clavado en 14 y el registro creció a 15 al dar
 * de alta a `heraclito`: la prueba se puso roja por el motivo equivocado —«14 !== 15»— cuando lo
 * que de verdad pasaba es que a un alias registrado le faltaba su unidad. Un número a mano
 * confunde «alguien añadió un alias» con «alguien se olvidó de generar», que son lo contrario.
 *
 * Atado al registro, la prueba sigue cazando lo que importa —una unit que falta— y deja de pedir
 * que se la edite cada vez que la flota crece.
 */
const aliasRegistrados = Object.keys(
  JSON.parse(await readFile(path.join(ops, "container-aliases.json"), "utf8")).aliases,
).length;
assert.equal(
  (await readdir(rootless)).filter((name) => /^cauce-v3-container-.*\.service$/u.test(name)).length,
  aliasRegistrados,
  "hay un alias registrado sin unit rootless generada: corré generate-container-units.py --rootless",
);
assert.equal(
  (await readdir(path.join(rootless, "configs"))).filter((name) => name.endsWith(".env.example")).length,
  aliasRegistrados,
  "hay un alias registrado sin config de ejemplo rootless",
);
const rootlessUnit = await readFile(path.join(rootless, "cauce-v3-container-kant.service"), "utf8");
assert(!/^User=/mu.test(rootlessUnit), "systemd user unit must not set User=");
assert.match(rootlessUnit, /^WantedBy=default\.target$/mu);
assert.match(rootlessUnit, /^ExecStart=%h\/\.local\/share\/cauce-v3\/ops\/scripts\/container-adapter-supervisor\.sh start kant$/mu);
assert.match(rootlessUnit, /^Environment=CAUCE_CONTAINER_LOCK_ROOT=%t\/cauce-v3$/mu);
assert.match(rootlessUnit, /^RestartPreventExitStatus=2 73 78$/mu);
assert.match(rootlessUnit, /^RestartForceExitStatus=70$/mu);
const rootlessConfig = await readFile(path.join(rootless, "configs/kant.env.example"), "utf8");
assert.match(rootlessConfig, /^BUNDLE_RELEASE=REPLACE_WITH_IMMUTABLE_RELEASE_NAME$/mu);
assert.doesNotMatch(rootlessConfig, /^BUNDLE_CURRENT=/mu);
assert.match(rootlessConfig, /^PKI_DIR=\/home\/dev\/\.config\/cauce-v3\/container-pki\/kant$/mu);
const regeneratedRootless = await mkdtemp(path.join(os.tmpdir(), "cauce-rootless-units-"));
try {
  const generated = spawnSync("python3", [path.join(ops, "scripts/generate-container-units.py"),
    "--rootless", "--home", "/home/dev", "--output", regeneratedRootless], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  for (const name of (await readdir(rootless)).filter((entry) => entry !== "configs")) {
    assert.equal(await readFile(path.join(regeneratedRootless, name), "utf8"), await readFile(path.join(rootless, name), "utf8"),
      `checked-in rootless output is stale: ${name}`);
  }
  for (const name of await readdir(path.join(rootless, "configs"))) {
    assert.equal(await readFile(path.join(regeneratedRootless, "configs", name), "utf8"),
      await readFile(path.join(rootless, "configs", name), "utf8"), `checked-in rootless config is stale: ${name}`);
  }
} finally {
  await rm(regeneratedRootless, { recursive: true, force: true });
}

process.stdout.write("container operational digest tests passed\n");
