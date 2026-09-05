#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digestScript = path.join(ops, "scripts/container_ops_digest.py");
const sources = spawnSync("python3", ["-c", [
  "import importlib.util, json, sys",
  "spec = importlib.util.spec_from_file_location('container_ops_digest', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "print(json.dumps(module.OPERATIONS_SOURCES))",
].join("\n"), digestScript], { encoding: "utf8" });
assert.equal(sources.status, 0, sources.stderr);
const operationsSources = JSON.parse(sources.stdout);

// 1. The operational digest must cover the critical adversarial suites, their fakes and
//    the operator runbooks, not only the shipped scripts. --list prints exactly what is hashed.
const list = spawnSync("python3", [digestScript, "--rootless", "--list"], { encoding: "utf8" });
assert.equal(list.status, 0, list.stderr);
const covered = new Set(list.stdout.trim().split("\n"));
assert(!covered.has("cli/cauce.bak-login-20260823T000500Z"),
  "ignored operator backups must not contaminate the committed operations digest");
for (const required of [
  ...operationsSources,
  "container-runtime/cauce-container-runtime.py",
  "hermes-runtime.json",
  "scripts/container-adapter-supervisor.sh",
  "scripts/alias-lock-exec.py",
  "scripts/verify-hermes-runtime.py",
  "scripts/alias-runner.sh",
  "scripts/cutover.sh",
  "scripts/create-inactive-override-manifest.py",
  "scripts/provision-terminal-client.sh",
  "scripts/provision-hermes-runtime.sh",
  "tests/test_alias_lock_exec.py",
  "tests/test_verify_hermes_runtime.py",
  "scripts/host-backup.sh",
  "scripts/host-backup-monitor.sh",
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
const aliasInventory = JSON.parse(await readFile(path.join(ops, "container-aliases.json"), "utf8")).aliases;
const representativeAlias = Object.hasOwn(aliasInventory, "operador")
  ? "operador"
  : Object.keys(aliasInventory).sort()[0];
assert(representativeAlias, "container alias inventory must not be empty");
assert(rootlessCovered.has(`generated/container-systemd/rootless/cauce-v3-container-${representativeAlias}.service`));
assert(rootlessCovered.has(`generated/container-systemd/rootless/configs/${representativeAlias}.env.example`));
assert(rootlessCovered.has("scripts/pin-container-release.py"));
const rootlessCheck = spawnSync("python3", [digestScript, "--rootless", "--check"], { encoding: "utf8" });
assert.equal(rootlessCheck.status, 0, `${rootlessCheck.stdout} ${rootlessCheck.stderr}`);
const rootless = path.join(ops, "generated/container-systemd/rootless");
/*
 * The number of units is NOT hard-coded. It was pinned at 14 and the registry grew to 15 when
 * `heraclito` was added: the test went red for the wrong reason —"14 !== 15"— when what was
 * really happening was that a registered alias was missing its unit. A hard-coded number
 * confuses "someone added an alias" with "someone forgot to generate", which are opposites.
 *
 * Tied to the registry, the test keeps catching what matters —a missing unit— and stops asking
 * to be edited every time the fleet grows.
 */
const aliasRegistrados = Object.keys(
  aliasInventory,
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
const rootlessUnit = await readFile(path.join(rootless, `cauce-v3-container-${representativeAlias}.service`), "utf8");
assert(!/^User=/mu.test(rootlessUnit), "systemd user unit must not set User=");
assert.match(rootlessUnit, /^WantedBy=default\.target$/mu);
assert.match(rootlessUnit, new RegExp(`^ExecStart=%h/\\.local/share/cauce-v3/ops/scripts/container-adapter-supervisor\\.sh start ${representativeAlias}$`, "mu"));
assert.match(rootlessUnit, /^Environment=CAUCE_CONTAINER_LOCK_ROOT=%t\/cauce-v3$/mu);
assert.match(rootlessUnit, /^RestartPreventExitStatus=2 73 78$/mu);
assert.match(rootlessUnit, /^RestartForceExitStatus=70$/mu);
const rootlessConfig = await readFile(path.join(rootless, `configs/${representativeAlias}.env.example`), "utf8");
assert.match(rootlessConfig, /^BUNDLE_RELEASE=REPLACE_WITH_IMMUTABLE_RELEASE_NAME$/mu);
assert.doesNotMatch(rootlessConfig, /^BUNDLE_CURRENT=/mu);
assert.match(rootlessConfig, new RegExp(`^PKI_DIR=/home/dev/\\.config/cauce-v3/container-pki/${representativeAlias}$`, "mu"));
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

const isolatedOpsRoot = await mkdtemp(path.join(os.tmpdir(), "cauce-isolated-ops-"));
const isolatedOutput = await mkdtemp(path.join(os.tmpdir(), "cauce-isolated-units-"));
const isolatedInventory = {
  schemaVersion: 2,
  systemPrincipals: {},
  historicalAliases: [],
  aliases: {
    "hospital-leader": {
      tenant: "Hospital",
      room: "grp.hospital",
      container: "hospital-leader",
      user: "claw",
      home: "/home/claw",
      stateDirectory: "/home/claw/.openclaw",
      harness: "openclaw",
      membershipRole: "agent_notify",
      systemdUser: "root",
      workspace: "/home/claw/.openclaw/workspace-hospital-leader",
    },
  },
};
try {
  await writeFile(path.join(isolatedOpsRoot, "container-aliases.json"),
    `${JSON.stringify(isolatedInventory)}\n`);
  const generated = spawnSync("python3", [path.join(ops, "scripts/generate-container-units.py"),
    "--ops-root", isolatedOpsRoot,
    "--output", isolatedOutput,
    "--install-prefix", "/srv/hospital-cauce",
    "--config-root", "/etc/hospital-cauce/container-aliases",
    "--pki-root", "/etc/hospital-cauce/container-pki",
    "--bundle-root", "/srv/hospital-cauce-adapter",
    "--lock-root", "/run/lock/hospital-cauce"], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const unitText = await readFile(
    path.join(isolatedOutput, "cauce-v3-container-hospital-leader.service"), "utf8",
  );
  assert.match(unitText,
    /^ConditionPathExists=\/etc\/hospital-cauce\/container-aliases\/hospital-leader\.env$/mu);
  assert.match(unitText, /^Environment=CAUCE_CONTAINER_OPS_ROOT=\/srv\/hospital-cauce\/ops$/mu);
  assert.match(unitText,
    /^Environment=CAUCE_CONTAINER_CONFIG_ROOT=\/etc\/hospital-cauce\/container-aliases$/mu);
  assert.match(unitText,
    /^Environment=CAUCE_CONTAINER_PKI_ROOT=\/etc\/hospital-cauce\/container-pki$/mu);
  assert.match(unitText,
    /^Environment=CAUCE_CONTAINER_BUNDLE_ROOT=\/srv\/hospital-cauce-adapter$/mu);
  assert.match(unitText,
    /^Environment=CAUCE_CONTAINER_LOCK_ROOT=\/run\/lock\/hospital-cauce$/mu);
  assert.match(unitText,
    /^ExecStart=\/srv\/hospital-cauce\/ops\/scripts\/container-adapter-supervisor\.sh start hospital-leader$/mu);
  assert.match(unitText,
    /^ReadOnlyPaths=\/etc\/hospital-cauce\/container-aliases \/etc\/hospital-cauce\/container-pki \/srv\/hospital-cauce \/srv\/hospital-cauce-adapter$/mu);
  assert.doesNotMatch(unitText, /\/etc\/cauce-v3|\/opt\/cauce-v3/u);

  const hermesInventory = structuredClone(isolatedInventory);
  hermesInventory.aliases["hospital-leader"].harness = "hermes";
  delete hermesInventory.aliases["hospital-leader"].workspace;
  await writeFile(path.join(isolatedOpsRoot, "container-aliases.json"),
    `${JSON.stringify(hermesInventory)}\n`);
  const missingHermesPin = spawnSync("python3", [path.join(ops, "scripts/generate-container-units.py"),
    "--ops-root", isolatedOpsRoot, "--output", isolatedOutput], { encoding: "utf8" });
  assert.notEqual(missingHermesPin.status, 0);
  assert.match(missingHermesPin.stderr, /hermes-runtime\.json/u);
} finally {
  await rm(isolatedOpsRoot, { recursive: true, force: true });
  await rm(isolatedOutput, { recursive: true, force: true });
}

process.stdout.write("container operational digest tests passed\n");
