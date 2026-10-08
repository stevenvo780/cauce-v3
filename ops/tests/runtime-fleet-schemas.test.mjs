import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(ops);
const require = createRequire(import.meta.url);
const Ajv = require(path.join(root, 'node_modules/.pnpm/node_modules/ajv/dist/2020.js'));
const yaml = require(path.join(root, 'node_modules/.pnpm/node_modules/yaml'));
const validator = new Ajv({ allErrors: true, strict: false });
const manifestSchema = validator.compile(JSON.parse(
  await readFile(path.join(ops, 'schemas/alias-manifest.schema.json'), 'utf8'),
));
const receiptSchema = validator.compile(JSON.parse(
  await readFile(path.join(ops, 'schemas/runtime-fleet-snapshot.schema.json'), 'utf8'),
));
const temporary = await mkdtemp('/var/tmp/cauce-fleet-schemas-');
try {
  const source = {
    agents: [{
      tenant_id: 'Equipo_42', alias: 'shared_alias', harness_id: 'codex', enabled: true,
      container_name: 'fixture-runtime', runtime_user: 'dev', home_directory: '/home/dev',
      state_directory: '/home/dev/.local/state/cauce-v3/physical-one',
      runtime_key: 'physical-one', primary_room_id: 'grp.primary',
    }],
    memberships: [{
      tenant_id: 'Equipo_42', alias: 'shared_alias', room_id: 'grp.primary', role: 'agent', enabled: true,
    }],
    rolePolicies: [{ role: 'agent' }],
  };
  const input = path.join(temporary, 'source.json');
  const overlay = path.join(temporary, 'placement.json');
  const state = path.join(temporary, 'state');
  await writeFile(input, JSON.stringify(source));
  await writeFile(overlay, JSON.stringify({ schemaVersion: 1, placement: {} }));
  const materialization = spawnSync('python3', [
    path.join(ops, 'scripts/materialize-fleet-runtime.py'), '--source', input,
    '--placement', overlay, '--state-directory', state,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(materialization.status, 0, materialization.stderr);
  const receipt = JSON.parse(await readFile(path.join(state, 'desired-fleet.json'), 'utf8'));
  assert(receiptSchema(receipt), JSON.stringify(receiptSchema.errors));
  const manifest = yaml.parse(await readFile(
    path.join(state, 'generations', receipt.generation, 'manifests/physical-one.yaml'), 'utf8',
  ));
  assert(manifestSchema(manifest), JSON.stringify(manifestSchema.errors));
  assert.equal(manifest.metadata.name, 'physical-one');
  assert.equal(manifest.spec.alias, 'shared_alias');
  assert.equal(manifest.spec.tenant, 'Equipo_42');
  for (const [field, value] of [['tenant', 'bad/tenant'], ['alias', 'Bad'], ['room', 'bad\nroom']]) {
    const invalid = structuredClone(manifest);
    invalid.spec[field] = value;
    assert.equal(manifestSchema(invalid), false, `${field} was accepted`);
  }
  const incomplete = structuredClone(receipt);
  delete incomplete.files['container-aliases.json'];
  assert.equal(receiptSchema(incomplete), false);
  const invalidDigest = structuredClone(receipt);
  invalidDigest.snapshotSha256 = 'bad';
  assert.equal(receiptSchema(invalidDigest), false);
  for (const room of ['room.one', 'Sala café: equipo', 'Sala\u0085equipo', 'Sala\u2028equipo']) {
    source.agents[0].primary_room_id = room;
    source.memberships[0].room_id = room;
    await writeFile(input, JSON.stringify(source));
    const generated = spawnSync('python3', [
      path.join(ops, 'scripts/materialize-fleet-runtime.py'), '--source', input,
      '--placement', overlay, '--state-directory', state,
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(generated.status, 0, generated.stderr);
    const current = JSON.parse(await readFile(path.join(state, 'desired-fleet.json'), 'utf8'));
    const parsed = yaml.parse(await readFile(
      path.join(state, 'generations', current.generation, 'manifests/physical-one.yaml'), 'utf8',
    ));
    assert.equal(parsed.spec.room, room);
    assert(manifestSchema(parsed), JSON.stringify(manifestSchema.errors));
  }
  source.agents[0].tenant_id = 'True';
  source.agents[0].alias = 'null';
  source.memberships[0].tenant_id = 'True';
  source.memberships[0].alias = 'null';
  await writeFile(input, JSON.stringify(source));
  const reserved = spawnSync('python3', [
    path.join(ops, 'scripts/materialize-fleet-runtime.py'), '--source', input,
    '--placement', overlay, '--state-directory', state,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(reserved.status, 0, reserved.stderr);
  const reservedReceipt = JSON.parse(await readFile(path.join(state, 'desired-fleet.json'), 'utf8'));
  const reservedManifest = yaml.parse(await readFile(
    path.join(state, 'generations', reservedReceipt.generation, 'manifests/physical-one.yaml'), 'utf8',
  ));
  assert.equal(reservedManifest.spec.tenant, 'True');
  assert.equal(reservedManifest.spec.alias, 'null');
  source.agents[0].enabled = false;
  source.agents[0].lifecycle_state = 'draft';
  source.agents[0].host_id = 'fixture-host';
  source.agents[0].runtime_mode = 'container';
  source.agents[0].systemd_user = 'stev';
  source.memberships[0].enabled = false;
  await writeFile(input, JSON.stringify(source));
  const bootstrap = spawnSync('python3', [
    path.join(ops, 'scripts/materialize-fleet-runtime.py'), '--source', input,
    '--placement', overlay, '--state-directory', state,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  const bootstrapReceipt = JSON.parse(await readFile(path.join(state, 'desired-fleet.json'), 'utf8'));
  assert(receiptSchema(bootstrapReceipt), JSON.stringify(receiptSchema.errors));
  const bootstrapManifest = yaml.parse(await readFile(
    path.join(state, 'generations', bootstrapReceipt.generation, 'bootstrap/manifests/physical-one.yaml'), 'utf8',
  ));
  assert.equal(bootstrapManifest.spec.bootstrap, true);
  assert.equal(bootstrapManifest.spec.admission, false);
  assert(manifestSchema(bootstrapManifest), JSON.stringify(manifestSchema.errors));
  delete bootstrapManifest.spec.admission;
  assert.equal(manifestSchema(bootstrapManifest), false, 'bootstrap must always carry admission:false');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
process.stdout.write('runtime fleet schema tests passed\n');
