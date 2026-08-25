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
const list = spawnSync("python3", [digestScript, "--list"], { encoding: "utf8" });
assert.equal(list.status, 0, list.stderr);
const covered = new Set(list.stdout.trim().split("\n"));
for (const required of [
  "container-runtime/cauce-container-runtime.py",
  "scripts/container-adapter-supervisor.sh",
  "scripts/alias-runner.sh",
  "scripts/cutover.sh",
  "scripts/cutover-rollback.sh",
  "scripts/rollback.sh",
  "scripts/pin-production-release.py",
  "scripts/create-inactive-override-manifest.py",
  "scripts/release-build.sh",
  "scripts/release-candidate.py",
  "scripts/validate-release-evidence.py",
  "scripts/validate-rollback-bridge-evidence.py",
  "scripts/migration-integrity-gate.sh",
  "scripts/reconcile-stale-console-outbox.sh",
  "scripts/bootstrap-prod-env.py",
  "scripts/provision-terminal-client.sh",
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
  "runbooks/migration-integrity.md",
  "runbooks/rollback.md",
  "config/prod.env.example",
  "config/host-backup.env.example",
  "observability/alerts.yaml",
]) {
  assert(covered.has(required), `operational digest must cover ${required}`);
}

// 2. The checked-in OPERATIONS.sha256 must match the current operational inputs.
const check = spawnSync("python3", [digestScript, "--check"], { encoding: "utf8" });
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
  "    generated_source = source / 'generated/container-systemd'",
  "    for input_path in module.operational_files(source, generated_source):",
  "        if input_path.is_relative_to(generated_source):",
  "            continue",
  "        relative = input_path.relative_to(source)",
  "        destination = root / relative",
  "        destination.parent.mkdir(parents=True, exist_ok=True)",
  "        shutil.copy2(input_path, destination)",
  "    shutil.copytree(source / 'generated/container-systemd', root / 'generated/container-systemd')",
  "    generated = root / 'generated/container-systemd'",
  "    before = module.operational_digest(root, generated)",
  "    evidence = root / 'tests/container-ops-evidence.test.mjs'",
  "    evidence.write_bytes(evidence.read_bytes() + b'\\n// isolated mutation\\n')",
  "    after = module.operational_digest(root, generated)",
  "    assert before != after, 'evidence-test mutation must change operations digest'",
  "print('evidence-test-mutation-moves-digest')",
].join("\n"), ops], { encoding: "utf8" });
assert.equal(mutationCheck.status, 0, mutationCheck.stderr);
assert.match(mutationCheck.stdout, /evidence-test-mutation-moves-digest/u);
process.stdout.write("container ops evidence mutation: operational digest changed\n");

// Rootless user units/configs have their own source-bound operational digest and
// checksum set, while the legacy system units remain available.
const rootlessList = spawnSync("python3", [digestScript, "--rootless", "--list"], { encoding: "utf8" });
assert.equal(rootlessList.status, 0, rootlessList.stderr);
const rootlessCovered = new Set(rootlessList.stdout.trim().split("\n"));
assert(rootlessCovered.has("generated/container-systemd/rootless/cauce-v3-container-kant.service"));
assert(rootlessCovered.has("generated/container-systemd/rootless/configs/kant.env.example"));
assert(rootlessCovered.has("scripts/pin-container-release.py"));
assert(rootlessCovered.has("tests/container-release-pin.test.mjs"));
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

// 3. The release build-evidence schema must require operationsDigest and the release-gate
//    evidence validator must tie it to the checked-in OPERATIONS.sha256 (not only a local autocheck).
const schema = JSON.parse(await readFile(path.join(ops, "schemas/build-evidence.schema.json"), "utf8"));
assert(schema.required.includes("operationsDigest"), "build-evidence schema must require operationsDigest");
assert(schema.properties.operationsDigest, "build-evidence schema must define operationsDigest");
const evidence = await readFile(path.join(ops, "scripts/validate-release-evidence.py"), "utf8");
assert(evidence.includes("operationsDigest") && evidence.includes("OPERATIONS.sha256"),
  "release evidence validation must tie operationsDigest to the checked-in OPERATIONS.sha256");

// 4. Functional: the schema actually rejects build evidence that omits operationsDigest.
const schemaCheck = spawnSync("python3", ["-c", [
  "import json, sys",
  "from jsonschema import Draft202012Validator",
  "schema = json.load(open(sys.argv[1]))",
  "v = Draft202012Validator(schema)",
  "digest = 'sha256:' + '0'*64",
  "other = 'sha256:' + '1'*64",
  "base = {",
  // schemaVersion 5 additionally binds a clean committed RC and recoverable registry digests.
  "  'schemaVersion':5,'evidenceClass':'release-build','mechanism':'docker-build-push-pull-final-image',",
  "  'imageDigest':digest,'sourceDigest':digest,'sourceDigestDomain':'runtime','operationsDigest':digest,",
  "  'timestamps':{'startedAt':'2026-01-01T00:00:00Z','finishedAt':'2026-01-01T00:01:00Z'},",
  "  'dockerfileSha256':digest,'dockerignoreSha256':digest,",
  "  'sourceRevision':{'commit':'a'*40,'tree':'b'*40,'worktreeStatus':'tracked-and-index-clean','untrackedPolicy':'only-apps-console-src-features-grafo','excludedUntrackedPresent':True,'buildContext':'git-archive'},",
  "  'runtime':{'tag':'registry.invalid/cauce/runtime:rc-'+'a'*40,'imageId':digest,'imageDigest':digest,'repositoryDigest':'registry.invalid/cauce/runtime@'+digest,'sourceDigest':digest,'sourceDigestDomain':'runtime'},",
  "  'console':{'tag':'registry.invalid/cauce/console:rc-'+'a'*40,'imageId':digest,'imageDigest':digest,'repositoryDigest':'registry.invalid/cauce/console@'+other,'sourceDigest':other,'sourceDigestDomain':'console'},",
  "  'runtimePackage':{'mechanism':'docker-run-final-image-package-smoke','status':'passed','components':['gateway','dispatcher','relay-worker','telegram-bridge','shadow-router','terminal-relay','outbox-metrics']},",
  "  'schemaCompatibility':{'label':'io.cauce.schema.compatible-through','compatibleThrough':'029_reconcile_declared_fleet.sql'},",
  "}",
  "assert v.is_valid(base), 'complete evidence must validate'",
  "missing = {k:val for k,val in base.items() if k!='operationsDigest'}",
  "assert not v.is_valid(missing), 'evidence missing operationsDigest must be rejected'",
  "undeclared = {k:val for k,val in base.items() if k!='sourceDigestDomain'}",
  "assert not v.is_valid(undeclared), 'evidence that does not declare its source domain must be rejected'",
  "unbound = json.loads(json.dumps(base)); del unbound['console']['sourceDigest']",
  "assert not v.is_valid(unbound), 'the console image must carry its own source digest'",
  "local_only = json.loads(json.dumps(base)); del local_only['runtime']['repositoryDigest']",
  "assert not v.is_valid(local_only), 'a local image ID without a registry digest must be rejected'",
  "dirty = json.loads(json.dumps(base)); dirty['sourceRevision']['worktreeStatus']='dirty'",
  "assert not v.is_valid(dirty), 'dirty RC evidence must be rejected'",
  "print('schema-enforced')",
].join("\n"), path.join(ops, "schemas/build-evidence.schema.json")], { encoding: "utf8" });
assert.equal(schemaCheck.status, 0, `${schemaCheck.stdout} ${schemaCheck.stderr}`);
assert.match(schemaCheck.stdout, /schema-enforced/);

// 5. A candidate is release-ready only when the live host gate shape passed;
//    the ordinary workspace candidate must remain explicitly blocked.
const candidateSchemaCheck = spawnSync("python3", ["-c", [
  "import copy, json, sys",
  "from jsonschema import Draft202012Validator",
  "schema = json.load(open(sys.argv[1]))",
  "v = Draft202012Validator(schema)",
  "digest = 'sha256:' + '0'*64",
  "check = {'name':'verified','status':'passed','evidenceKind':'release-build'}",
  "artifact = {'kind':'release-build','path':'ops/artifacts/release/build.json','sha256':'1'*64,'sourceDigest':digest,'sourceDigestDomain':'runtime'}",
  "base = {'schemaVersion':2,'suite':'cauce-v3-release-candidate','sourceDigest':digest,'sourceDigestDomain':'full','sourceDigests':{'runtime':digest,'console':digest,'harness':digest,'full':digest},'generatedAt':'2026-01-01T00:00:00Z','fleet':{'manifests':15,'packagedAdapters':5},'gates':{'codeRuntime':{'status':'passed','criticalSkipped':0,'checks':[check]*7}},'evidence':[artifact]*7}",
  "blocked = copy.deepcopy(base); blocked['candidateStatus']='code-runtime-passed-release-host-blocked'; blocked['gates']['releaseHost']={'status':'blocked','reason':'external host required','prerequisites':[{'id':f'pre-{i}','status':'required-external','description':'required'} for i in range(6)]}",
  "assert v.is_valid(blocked), list(v.iter_errors(blocked))",
  "ready = copy.deepcopy(base); ready['candidateStatus']='release-ready'; ready['gates']['releaseHost']={'status':'passed','criticalSkipped':0,'checks':[check]*4+[{'name':'durable rollback baseline recovered exact bridge runtime and console image IDs','status':'passed','evidenceKind':'release-build'}]}",
  "assert v.is_valid(ready), list(v.iter_errors(ready))",
  "dishonest = copy.deepcopy(blocked); dishonest['candidateStatus']='release-ready'",
  "assert not v.is_valid(dishonest), 'release-ready with a blocked host gate must fail'",
  "dishonest = copy.deepcopy(ready); dishonest['candidateStatus']='code-runtime-passed-release-host-blocked'",
  "assert not v.is_valid(dishonest), 'blocked status with a passing host gate must fail'",
  "print('candidate-schema-enforced')",
].join("\n"), path.join(ops, "schemas/release-candidate.schema.json")], { encoding: "utf8" });
assert.equal(candidateSchemaCheck.status, 0, `${candidateSchemaCheck.stdout} ${candidateSchemaCheck.stderr}`);
assert.match(candidateSchemaCheck.stdout, /candidate-schema-enforced/);

process.stdout.write("container operational digest evidence tests passed\n");
