import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const producer = join(repository, 'ops/scripts/produce-rollback-bridge-evidence.py');
const scratch: string[] = [];
const postgresProbeUser = 'cauce_bridge_probe';
const postgresProbeDatabase = 'cauce_bridge_probe';
let postgresProbeContainer: StartedTestContainer | undefined;

async function sharedPostgresProbe(): Promise<StartedTestContainer> {
  if (postgresProbeContainer !== undefined) return postgresProbeContainer;
  postgresProbeContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: postgresProbeUser,
      POSTGRES_PASSWORD: 'test-only-password',
      POSTGRES_DB: postgresProbeDatabase,
    })
    .withExposedPorts(5432)
    .withHealthCheck({
      test: ['CMD-SHELL', `pg_isready -U ${postgresProbeUser} -d ${postgresProbeDatabase}`],
      interval: 1_000,
      timeout: 3_000,
      retries: 60,
      startPeriod: 1_000,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();
  return postgresProbeContainer;
}

afterAll(async () => {
  const container = postgresProbeContainer;
  postgresProbeContainer = undefined;
  if (container !== undefined) await container.stop();
});

const loadProducer = String.raw`
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("rollback_bridge_producer", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`;

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('rollback bridge evidence producer', () => {
  test('all default child processes use one canonical Docker authority', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import os, subprocess
os.environ.update({
    'DOCKER_HOST': 'tcp://poison.invalid:2376',
    'DOCKER_CONTEXT': 'poison-context',
    'DOCKER_CONFIG': '/tmp/poison-config',
    'DOCKER_TLS_VERIFY': '1',
    'COMPOSE_FILE': '/tmp/poison-compose.yaml',
})
observed = {}
def fake_run(arguments, **kwargs):
    observed.update(kwargs['env'])
    return subprocess.CompletedProcess(arguments, 0, stdout=b'', stderr=b'')
module.subprocess.run = fake_run
module.run_checked(['docker', 'version'], phase='fixture')
assert observed['DOCKER_HOST'] == 'unix:///var/run/docker.sock'
assert observed['DOCKER_CONFIG'].endswith('/.docker')
assert observed['DOCKER_CONFIG'] != '/tmp/poison-config'
assert 'DOCKER_CONTEXT' not in observed
assert 'DOCKER_TLS_VERIFY' not in observed
assert 'COMPOSE_FILE' not in observed
assert 'poison' not in repr(observed)
print('canonical-docker-authority')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('canonical-docker-authority\n');
  });

  test('the checked-in topology is exactly three services on one internal network', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}\nmodule.validate_compose_source()`, producer], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('atomically publishes private evidence and an exact private SHA sidecar without overwrite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-bridge-producer-'));
    scratch.push(directory);
    await chmod(directory, 0o700);
    const output = join(directory, 'bridge.json');
    const result = spawnSync('python3', ['-c', `${loadProducer}
output = pathlib.Path(sys.argv[2])
digest = module.atomic_publish(output, b'{"safe":true}' + bytes([10]))
print(digest)
try:
    module.atomic_publish(output, b'changed' + bytes([10]))
except module.ProductionError:
    print('overwrite-rejected')
else:
    raise SystemExit('overwrite was accepted')
`, producer, output], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^sha256:[a-f0-9]{64}\noverwrite-rejected\n$/u);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect((await stat(`${output}.sha256`)).mode & 0o777).toBe(0o600);
    expect(await readFile(output, 'utf8')).toBe('{"safe":true}\n');
    expect(await readFile(`${output}.sha256`, 'utf8')).toBe(`${result.stdout.split('\n')[0]}\n`);
  });

  test('rejects broad or linked backup inputs without disclosing their bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-bridge-input-'));
    scratch.push(directory);
    const secret = join(directory, 'backup.dump');
    const linked = join(directory, 'linked.dump');
    await writeFile(secret, 'DO-NOT-PRINT-BACKUP-CONTENT', { mode: 0o640 });
    await chmod(secret, 0o640);
    await symlink(secret, linked);
    const result = spawnSync('python3', ['-c', `${loadProducer}
for raw in sys.argv[2:]:
    try:
        module.private_digest(pathlib.Path(raw), 'backup')
    except module.ProductionError:
        print('rejected')
    else:
        raise SystemExit('unsafe input was accepted')
`, producer, secret, linked], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('rejected\nrejected\n');
    expect(result.stdout + result.stderr).not.toContain('DO-NOT-PRINT');
  });

  test('requires a fresh, bounded restore verification timestamp', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import datetime as dt
backup = pathlib.Path('/private/authorized.dump')
digest = 'sha256:' + ('a' * 64)
now = dt.datetime(2026, 8, 26, 12, 0, tzinfo=dt.timezone.utc)
base = {
    'schema_version': 1,
    'suite': 'cauce-v3-host-backup-restore',
    'isolated': True,
    'network': 'none',
    'full_restore': True,
    'dump_file': backup.name,
    'dump_sha256': 'a' * 64,
    'database_image_digest': 'sha256:' + ('b' * 64),
    'core_table_count': 8,
    'applied_migration_count': 1,
    'verified_at_utc': '2026-08-26T11:59:00Z',
}
identity = module.verify_restore_input(backup, digest, base, digest, now=now)
assert identity['verifiedAt'] == base['verified_at_utc']
for timestamp in ('2026-08-25T04:59:59Z', '2026-08-26T12:05:01Z', 'invalid'):
    changed = dict(base, verified_at_utc=timestamp)
    try:
        module.verify_restore_input(backup, digest, changed, digest, now=now)
    except module.ProductionError:
        pass
    else:
        raise SystemExit('unsafe restore timestamp accepted: ' + timestamp)
missing = dict(base)
del missing['verified_at_utc']
try:
    module.verify_restore_input(backup, digest, missing, digest, now=now)
except module.ProductionError:
    print('restore-time-policy-enforced')
else:
    raise SystemExit('missing restore timestamp accepted')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('restore-time-policy-enforced\n');
  });

  test('pull=0 never downloads and both modes reject non-child or foreign-platform images', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import json, os, subprocess
reference = 'registry.invalid/cauce/runtime@sha256:' + ('a' * 64)
identifier = 'sha256:' + ('b' * 64)
labels = {'io.cauce.target-platform': 'linux/amd64'}
base = {
    'Id': identifier,
    'RepoDigests': [reference],
    'Descriptor': {
        'digest': reference.rsplit('@', 1)[1],
        'mediaType': 'application/vnd.oci.image.manifest.v1+json',
    },
    'Os': 'linux',
    'Architecture': 'amd64',
    'Config': {'Labels': labels},
}
calls = []
def checked(arguments, **kwargs):
    calls.append(arguments)
    output = json.dumps([base]).encode() if arguments[:3] == ['docker', 'image', 'inspect'] else b''
    return subprocess.CompletedProcess(arguments, 0, stdout=output, stderr=b'')
module.run_checked = checked
identity = module.verify_recovered_image(
    reference, identifier, 'fixture', pull_enabled=False, expected_labels=labels,
)
assert identity['manifestDigest'] == reference.rsplit('@', 1)[1]
assert all(arguments[:2] != ['docker', 'pull'] for arguments in calls)
calls.clear()
module.verify_recovered_image(reference, identifier, 'fixture', pull_enabled=True, expected_labels=labels)
assert calls[0] == ['docker', 'pull', '--platform', 'linux/amd64', reference]
for changed in (
    {**base, 'Descriptor': {**base['Descriptor'], 'mediaType': 'application/vnd.oci.image.index.v1+json'}},
    {**base, 'Architecture': 'arm64'},
):
    def invalid_checked(arguments, **kwargs):
        return subprocess.CompletedProcess(arguments, 0, stdout=json.dumps([changed]).encode(), stderr=b'')
    module.run_checked = invalid_checked
    try:
        module.verify_recovered_image(reference, identifier, 'fixture', pull_enabled=False)
    except module.ProductionError:
        pass
    else:
        raise SystemExit('invalid image identity was accepted')
os.environ['CAUCE_BRIDGE_PULL'] = 'invalid'
try:
    module.pull_mode()
except module.ProductionError:
    print('pull-policy-enforced')
else:
    raise SystemExit('invalid pull policy was accepted')
common = {
    'context': pathlib.Path('/isolated/context'),
    'tag': 'registry.invalid/cauce/bridge:fixture',
    'node_base': 'docker.io/library/node@sha256:' + ('1' * 64),
    'python_base': 'docker.io/library/python@sha256:' + ('2' * 64),
    'source_digest': 'sha256:' + ('3' * 64),
    'bridge_tree': '4' * 40,
    'patch_digest': 'sha256:' + ('5' * 64),
    'patch_commit': '6' * 40,
}
offline = module.bridge_build_command(**common, pull_enabled=False)
assert offline[:4] == ['docker', 'build', '--platform', 'linux/amd64']
assert '--pull' not in offline
assert 'CAUCE_PYTHON_BASE=' + common['python_base'] in offline
assert 'CAUCE_TARGET_PLATFORM=linux/amd64' in offline
assert 'io.cauce.rollback-bridge.read-only=server-v2' in offline
online = module.bridge_build_command(**common, pull_enabled=True)
assert online[:5] == ['docker', 'build', '--pull', '--platform', 'linux/amd64']
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('pull-policy-enforced\n');
  });

  test('accepts only a candidate build accredited through the exact target schema', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
image = 'registry.invalid/cauce/runtime@sha256:' + ('a' * 64)
image_id = 'sha256:' + ('b' * 64)
source = 'sha256:' + ('c' * 64)
commit = 'd' * 40
base = 'registry.invalid/library/base@sha256:' + ('e' * 64)
python = 'registry.invalid/library/python@sha256:' + ('f' * 64)
evidence = {
    'sourceRevision': {'commit': commit, 'tree': '1' * 40},
    'runtime': {
        'repositoryDigest': image, 'imageId': image_id, 'sourceDigest': source,
        'manifestDigest': image.rsplit('@', 1)[1],
        'mediaType': 'application/vnd.oci.image.manifest.v1+json',
        'platform': {'os': 'linux', 'architecture': 'amd64'},
    },
    'imageDigest': image_id, 'sourceDigest': source,
    'schemaCompatibility': {'compatibleThrough': module.TARGET_SCHEMA},
    'baseImages': {'node': {'repositoryDigest': base}, 'python': {'repositoryDigest': python}},
}
module.validate_schema = lambda *args: None
accepted = module.verify_candidate_evidence(evidence, expected_image=image, expected_commit=commit)
assert accepted['expectedLabels']['io.cauce.schema.compatible-through'] == module.TARGET_SCHEMA
for obsolete in (
    '029_reconcile_declared_fleet.sql', '030_dlq_causal_reconciliation.sql',
    '031_connection_session_fencing.sql', '032_terminal_session_claim_fencing.sql',
    '033_terminal_browser_owner_fencing.sql', '034_terminal_relay_instance_fencing.sql',
    '035_agent_profile_runtime_adoption.sql', '036_shadow_router_target_phase.sql',
):
    evidence['schemaCompatibility']['compatibleThrough'] = obsolete
    try:
        module.verify_candidate_evidence(evidence, expected_image=image, expected_commit=commit)
    except module.ProductionError:
        pass
    else:
        raise SystemExit('obsolete candidate schema accepted: ' + obsolete)
print('target-schema-only')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('target-schema-only\n');
  });

  test('requires the exact schema-031 UUID fencing column and one distinct token per lease', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import json
cycle = module.IsolatedCycle.__new__(module.IsolatedCycle)
valid = {
    'migration': module.CONNECTION_FENCING_SCHEMA,
    'table': 'connection_leases',
    'column': 'connection_token',
    'dataType': 'uuid',
    'nullable': 'NO',
    'totalLeaseCount': 2,
    'nonNullTokenCount': 2,
    'distinctTokenCount': 2,
    'nullTokenCount': 0,
}
cycle.psql = lambda *args, **kwargs: json.dumps(valid).encode()
assert cycle.connection_fencing() == valid
for field, value in (
    ('dataType', 'text'),
    ('nullable', 'YES'),
    ('nonNullTokenCount', 1),
    ('distinctTokenCount', 1),
    ('nullTokenCount', 1),
):
    changed = dict(valid, **{field: value})
    cycle.psql = lambda *args, payload=changed, **kwargs: json.dumps(payload).encode()
    try:
        cycle.connection_fencing()
    except module.ProductionError:
        pass
    else:
        raise SystemExit('invalid connection fencing accepted: ' + field)
print('schema031-fencing-exact')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('schema031-fencing-exact\n');
  });

  test('requires schema-032 claim shape, a fully drained PTY set and a rolled-back CAS probe', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import json
cycle = module.IsolatedCycle.__new__(module.IsolatedCycle)
valid = {
    'migration': module.TERMINAL_CLAIM_FENCING_SCHEMA,
    'table': 'terminal_sessions',
    'constraint': 'terminal_sessions_relay_claim_shape',
    'columnsExact': True,
    'epochDefaultExact': True,
    'constraintExact': True,
    'openTerminalSessionCount': 0,
    'legacyOpenSessionCount': 0,
}
def psql(sql, *args, **kwargs):
    if sql == module.TERMINAL_CLAIM_CAS_SQL:
        return b'0\\n'
    return json.dumps(valid).encode()
cycle.psql = psql
observed = cycle.terminal_claim_fencing()
assert observed['claimCas'] == 'passed'
assert observed['staleCloseNoop'] == 'passed'
for field, value in (
    ('columnsExact', False),
    ('constraintExact', False),
    ('openTerminalSessionCount', 1),
    ('legacyOpenSessionCount', 1),
):
    changed = dict(valid, **{field: value})
    cycle.psql = lambda *args, payload=changed, **kwargs: json.dumps(payload).encode()
    try:
        cycle.terminal_claim_fencing()
    except module.ProductionError:
        pass
    else:
        raise SystemExit('invalid terminal claim fencing accepted: ' + field)
calls = 0
def not_rolled_back(sql, *args, **kwargs):
    global calls
    calls += 1
    return json.dumps(valid).encode() if calls == 1 else b'1\\n'
cycle.psql = not_rolled_back
try:
    cycle.terminal_claim_fencing()
except module.ProductionError:
    pass
else:
    raise SystemExit('non-rolled-back terminal claim probe accepted')
print('schema032-terminal-claim-exact')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('schema032-terminal-claim-exact\n');
  });

  test('requires schema-033 request uniqueness, owner CAS and stale DELETE fencing', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import json
cycle = module.IsolatedCycle.__new__(module.IsolatedCycle)
valid = {
    'migration': module.BROWSER_OWNER_FENCING_SCHEMA,
    'table': 'terminal_sessions',
    'constraint': 'terminal_sessions_browser_owner_shape',
    'requestIndex': 'terminal_sessions_request_id_idx',
    'columnsExact': True,
    'constraintExact': True,
    'requestUniqueExact': True,
    'openTerminalSessionCount': 0,
    'invalidStoredFenceCount': 0,
    'rawOwnerColumnCount': 0,
}
def psql(sql, *args, **kwargs):
    if sql == module.BROWSER_OWNER_CAS_SQL:
        return b'0\\n'
    return json.dumps(valid).encode()
cycle.psql = psql
observed = cycle.browser_owner_fencing()
assert observed['exactPostRecoveryNoRotation'] == 'passed'
assert observed['staleDeleteNoop'] == 'passed'
for field, value in (
    ('columnsExact', False),
    ('requestUniqueExact', False),
    ('openTerminalSessionCount', 1),
    ('invalidStoredFenceCount', 1),
    ('rawOwnerColumnCount', 1),
):
    changed = dict(valid, **{field: value})
    cycle.psql = lambda *args, payload=changed, **kwargs: json.dumps(payload).encode()
    try:
        cycle.browser_owner_fencing()
    except module.ProductionError:
        pass
    else:
        raise SystemExit('invalid browser owner fencing accepted: ' + field)
print('schema033-browser-owner-exact')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('schema033-browser-owner-exact\n');
  });

  test('requires schema-034 relay pinning, boot fencing and a rolled-back CAS probe', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import json
cycle = module.IsolatedCycle.__new__(module.IsolatedCycle)
valid = {
    'migration': module.RELAY_INSTANCE_FENCING_SCHEMA,
    'table': 'terminal_sessions',
    'constraint': 'terminal_sessions_relay_instance_shape',
    'columnsExact': True,
    'constraintExact': True,
    'usableTerminalSessionCount': 0,
    'legacyUsableSessionCount': 0,
    'invalidStoredFenceCount': 0,
}
def psql(sql, *args, **kwargs):
    if sql == module.RELAY_INSTANCE_CAS_SQL:
        return b'0\\n'
    return json.dumps(valid).encode()
cycle.psql = psql
observed = cycle.relay_instance_fencing()
assert observed['pinnedInstanceClaim'] == 'passed'
assert observed['staleBootCloseNoop'] == 'passed'
for field, value in (
    ('columnsExact', False),
    ('constraintExact', False),
    ('usableTerminalSessionCount', 1),
    ('legacyUsableSessionCount', 1),
    ('invalidStoredFenceCount', 1),
):
    changed = dict(valid, **{field: value})
    cycle.psql = lambda *args, payload=changed, **kwargs: json.dumps(payload).encode()
    try:
        cycle.relay_instance_fencing()
    except module.ProductionError:
        pass
    else:
        raise SystemExit('invalid relay instance fencing accepted: ' + field)
calls = 0
def not_rolled_back(sql, *args, **kwargs):
    global calls
    calls += 1
    return json.dumps(valid).encode() if calls == 1 else b'1\\n'
cycle.psql = not_rolled_back
try:
    cycle.relay_instance_fencing()
except module.ProductionError:
    pass
else:
    raise SystemExit('non-rolled-back relay instance probe accepted')
print('schema034-relay-instance-exact')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('schema034-relay-instance-exact\n');
  });

  test('executes the exact schema-034 relay CAS probe transaction in PostgreSQL 16', async () => {
    const container = await sharedPostgresProbe();
      const [migration032, migration033, migration034] = await Promise.all([
        readFile(join(repository, 'packages/store/migrations/032_terminal_session_claim_fencing.sql'), 'utf8'),
        readFile(join(repository, 'packages/store/migrations/033_terminal_browser_owner_fencing.sql'), 'utf8'),
        readFile(join(repository, 'packages/store/migrations/034_terminal_relay_instance_fencing.sql'), 'utf8'),
      ]);
      const initialized = await container.exec([
        'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', postgresProbeUser,
        '-d', postgresProbeDatabase, '-c',
        `CREATE EXTENSION IF NOT EXISTS pgcrypto;
         CREATE TABLE terminal_sessions(
           id uuid PRIMARY KEY,
           operator_id text NOT NULL,
           attributed boolean NOT NULL,
           console_subject text,
           tenant_id text,
           alias text,
           container text NOT NULL,
           runtime_user text NOT NULL,
           mode text NOT NULL,
           ticket_sha256 bytea NOT NULL,
           reason text NOT NULL,
           trace_id text NOT NULL,
           expires_at timestamptz NOT NULL,
           consumed_at timestamptz,
           revoked_at timestamptz,
           closed_at timestamptz,
           close_reason text
         );
         ${migration032}
         ${migration033}
         ${migration034}`,
      ]);
      expect(initialized.exitCode, initialized.stderr).toBe(0);
      const extracted = spawnSync('python3', ['-c', `${loadProducer}
sys.stdout.write(module.RELAY_INSTANCE_CAS_SQL)
`, producer], { encoding: 'utf8' });
      expect(extracted.status, extracted.stderr).toBe(0);
      const probed = await container.exec([
        'psql', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', postgresProbeUser,
        '-d', postgresProbeDatabase, '-c', extracted.stdout,
      ]);
      expect(probed.exitCode, probed.stderr).toBe(0);
      expect(probed.output.trim()).toBe('0');
  }, 120_000);

  test('requires schema-035 profile adoption shape and a rolled-back exact-delivery probe', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import json
cycle = module.IsolatedCycle.__new__(module.IsolatedCycle)
valid = {
    'migration': module.PROFILE_RUNTIME_ADOPTION_SCHEMA,
    'expectationsTable': 'agent_profile_runtime_expectations',
    'adoptionsTable': 'agent_profile_runtime_adoptions',
    'tablesExact': True,
    'constraintsExact': True,
    'functionsExact': True,
    'triggerExact': True,
    'expectationCount': 2,
    'adoptionCount': 1,
    'invalidStoredExpectationCount': 0,
    'invalidStoredAdoptionCount': 0,
}
def psql(sql, *args, **kwargs):
    if sql == module.PROFILE_RUNTIME_ADOPTION_CAS_SQL:
        return b'0\\n'
    return json.dumps(valid).encode()
cycle.psql = psql
observed = cycle.profile_runtime_adoption()
assert observed['exactExpectationAdoption'] == 'passed'
assert observed['deliveryUnique'] == 'passed'
assert observed['historyRetained'] == 'passed'
for field, value in (
    ('tablesExact', False),
    ('constraintsExact', False),
    ('functionsExact', False),
    ('triggerExact', False),
    ('invalidStoredExpectationCount', 1),
    ('invalidStoredAdoptionCount', 1),
    ('expectationCount', -1),
):
    changed = dict(valid, **{field: value})
    cycle.psql = lambda *args, payload=changed, **kwargs: json.dumps(payload).encode()
    try:
        cycle.profile_runtime_adoption()
    except module.ProductionError:
        pass
    else:
        raise SystemExit('invalid profile runtime adoption accepted: ' + field)
calls = 0
def not_rolled_back(sql, *args, **kwargs):
    global calls
    calls += 1
    return json.dumps(valid).encode() if calls == 1 else b'1\\n'
cycle.psql = not_rolled_back
try:
    cycle.profile_runtime_adoption()
except module.ProductionError:
    pass
else:
    raise SystemExit('non-rolled-back profile adoption probe accepted')
print('schema035-profile-adoption-exact')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('schema035-profile-adoption-exact\n');
  });

  test('executes the exact schema-035 adoption transaction in PostgreSQL 16', async () => {
    const container = await sharedPostgresProbe();
      const migration035 = await readFile(
        join(repository, 'packages/store/migrations/035_agent_profile_runtime_adoption.sql'), 'utf8',
      );
      const initialized = await container.exec([
        'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', postgresProbeUser,
        '-d', postgresProbeDatabase, '-c',
        `CREATE EXTENSION IF NOT EXISTS pgcrypto;
         CREATE TABLE agent_profiles(
           tenant_id text NOT NULL, alias text NOT NULL, revision bigint NOT NULL DEFAULT 1,
           role_summary text NOT NULL, PRIMARY KEY(tenant_id,alias)
         );
         CREATE TABLE messages(
           id uuid PRIMARY KEY, request_id uuid NOT NULL, trace_id text NOT NULL,
           tenant_id text NOT NULL, room_id text NOT NULL, actor_alias text NOT NULL,
           body jsonb NOT NULL, lane text NOT NULL, priority integer NOT NULL
         );
         CREATE TABLE deliveries(
           id uuid PRIMARY KEY, message_id uuid NOT NULL REFERENCES messages(id),
           recipient_tenant text NOT NULL, recipient_alias text NOT NULL
         );
         ${migration035}`,
      ]);
      expect(initialized.exitCode, initialized.stderr).toBe(0);
      const extracted = spawnSync('python3', ['-c', `${loadProducer}
sys.stdout.write(module.PROFILE_RUNTIME_ADOPTION_CAS_SQL)
`, producer], { encoding: 'utf8' });
      expect(extracted.status, extracted.stderr).toBe(0);
      const probed = await container.exec([
        'psql', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', postgresProbeUser,
        '-d', postgresProbeDatabase, '-c', extracted.stdout,
      ]);
      expect(probed.exitCode, probed.stderr).toBe(0);
      expect(probed.output.trim()).toBe('0');
  }, 120_000);

  test('requires the exact schema-036 phase shape and rolled-back race probes', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import json
cycle = module.IsolatedCycle.__new__(module.IsolatedCycle)
valid = {
    'migration': module.SHADOW_TARGET_PHASE_SCHEMA,
    'migrationApplied': True,
    'table': 'shadow_router_inbox',
    'column': 'claim_target_started',
    'constraint': 'shadow_router_inbox_claim_phase_shape',
    'functions': [
        'cauce_shadow_router_claim_phase_transition',
        'cauce_shadow_router_mapping_status_monotonic',
        'cauce_shadow_router_mapping_terminal_reconcile',
    ],
    'triggers': [
        'shadow_router_inbox_claim_phase_transition',
        'shadow_router_mapping_status_monotonic',
        'shadow_router_mapping_terminal_reconcile',
    ],
    'columnsExact': True,
    'constraintExact': True,
    'functionsExact': True,
    'triggersExact': True,
    'processingCount': 0,
    'invalidStoredPhaseCount': 0,
}
def psql(sql, *args, **kwargs):
    if sql == module.SHADOW_TARGET_PHASE_CAS_SQL:
        return b'0\\n'
    return json.dumps(valid).encode()
cycle.psql = psql
observed = cycle.shadow_target_phase()
assert observed['pre036EagerClaimRejected'] == 'passed'
assert observed['terminalMappingMonotonic'] == 'passed'
assert observed['terminalMappingReconciliation'] == 'passed'
for field, value in (
    ('migrationApplied', False),
    ('columnsExact', False),
    ('constraintExact', False),
    ('functionsExact', False),
    ('triggersExact', False),
    ('processingCount', 1),
    ('invalidStoredPhaseCount', 1),
):
    changed = dict(valid, **{field: value})
    cycle.psql = lambda *args, payload=changed, **kwargs: json.dumps(payload).encode()
    try:
        cycle.shadow_target_phase()
    except module.ProductionError:
        pass
    else:
        raise SystemExit('invalid shadow target phase accepted: ' + field)
calls = 0
def not_rolled_back(sql, *args, **kwargs):
    global calls
    calls += 1
    return json.dumps(valid).encode() if calls == 1 else b'1\\n'
cycle.psql = not_rolled_back
try:
    cycle.shadow_target_phase()
except module.ProductionError:
    pass
else:
    raise SystemExit('non-rolled-back shadow phase probe accepted')
print('schema036-shadow-target-phase-exact')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('schema036-shadow-target-phase-exact\n');
  });

  test('executes the schema-036 eager, replay, settlement and race transaction in PostgreSQL 16', async () => {
    const container = await sharedPostgresProbe();
    const migration036 = await readFile(
      join(repository, 'packages/store/migrations/036_shadow_router_target_phase.sql'), 'utf8',
    );
    const initialized = await container.exec([
      'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', postgresProbeUser,
      '-d', postgresProbeDatabase, '-c',
      `CREATE TABLE schema_migrations(version text PRIMARY KEY);
       CREATE TABLE shadow_router_inbox(
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),direction text NOT NULL,
         source_event_id text NOT NULL,tenant_id text NOT NULL,mode text NOT NULL,
         correlation jsonb NOT NULL,envelope jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',
         attempts integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 5,
         available_at timestamptz NOT NULL DEFAULT now(),claimed_by text,claim_token uuid,
         claim_expires_at timestamptz,last_error text,created_at timestamptz NOT NULL DEFAULT now(),
         completed_at timestamptz,UNIQUE(direction,source_event_id)
       );
       CREATE TABLE shadow_router_mappings(
         direction text NOT NULL,source_event_id text NOT NULL,tenant_id text NOT NULL,
         mode text NOT NULL,target_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
         correlation jsonb NOT NULL,status text NOT NULL DEFAULT 'processing',
         created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY(direction,source_event_id),UNIQUE(target_event_id)
       );
       ${migration036}
       INSERT INTO schema_migrations(version) VALUES('036_shadow_router_target_phase.sql');`,
    ]);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    const extracted = spawnSync('python3', ['-c', `${loadProducer}
sys.stdout.write(module.SHADOW_TARGET_PHASE_CAS_SQL)
`, producer], { encoding: 'utf8' });
    expect(extracted.status, extracted.stderr).toBe(0);
    const probed = await container.exec([
      'psql', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', postgresProbeUser,
      '-d', postgresProbeDatabase, '-c', extracted.stdout,
    ]);
    expect(probed.exitCode, probed.stderr).toBe(0);
    expect(probed.output.trim()).toBe('0');
  }, 120_000);

  test('requires exact schema-037 key, nonce, rate and head indexes plus generic-plan use', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import json
cycle = module.IsolatedCycle.__new__(module.IsolatedCycle)
definitions = {
    'audit_events_console_publish_head_037_idx': "CREATE INDEX audit_events_console_publish_head_037_idx ON public.audit_events USING btree (tenant_id, actor_alias, ((metadata ->> 'operator_scope_hash'::text)), ((metadata ->> 'conversation_hash'::text)), id DESC) WHERE (action = 'console.publish.head'::text)",
    'audit_events_console_publish_key_037_idx': "CREATE INDEX audit_events_console_publish_key_037_idx ON public.audit_events USING btree (tenant_id, actor_alias, ((metadata ->> 'idempotency_key'::text)), id) WHERE (action = ANY (ARRAY['console.publish.prepare'::text, 'console.publish.confirm'::text, 'console.publish.expire'::text]))",
    'audit_events_console_publish_nonce_037_idx': "CREATE INDEX audit_events_console_publish_nonce_037_idx ON public.audit_events USING btree (tenant_id, actor_alias, ((metadata ->> 'operator_scope_hash'::text)), ((metadata ->> 'intent_nonce_hash'::text)), id DESC) WHERE (action = 'console.publish.prepare'::text)",
    'audit_events_console_publish_rate_037_idx': "CREATE INDEX audit_events_console_publish_rate_037_idx ON public.audit_events USING btree (tenant_id, actor_alias, ((metadata ->> 'operator_scope_hash'::text)), created_at DESC, id DESC) WHERE (action = 'console.publish.prepare'::text)",
}
valid = {
    'migration': module.CONSOLE_PUBLISH_INTENT_SCHEMA,
    'migrationApplied': True,
    'table': 'audit_events',
    'indexes': sorted(definitions),
    'indexCount': 4,
    'unexpectedIndexCount': 0,
    'allIndexesUsable': True,
    'definitions': definitions,
}
calls = 0
plans = [
    'audit_events_console_publish_key_037_idx',
    'audit_events_console_publish_nonce_037_idx',
    'audit_events_console_publish_rate_037_idx',
    'audit_events_console_publish_head_037_idx',
]
def psql(sql, *args, **kwargs):
    global calls
    calls += 1
    if calls == 1:
        return json.dumps(valid).encode()
    return plans[calls - 2].encode()
cycle.psql = psql
observed = cycle.console_publish_journal()
assert observed['indexDefinitionsExact'] is True
assert observed['keyLookupPlan'] == observed['nonceLookupPlan'] == 'passed'
assert observed['rateLimitPlan'] == observed['headLookupPlan'] == 'passed'
assert calls == 5

for field, replacement in (
    ('migrationApplied', False),
    ('indexCount', 3),
    ('unexpectedIndexCount', 1),
    ('allIndexesUsable', False),
):
    changed = dict(valid, **{field: replacement})
    cycle.psql = lambda *args, payload=changed, **kwargs: json.dumps(payload).encode()
    try:
        cycle.console_publish_journal()
    except module.ProductionError:
        pass
    else:
        raise SystemExit('invalid schema-037 journal shape accepted: ' + field)

changed = dict(valid, definitions=dict(definitions))
changed['definitions']['audit_events_console_publish_rate_037_idx'] += ' NULLS FIRST'
cycle.psql = lambda *args, **kwargs: json.dumps(changed).encode()
try:
    cycle.console_publish_journal()
except module.ProductionError:
    pass
else:
    raise SystemExit('schema-037 rate index definition drift accepted')
print('schema037-console-publish-journal-exact')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('schema037-console-publish-journal-exact\n');
  });

  test('binds server-side console publish audit rows into the publish-journal digest', async () => {
    const container = await sharedPostgresProbe();
    const database = `cauce_bridge_snapshot_${process.pid}`;
    const administration = ['psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', postgresProbeUser, '-d', 'postgres'];
    const dropped = await container.exec([...administration, '-c', `DROP DATABASE IF EXISTS ${database}`]);
    expect(dropped.exitCode, dropped.stderr).toBe(0);
    const created = await container.exec([...administration, '-c', `CREATE DATABASE ${database}`]);
    expect(created.exitCode, created.stderr).toBe(0);
    const initialized = await container.exec([
      'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', postgresProbeUser, '-d', database, '-c',
      `CREATE EXTENSION pgcrypto;
       CREATE TABLE schema_migrations(version text);
       CREATE TABLE schema_migration_ledger(version text);
       CREATE TABLE schema_migration_verifications(
         version text,bundled_source_sha256 text,observed_schema_sha256 text
       );
       CREATE TABLE fleet_reconciliation_runs(id bigint);
       CREATE TABLE fleet_reconciliation_history(
         run_id bigint,entity text,tenant_id text,alias text,room_id text
       );
       CREATE TABLE agent_profiles(
         tenant_id text,alias text,revision bigint,applied_revision bigint
       );
       CREATE TABLE agents(tenant_id text,alias text,role_brief text,role_template_slug text);
       CREATE TABLE agent_role_templates(slug text);
       CREATE TABLE agent_role_brief_history(id bigint);
       CREATE TABLE connection_leases(tenant_id text,alias text);
       CREATE TABLE gateway_oidc_sessions(kind text,key_hash text);
       CREATE TABLE messages(id bigint);
       CREATE TABLE idempotency_keys(tenant_id text,actor_alias text,idempotency_key text);
       CREATE TABLE deliveries(id bigint);
       CREATE TABLE delivery_acks(id bigint);
       CREATE TABLE adapter_outbox(id bigint);
       CREATE TABLE audit_events(id bigint PRIMARY KEY,action text NOT NULL,payload text NOT NULL);
       CREATE TABLE agent_profile_runtime_expectations(tenant_id text,alias text);
       CREATE TABLE agent_profile_runtime_adoptions(
         tenant_id text,alias text,revision bigint,generation bigint
       );
       CREATE TABLE shadow_router_inbox(direction text,source_event_id text);
       CREATE TABLE shadow_router_mappings(direction text,source_event_id text);
       INSERT INTO schema_migrations VALUES('037_console_publish_intent_indexes.sql');
       INSERT INTO audit_events VALUES
         (1,'console.publish.prepare','server-journal-entry'),
         (2,'agent.profile.update','not-publish-journal');`,
    ]);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    const extracted = spawnSync('python3', ['-c', `${loadProducer}\nsys.stdout.write(module.SNAPSHOT_SQL)`, producer], {
      encoding: 'utf8',
    });
    expect(extracted.status, extracted.stderr).toBe(0);
    const snapshot = async () => {
      const probed = await container.exec([
        'psql', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', postgresProbeUser,
        '-d', database, '-c', extracted.stdout,
      ]);
      expect(probed.exitCode, probed.stderr).toBe(0);
      return JSON.parse(probed.output.trim()) as {
        publishJournalSha256: string;
        fullDatabaseStateSha256: string;
        rowCounts: { consolePublishAuditEvents: number };
      };
    };
    const initial = await snapshot();
    expect(initial.rowCounts.consolePublishAuditEvents).toBe(1);
    const unrelated = await container.exec([
      'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', postgresProbeUser, '-d', database, '-c',
      `INSERT INTO audit_events VALUES(3,'agent.profile.apply','still-not-publish-journal')`,
    ]);
    expect(unrelated.exitCode, unrelated.stderr).toBe(0);
    const afterUnrelated = await snapshot();
    expect(afterUnrelated.publishJournalSha256).toBe(initial.publishJournalSha256);
    expect(afterUnrelated.fullDatabaseStateSha256).not.toBe(initial.fullDatabaseStateSha256);
    const journaled = await container.exec([
      'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', postgresProbeUser, '-d', database, '-c',
      `INSERT INTO audit_events VALUES(4,'console.publish.confirm','second-server-journal-entry')`,
    ]);
    expect(journaled.exitCode, journaled.stderr).toBe(0);
    const afterJournaled = await snapshot();
    expect(afterJournaled.publishJournalSha256).not.toBe(initial.publishJournalSha256);
    expect(afterJournaled.rowCounts.consolePublishAuditEvents).toBe(2);
  }, 120_000);

  test('delegates compensation to the shared rollback transaction and preserves observed results', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-bridge-transaction-'));
    scratch.push(directory);
    const result = spawnSync('python3', ['-c', `${loadProducer}
import json, subprocess
scratch = pathlib.Path(sys.argv[2])
candidate = 'registry.invalid/cauce/runtime@sha256:' + ('a' * 64)
bridge = 'registry.invalid/cauce/bridge@sha256:' + ('b' * 64)
candidate_id = 'sha256:' + ('c' * 64)
bridge_id = 'sha256:' + ('d' * 64)
cycle = module.IsolatedCycle.__new__(module.IsolatedCycle)
cycle.scratch = scratch
cycle.project = 'cauce-rollback-bridge-' + ('1' * 16)
cycle.candidate_image = candidate
cycle.bridge_image = bridge
cycle.environment = {'SAFE': 'yes'}
observed = {
    'rollbackAction': 'rollback-sh-shared-transaction',
    'failureInjection': 'postgres-unavailable-after-selector-swap',
    'failureObserved': True,
    'lostForwardCasResponseRecovered': True,
    'selectorCasRestored': True,
    'candidateImageRestored': True,
    'composeRecreateObserved': True,
    'servicesRestored': True,
    'transitionLockScope': 'selector-deploy-health-compensation',
    'status': 'passed',
}
def checked(arguments, **kwargs):
    assert arguments == [str(module.OPS / 'scripts' / 'rollback.sh'), 'evidence-cycle']
    environment = kwargs['environment']
    assert environment['CAUCE_ROLLBACK_EVIDENCE_MODE'] == 'isolated-compose-v1'
    assert environment['CAUCE_ROLLBACK_EVIDENCE_PROJECT'] == cycle.project
    assert environment['CAUCE_ROLLBACK_EVIDENCE_CANDIDATE_ID'] == candidate_id
    assert environment['CAUCE_ROLLBACK_EVIDENCE_BRIDGE_ID'] == bridge_id
    return subprocess.CompletedProcess(arguments, 0, stdout=json.dumps(observed).encode(), stderr=b'')
module.run_checked = checked
assert cycle.rollback_compensation(candidate_id=candidate_id, bridge_id=bridge_id) == observed
source = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
assert 'process.exit(42)' not in source
assert 'def atomic_selector' not in source
print('shared-rollback-transaction')
`, producer, directory], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('shared-rollback-transaction\n');
  });

  test('attests the actual Compose runtime container ID and removes every probe container', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import subprocess
cycle = module.IsolatedCycle.__new__(module.IsolatedCycle)
cycle.project = 'cauce-rollback-bridge-' + ('1' * 16)
cycle.base = ['docker', 'compose', '-f', '/isolated/compose.yaml']
cycle.environment = {'SAFE': 'yes'}
expected_id = 'sha256:' + ('a' * 64)
cycle.image_ids = {'candidate': expected_id, 'bridge': 'sha256:' + ('b' * 64)}
calls = []
def checked(arguments, **kwargs):
    calls.append(arguments)
    output = (expected_id + '\\n').encode() if arguments[:3] == ['docker', 'inspect', '--format'] else b'probe-output'
    return subprocess.CompletedProcess(arguments, 0, stdout=output, stderr=b'')
module.run_checked = checked
observed = cycle.run_runtime('candidate', 'node', '--version', phase='runtime fixture', capture=True)
assert observed == b'probe-output'
compose = calls[0]
assert '--pull' in compose and compose[compose.index('--pull') + 1] == 'never'
assert '--name' in compose
assert calls[-1][0:2] == ['docker', 'rm']
print('container-id-attested')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('container-id-attested\n');
  });

  test('fails cleanup when Compose down fails or any project resource remains', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import subprocess
cycle = module.IsolatedCycle.__new__(module.IsolatedCycle)
cycle.base = ['docker', 'compose', '-f', '/isolated/compose.yaml', '--project-name', 'isolated-project']
cycle.environment = {}
cycle.project = 'isolated-project'

def down_failure(arguments, **kwargs):
    raise module.ProductionError('remove isolated rollback project failed')
module.run_checked = down_failure
try:
    cycle.cleanup()
except module.ProductionError:
    pass
else:
    raise SystemExit('cleanup accepted a failed compose down')

def residue(arguments, **kwargs):
    output = b'left-behind\\n' if arguments[:3] == ['docker', 'volume', 'ls'] else b''
    return subprocess.CompletedProcess(arguments, 0, stdout=output, stderr=b'')
module.run_checked = residue
try:
    cycle.cleanup()
except module.ProductionError as error:
    assert 'volumes' in str(error)
else:
    raise SystemExit('cleanup accepted a residual project volume')
print('cleanup-failed-closed')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('cleanup-failed-closed\n');
  });

  test('re-hashes an extracted archive as the exact Git provenance tree', () => {
    const result = spawnSync('python3', ['-c', `${loadProducer}
import io
import subprocess
import tarfile
import tempfile
archive = subprocess.run(['git', '-C', str(module.ROOT), 'archive', 'HEAD'], check=True, capture_output=True).stdout
with tempfile.TemporaryDirectory(prefix='cauce-bridge-tree-test-') as name:
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:') as handle:
        handle.extractall(name, filter='data')
    observed = module.git_tree_for_directory(pathlib.Path(name))
expected = subprocess.run(
    ['git', '-C', str(module.ROOT), 'rev-parse', 'HEAD^{tree}'], check=True, capture_output=True, text=True,
).stdout.strip()
assert observed == expected
print('archive-tree-bound')
`, producer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('archive-tree-bound\n');
  });

  test('exposes only file and immutable-image inputs, never a production database URL', () => {
    const help = spawnSync('python3', [producer, '--help'], { encoding: 'utf8' });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('--backup');
    expect(help.stdout).toContain('--candidate-image');
    expect(help.stdout).toContain('--postgres-image');
    expect(help.stdout).not.toContain('--database-url');
    expect(help.stdout).not.toContain('--production');
  });

  test('binds the real OIDC route probe and the full public database digest into evidence', async () => {
    const source = await readFile(producer, 'utf8');
    expect(source).toContain('deploy/rollback-bridge-http-probe.mjs');
    expect(source).toContain('cycle.http_read_only_probe()');
    expect(source).toContain('gateway_oidc_sessions');
    expect(source).toContain('fullDatabaseStateSha256');
    expect(source).toContain("n.nspname='public' AND c.relkind='r'");
    expect(source).toContain("n.nspname='public' AND c.relkind='S'");
  });
});
