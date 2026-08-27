#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ops = path.join(root, "ops");
const scripts = path.join(root, "_legado/ops-scripts");

const schema = JSON.parse(await readFile(path.join(ops, "schemas/build-evidence.schema.json"), "utf8"));
assert(schema.required.includes("operationsDigest"), "build-evidence schema must require operationsDigest");
assert(schema.properties.operationsDigest, "build-evidence schema must define operationsDigest");
assert(schema.required.includes("baseImages"), "build-evidence schema must require immutable base images");
assert(schema.properties.baseImages, "build-evidence schema must define immutable base images");
const evidence = await readFile(path.join(scripts, "validate-release-evidence.py"), "utf8");
assert(evidence.includes("operationsDigest") && evidence.includes("OPERATIONS.sha256"),
  "release evidence validation must tie operationsDigest to the checked-in OPERATIONS.sha256");
const releaseGate = await readFile(path.join(scripts, "release-gate.sh"), "utf8");
for (const required of [
  "Descriptor", "io.cauce.target-platform", "io.cauce.base.node.repository-digest",
  "io.cauce.base.python.repository-digest", "io.cauce.base.nginx.repository-digest",
]) {
  assert(releaseGate.includes(required), `release gate must re-attest final image field: ${required}`);
}
const releaseCandidate = await readFile(path.join(scripts, "release-candidate.py"), "utf8");
assert(releaseCandidate.includes('pin_command.extend(("--lock-fd", str(transition_lock_fd)))')
  && releaseCandidate.includes('pin_run_options["pass_fds"] = (transition_lock_fd,)'),
"release-host candidate must preserve the authenticated transition lock for final pin admission");

const schemaCheck = spawnSync("python3", ["-c", [
  "import json, sys",
  "from jsonschema import Draft202012Validator",
  "schema = json.load(open(sys.argv[1]))",
  "v = Draft202012Validator(schema)",
  "digest = 'sha256:' + '0'*64",
  "other = 'sha256:' + '1'*64",
  "third = 'sha256:' + '2'*64",
  "runtime_manifest = 'sha256:' + '3'*64",
  "console_manifest = 'sha256:' + '4'*64",
  "media = 'application/vnd.oci.image.manifest.v1+json'",
  "platform = {'os':'linux','architecture':'amd64'}",
  "base = {",
  "  'schemaVersion':7,'evidenceClass':'release-build','mechanism':'docker-build-push-pull-final-image',",
  "  'imageDigest':digest,'sourceDigest':digest,'sourceDigestDomain':'runtime','operationsDigest':digest,",
  "  'timestamps':{'startedAt':'2026-01-01T00:00:00Z','finishedAt':'2026-01-01T00:01:00Z'},",
  "  'dockerfileSha256':digest,'dockerignoreSha256':digest,",
  "  'sourceRevision':{'commit':'a'*40,'tree':'b'*40,'worktreeStatus':'tracked-and-index-clean','untrackedPolicy':'only-apps-console-src-features-grafo','excludedUntrackedPresent':True,'buildContext':'git-archive'},",
  "  'baseImages':{",
  "    'node':{'role':'node','repositoryDigest':'docker.io/library/node@'+digest,'manifestDigest':digest,'mediaType':media,'platform':platform,'imageId':digest},",
  "    'python':{'role':'python','repositoryDigest':'docker.io/library/python@'+other,'manifestDigest':other,'mediaType':media,'platform':platform,'imageId':other},",
  "    'nginx':{'role':'nginx','repositoryDigest':'docker.io/nginxinc/nginx-unprivileged@'+third,'manifestDigest':third,'mediaType':media,'platform':platform,'imageId':third}},",
  "  'runtime':{'tag':'registry.invalid/cauce/runtime:rc-'+'a'*40,'imageId':digest,'imageDigest':digest,'repositoryDigest':'registry.invalid/cauce/runtime@'+runtime_manifest,'manifestDigest':runtime_manifest,'mediaType':media,'platform':platform,'sourceDigest':digest,'sourceDigestDomain':'runtime'},",
  "  'console':{'tag':'registry.invalid/cauce/console:rc-'+'a'*40,'imageId':other,'imageDigest':other,'repositoryDigest':'registry.invalid/cauce/console@'+console_manifest,'manifestDigest':console_manifest,'mediaType':media,'platform':platform,'sourceDigest':other,'sourceDigestDomain':'console','publishJournalCapability':'multi-intent-v1'},",
  "  'runtimePackage':{'mechanism':'docker-run-final-image-package-smoke','status':'passed','components':['gateway','dispatcher','relay-worker','telegram-bridge','shadow-router','terminal-relay','outbox-metrics']},",
  "  'schemaCompatibility':{'label':'io.cauce.schema.compatible-through','compatibleThrough':'037_console_publish_intent_indexes.sql'},",
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
  "mutable_base = json.loads(json.dumps(base)); mutable_base['baseImages']['node']['repositoryDigest']='node:22-alpine'",
  "assert not v.is_valid(mutable_base), 'a mutable build base must be rejected'",
  "multiarch = json.loads(json.dumps(base)); multiarch['baseImages']['node']['mediaType']='application/vnd.oci.image.index.v1+json'",
  "assert not v.is_valid(multiarch), 'a multiarch index must be rejected'",
  "wrong_role = json.loads(json.dumps(base)); wrong_role['baseImages']['python']['role']='node'",
  "assert not v.is_valid(wrong_role), 'a base in the wrong role must be rejected'",
  "wrong_platform = json.loads(json.dumps(base)); wrong_platform['runtime']['platform']['architecture']='arm64'",
  "assert not v.is_valid(wrong_platform), 'a non-amd64 final image must be rejected'",
  "dirty = json.loads(json.dumps(base)); dirty['sourceRevision']['worktreeStatus']='dirty'",
  "assert not v.is_valid(dirty), 'dirty RC evidence must be rejected'",
  "print('schema-enforced')",
].join("\n"), path.join(ops, "schemas/build-evidence.schema.json")], { encoding: "utf8" });
assert.equal(schemaCheck.status, 0, `${schemaCheck.stdout} ${schemaCheck.stderr}`);
assert.match(schemaCheck.stdout, /schema-enforced/);

const semanticBuildCheck = spawnSync("python3", ["-c", [
  "import ast, copy, pathlib, sys",
  "media = 'application/vnd.oci.image.manifest.v1+json'",
  "platform = {'os':'linux','architecture':'amd64'}",
  "def digest(char): return 'sha256:' + char*64",
  "base = {",
  "  'baseImages':{",
  "    'node':{'role':'node','repositoryDigest':'docker.io/library/node@'+digest('1'),'manifestDigest':digest('1'),'mediaType':media,'platform':platform,'imageId':digest('a')},",
  "    'python':{'role':'python','repositoryDigest':'docker.io/library/python@'+digest('2'),'manifestDigest':digest('2'),'mediaType':media,'platform':platform,'imageId':digest('b')},",
  "    'nginx':{'role':'nginx','repositoryDigest':'docker.io/nginxinc/nginx-unprivileged@'+digest('3'),'manifestDigest':digest('3'),'mediaType':media,'platform':platform,'imageId':digest('c')}},",
  "  'runtime':{'repositoryDigest':'registry.invalid/cauce/runtime@'+digest('4'),'manifestDigest':digest('4'),'mediaType':media,'platform':platform},",
  "  'console':{'repositoryDigest':'registry.invalid/cauce/console@'+digest('5'),'manifestDigest':digest('5'),'mediaType':media,'platform':platform},",
  "}",
  "for source_path in sys.argv[1:]:",
  "  tree = ast.parse(pathlib.Path(source_path).read_text(encoding='utf-8'))",
  "  definition = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'validate_platform_evidence')",
  "  module = ast.Module(body=[definition], type_ignores=[]); ast.fix_missing_locations(module)",
  "  namespace = {'ERRORS': [], 'BASE_REPOSITORIES': {'node':'docker.io/library/node','python':'docker.io/library/python','nginx':'docker.io/nginxinc/nginx-unprivileged'}, 'SINGLE_MANIFEST_MEDIA_TYPES': {media}, 'LINUX_AMD64': platform}",
  "  exec(compile(module, source_path, 'exec'), namespace)",
  "  validate = namespace['validate_platform_evidence']; errors = namespace['ERRORS']",
  "  validate(copy.deepcopy(base)); assert not errors, errors",
  "  for mutate in ('fake-id','same-manifest','wrong-role','index','platform'):",
  "    errors.clear(); candidate = copy.deepcopy(base)",
  "    if mutate == 'fake-id': candidate['baseImages']['python']['imageId'] = candidate['baseImages']['node']['imageId']",
  "    if mutate == 'same-manifest': candidate['baseImages']['python']['manifestDigest'] = candidate['baseImages']['node']['manifestDigest']; candidate['baseImages']['python']['repositoryDigest'] = 'docker.io/library/python@' + candidate['baseImages']['node']['manifestDigest']",
  "    if mutate == 'wrong-role': candidate['baseImages']['python']['role'] = 'node'",
  "    if mutate == 'index': candidate['baseImages']['node']['mediaType'] = 'application/vnd.oci.image.index.v1+json'",
  "    if mutate == 'platform': candidate['console']['platform']['architecture'] = 'arm64'",
  "    validate(candidate); assert errors, f'{source_path} accepted {mutate}'",
  "print('semantic-build-evidence-enforced')",
].join("\n"),
path.join(scripts, "validate-release-evidence.py"),
path.join(scripts, "release-candidate.py")], { encoding: "utf8" });
assert.equal(semanticBuildCheck.status, 0, semanticBuildCheck.stderr);
assert.match(semanticBuildCheck.stdout, /semantic-build-evidence-enforced/);

const candidateSchemaCheck = spawnSync("python3", ["-c", [
  "import copy, json, sys",
  "from jsonschema import Draft202012Validator",
  "schema = json.load(open(sys.argv[1]))",
  "v = Draft202012Validator(schema)",
  "digest = 'sha256:' + '0'*64",
  "check = {'name':'verified','status':'passed','evidenceKind':'release-build'}",
  "artifact = {'kind':'release-build','path':'ops/artifacts/release/build.json','sha256':'1'*64,'sourceDigest':digest,'sourceDigestDomain':'runtime'}",
  "base = {'schemaVersion':2,'suite':'cauce-v3-release-candidate','sourceDigest':digest,'sourceDigestDomain':'full','sourceDigests':{'runtime':digest,'console':digest,'harness':digest,'testcontainers':digest,'verification':digest,'full':digest},'generatedAt':'2026-01-01T00:00:00Z','fleet':{'manifests':15,'packagedAdapters':5},'gates':{'codeRuntime':{'status':'passed','criticalSkipped':0,'checks':[check]*7}},'evidence':[artifact]*7}",
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

process.stdout.write("legacy container release evidence tests passed\n");
