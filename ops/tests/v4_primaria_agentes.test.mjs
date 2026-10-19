#!/usr/bin/env node
// cauce:requiere docker
// cauce:timeout-ms 240000
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait } from 'testcontainers';
import { tsImport } from 'tsx/esm/api';
import { loadHarnessCompatibility, parseArguments, proposePrimary, runPrimary } from '../scripts/v4_primaria_agentes.mjs';

const script = fileURLToPath(new URL('../scripts/v4_primaria_agentes.mjs', import.meta.url));
const compatibility = await loadHarnessCompatibility();
const propose = (value, revision = 0) => proposePrimary(value, revision, compatibility);
const agent = { company_id: 'humanizar', tenant_id: 'Steven', alias: 'zz-canary-primary', enabled: true, lifecycle_state: 'ready',
  primary_account_id: null, bindings: [{ account_id: 'zz-canary-account', provider: 'codex', eligible: true }],
  runtime_key: 'zz-canary-primary', harness_id: 'codex', display_name: 'Canary', primary_room_id: 'zz-canary-room',
  host_id: 'zz-canary-host', runtime_mode: 'container', container_name: 'zz-canary-container', runtime_user: 'dev',
  home_directory: '/home/dev', state_directory: '/home/dev/.cauce/zz-canary-primary', systemd_user: 'stev',
  model_id: 'gpt-6.1', reasoning_effort: 'high', extensions: [],
  memberships: [{ room_id: 'zz-canary-room', role: 'agent', enabled: true }] };

test('requires explicit apply authority and retains ambiguous and legacy proposals without guessing', () => {
  assert.equal(parseArguments([]).apply, false);
  for (const args of [['--aplicar'], ['--empresa', 'other'], ['--revision', '-1'], ['--aplicar', '--simular'], ['--wat']]) {
    assert.throws(() => parseArguments(args));
  }
  const multiple = propose({ ...agent, bindings: [...agent.bindings, { account_id: 'zz-canary-other', provider: 'codex', eligible: true }] });
  assert.equal(multiple.status, 'decide el dueño');
  assert.equal(multiple.request, undefined);
  const legacy = propose({ ...agent, host_id: null, runtime_key: null });
  assert.equal(legacy.proposed_account_id, 'zz-canary-account');
  assert.deepEqual(legacy.missing, ['runtime_key', 'host_id']);
  assert.equal(legacy.request, undefined);
  assert.equal(propose({ ...agent, system_delivery_source: true }).request, undefined);
  const disabled = propose({ ...agent, enabled: false });
  assert.equal(disabled.proposed_account_id, 'zz-canary-account');
  assert.equal(disabled.request, undefined);
  assert.equal(propose({ ...agent, lifecycle_state: 'draft' }).request, undefined);
  const first = propose(agent).request;
  assert.equal(first.idempotency_key, propose(agent, 42).request.idempotency_key);
  assert.equal(first.parameters.model_id, agent.model_id);
  assert.equal(first.parameters.reasoning_effort, agent.reasoning_effort);
  assert.deepEqual(first.parameters.memberships, agent.memberships);
});

test('filters incompatible provider bindings using the packaged native harness catalog before deciding ambiguity', () => {
  assert.deepEqual(compatibility.single_provider_harnesses, { claude: 'claude', codex: 'codex', grok: 'grok', muse: 'muse' });
  for (const harness of Object.keys(compatibility.single_provider_harnesses)) {
    const bindings = Object.keys(compatibility.single_provider_harnesses).map(provider => ({
      account_id: `zz-canary-${provider}`, provider, eligible: true,
    }));
    const result = propose({ ...agent, harness_id: harness, bindings });
    assert.equal(result.selection_applicable, true);
    assert.equal(result.proposed_account_id, `zz-canary-${harness}`);
    assert.equal(result.request.parameters.primary_account_id, `zz-canary-${harness}`);
    assert.equal(result.compatible_bindings.length, 1);
    assert.equal(result.excluded_bindings.length, 3);
    assert.equal(propose({ ...agent, harness_id: harness, bindings: bindings.filter(value => value.provider !== harness) }).proposed_account_id, null);
  }
  for (const harness of ['openclaw', 'hermes', 'opencode', 'unknown']) {
    const result = propose({ ...agent, harness_id: harness });
    assert.equal(result.status, 'decide el dueño');
    assert.equal(result.selection_applicable, false);
    assert.equal(result.request, undefined);
    assert.equal(result.proposed_account_id, null);
  }
  assert.equal(proposePrimary(agent, 0, { single_provider_harnesses: {} }).request, undefined);
  assert.equal(propose({ ...agent, enabled: false }).selection_applicable, true);
  assert.equal(propose({ ...agent, bindings: [{ ...agent.bindings[0], eligible: false }] }).selection_applicable, false);
});

test('can execute the identical script sent through stdin without requiring repository-relative imports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zz-canary-primary-stdin-'));
  try {
    mkdirSync(join(directory, 'packages/adapter-sdk'), { recursive: true });
    symlinkSync(fileURLToPath(new URL('../../packages/adapter-sdk/dist/', import.meta.url)), join(directory, 'packages/adapter-sdk/dist'), 'dir');
    symlinkSync(fileURLToPath(new URL('../../packages/protocol/', import.meta.url)), join(directory, 'packages/protocol'), 'dir');
    const result = spawnSync(process.execPath, ['--input-type=module', '-', '--help'], {
      input: `${readFileSync(script, 'utf8')}\nconsole.log(JSON.stringify(await loadHarnessCompatibility()));\n`,
      encoding: 'utf8', cwd: directory, env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /READ ONLY/u);
    assert.match(result.stdout, /detener y volver a autenticar/u);
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)).single_provider_harnesses, compatibility.single_provider_harnesses);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('PostgreSQL: default is read-only; enqueue persists, preserves parameters, deduplicates and enforces authority and CAS', { timeout: 180_000 }, async () => {
  const { arrancarPostgresDePrueba, saludDePostgresDePrueba } = await tsImport('../../tests/helpers/contenedor-de-prueba.ts', import.meta.url);
  const store = await tsImport('../../packages/store/src/index.ts', import.meta.url);
  const { seedFleetHuman } = await tsImport('../../packages/store/test/fleet-human-postgres.fixtures.ts', import.meta.url);
  const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
  const builder = new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: 'zz-canary-test-password' })
    .withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test')).withWaitStrategy(Wait.forHealthCheck());
  const container = await arrancarPostgresDePrueba(() => (network ? builder.withNetworkMode(network) : builder.withExposedPorts(5432)).start());
  const address = new URL('postgresql://placeholder/cauce_test');
  Object.assign(address, { username: 'cauce_test', password: 'zz-canary-test-password',
    hostname: network ? container.getIpAddress(network) : container.getHost(), port: String(network ? 5432 : container.getMappedPort(5432)) });
  const pool = store.createPool(address.href, { max: 2 });
  try {
    await store.applyMigrations(pool);
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('zz-canary-room','Steven')");
    await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','zz-canary-operator')");
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','zz-canary-room','zz-canary-operator','operator')");
    const subject = await seedFleetHuman(pool, 'Steven', 'zz-canary-operator');
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,
      credential_ref_kind,credential_ref,enabled) VALUES('zz-canary-account','codex','zz-canary-identity','Steven',
      'env_path','CAUCE_CANARY_ACCOUNT_PATH',true),('zz-canary-other','codex','zz-canary-other','Steven',
      'env_path','CAUCE_CANARY_OTHER_PATH',true),('zz-canary-incompatible','claude','zz-canary-incompatible','Steven',
      'env_path','CAUCE_CANARY_INCOMPATIBLE_PATH',true)`);
    await pool.query(`INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES('zz-canary-host','humanizar','Canary')`);
    await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','zz-canary-room','zz-canary-primary','agent'),
      ('Steven','zz-canary-room','zz-canary-secondary','agent')`);
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,runtime_key,primary_room_id,
      host_id,runtime_mode,container_name,runtime_user,home_directory,state_directory,systemd_user,model_id,reasoning_effort,lifecycle_state)
      VALUES('Steven','zz-canary-primary','codex','Canary',true,'zz-canary-primary','zz-canary-room','zz-canary-host',
        'container','zz-canary-container','dev','/home/dev','/home/dev/.cauce/zz-canary-primary','stev','gpt-6.1','high','ready'),
        ('Steven','zz-canary-secondary','codex','Canary',true,'zz-canary-secondary','zz-canary-room','zz-canary-host',
        'container','zz-canary-secondary','dev','/home/dev','/home/dev/.cauce/zz-canary-secondary','stev','gpt-6.1','high','ready'),
        ('Steven','zz-canary-ambiguous','codex',NULL,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'draft')`);
    await pool.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant) VALUES
      ('Steven','zz-canary-primary','zz-canary-account','Steven','Steven'),
      ('Steven','zz-canary-secondary','zz-canary-account','Steven','Steven'),
      ('Steven','zz-canary-ambiguous','zz-canary-account','Steven','Steven'),('Steven','zz-canary-ambiguous','zz-canary-other','Steven','Steven')`);
    await pool.query(`INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled) VALUES
      ('Steven','zz-canary-primary','zz-canary-account',100,true),('Steven','zz-canary-ambiguous','zz-canary-account',100,true),
      ('Steven','zz-canary-secondary','zz-canary-account',100,true),
      ('Steven','zz-canary-ambiguous','zz-canary-other',101,true)`);
    await pool.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
      VALUES('Steven','zz-canary-primary','zz-canary-incompatible','Steven','Steven');
      INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled)
      VALUES('Steven','zz-canary-primary','zz-canary-incompatible',102,true)`);
    const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM fleet_operations)::int AS operations,
      (SELECT count(*) FROM config_revisions)::int AS revisions,(SELECT count(*) FROM audit_events)::int AS audits`)).rows[0];
    const before = await counts();
    const simulated = await runPrimary({ pool, store, options: parseArguments(['--empresa', 'humanizar']) });
    assert.deepEqual(await counts(), before);
    assert.equal(simulated.operations_enqueued, 0);
    assert.equal(simulated.canonical_preview_executed, false);
    assert.equal(simulated.proposals.find(item => item.alias === 'zz-canary-ambiguous').status, 'decide el dueño');
    assert.equal(simulated.proposals.find(item => item.alias === 'zz-canary-ambiguous').enabled, false);
    const proposed = simulated.proposals.find(item => item.alias === 'zz-canary-primary');
    assert.equal(proposed.bindings.length, 2);
    assert.equal(proposed.compatible_bindings.length, 1);
    assert.equal(proposed.selection_applicable, true);
    assert.equal(proposed.proposed_account_id, 'zz-canary-account');
    const options = { apply: true, companies: ['humanizar'], actor: subject.slice(8), revision: simulated.revisions.humanizar };
    await assert.rejects(runPrimary({ pool, store, options: { ...options, revision: 999999 } }), { code: 'conflict' });
    assert.deepEqual(await counts(), before);
    await assert.rejects(runPrimary({ pool, store, options: { ...options, companies: ['praxis'] } }), { code: 'forbidden' });
    const applied = await runPrimary({ pool, store, options });
    assert.equal(applied.operations_enqueued, 1);
    assert.match(applied.proposals.find(item => item.alias === 'zz-canary-secondary').status, /diferida/u);
    const operation = (await pool.query('SELECT request,status FROM fleet_operations')).rows[0];
    assert.equal(operation.status, 'queued');
    assert.deepEqual(operation.request.parameters, proposed.request.parameters);
    assert.equal((await pool.query("SELECT primary_account_id FROM agents WHERE alias='zz-canary-primary'")).rows[0].primary_account_id, null);
    const repeated = await runPrimary({ pool, store, options: { ...options, revision: 999999 } });
    assert.equal(repeated.operations_enqueued, 0);
    assert.equal(repeated.proposals.find(item => item.alias === 'zz-canary-primary').operation.duplicate, true);
    assert.match(repeated.proposals.find(item => item.alias === 'zz-canary-secondary').status, /diferida/u);
    assert.equal((await counts()).operations, 1);
    const reader = await seedFleetHuman(pool, 'Steven', 'zz-canary-operator', null);
    await assert.rejects(runPrimary({ pool, store, options: { ...options, actor: reader.slice(8) } }), { code: 'forbidden' });
    assert.equal((await counts()).operations, 1);
  } finally { await pool.end(); await container.stop(); }
});
