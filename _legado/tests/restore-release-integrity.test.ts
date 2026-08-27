import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const restore = join(repository, 'ops/scripts/restore.sh');
const postgresTls = join(repository, 'ops/scripts/check-postgres-tls.mjs');
const releaseGate = join(repository, 'ops/scripts/release-gate.sh');
const releaseCandidate = join(repository, 'ops/scripts/release-candidate.py');
const scratch: string[] = [];

type RestoreFixture = {
  argvLog: string;
  backup: string;
  databaseUrlFile: string;
  directory: string;
  env: NodeJS.ProcessEnv;
  evidence: string;
  restoreLog: string;
};

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function restoreFixture(overrides: NodeJS.ProcessEnv = {}): Promise<RestoreFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-restore-gate-'));
  scratch.push(directory);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const backup = join(directory, 'cauce-fixture.dump');
  const evidence = join(directory, 'restore-evidence.json');
  const restoreLog = join(directory, 'pg-restore.log');
  const argvLog = join(directory, 'postgres-argv.log');
  const ca = join(directory, 'postgres-ca.crt');
  await writeFile(backup, 'custom-format-fixture\n', { mode: 0o600 });
  await writeFile(ca, 'test root CA bytes\n', { mode: 0o600 });
  const digest = createHash('sha256').update(await readFile(backup)).digest('hex');
  await writeFile(`${backup}.sha256`, `${digest}  ${'cauce-fixture.dump'}\n`, { mode: 0o600 });
  await executable(join(bin, 'pg_restore'), `#!/bin/sh
set -eu
printf 'service-file=%s\n' "\${PGSERVICEFILE:-none}" >> "$FAKE_ARGV_LOG"
for value in "$@"; do
  case "$value" in
    /proc/*/fd/*)
      [ "$(cat "$value")" = 'custom-format-fixture' ] || {
        printf 'restore did not receive the immutable snapshot\n' >&2
        exit 92
      }
      ;;
  esac
done
case " $* " in
  *" --list "*)
    if [ "\${FAKE_MUTATE_BACKUP_SOURCE:-0}" = 1 ]; then
      printf 'mutated-after-snapshot\n' > "$FAKE_BACKUP_SOURCE"
    fi
    printf 'list\\n' >> "$FAKE_RESTORE_LOG"
    exit "\${FAKE_PG_RESTORE_LIST_STATUS:-0}"
    ;;
  *)
    [ "\${DATABASE_URL:-}" = "" ]
    [ "\${PGSERVICE:-}" = cauce_restore ]
    [ -f "\${PGPASSFILE:?}" ] && [ "$(stat -c %a "$PGPASSFILE")" = 600 ]
    printf '%s\\n' "$*" >> "$FAKE_ARGV_LOG"
    printf 'restore\\n' >> "$FAKE_RESTORE_LOG"
    exit "\${FAKE_PG_RESTORE_STATUS:-0}"
    ;;
esac
`);
  await executable(join(bin, 'psql'), `#!/bin/sh
set -eu
[ "\${DATABASE_URL:-}" = "" ]
[ "\${PGSERVICE:-}" = cauce_restore ]
[ -f "\${PGPASSFILE:?}" ] && [ "$(stat -c %a "$PGPASSFILE")" = 600 ]
printf 'service-file=%s db=%s\n' "$PGSERVICEFILE" "$(sed -n 's/^dbname=//p' "$PGSERVICEFILE")" >> "$FAKE_ARGV_LOG"
if [ -n "\${FAKE_SWAP_DATABASE_URL_TO:-}" ] && [ ! -e "$FAKE_SWAP_MARKER" ]; then
  mv "$FAKE_SWAP_DATABASE_URL_TO" "$FAKE_DATABASE_URL_SOURCE"
  : > "$FAKE_SWAP_MARKER"
fi
printf '%s\\n' "$*" >> "$FAKE_ARGV_LOG"
query=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -Atqc ]; then shift; query=\${1:-}; break; fi
  shift
done
case "$query" in
  *pg_stat_ssl*) printf '%s\\n' "\${FAKE_TLS_ACTIVE:-t}" ;;
  *pg_db_role_setting*) printf '%s\\n' "\${FAKE_MARKER_COUNT:-1}" ;;
  *"current_setting('cauce.environment'"*) printf '%s\\n' "\${FAKE_MARKER_VALUE:-restore-drill}" ;;
  *inet_server_addr*) printf '%s\\n' "\${FAKE_SERVER_ADDR:-10.23.0.2}" ;;
  *pg_stat_activity*) printf '%s\\n' "\${FAKE_OTHER_CONNECTIONS:-0}" ;;
  *user_namespaces*) printf '%s\\n' "\${FAKE_USER_OBJECTS:-0}" ;;
  *information_schema.tables*) printf '%s\\n' "\${FAKE_CORE_TABLES:-8}" ;;
  *"SELECT count(*) FROM schema_migrations"*) printf '%s\\n' "\${FAKE_MIGRATION_COUNT:-29}" ;;
  *"SELECT max(version) FROM schema_migrations"*) printf '%s\\n' "\${FAKE_LATEST_MIGRATION:-029_reconcile_declared_fleet.sql}" ;;
  *server_version_num*) printf '%s\\n' "\${FAKE_SERVER_VERSION_NUM:-160014}" ;;
  *current_database*) printf '%s\\n' "\${FAKE_CURRENT_DB:-cauce_drill}" ;;
  *) printf 'unexpected fixture query\\n' >&2; exit 91 ;;
esac
`);
  await executable(join(bin, 'python3'), `#!/bin/sh
if [ "\${FAKE_REPLACE_SNAPSHOT_AFTER_HASH:-0}" = 1 ] && [ "\${1:-}" = - ]; then
  last=
  for value in "$@"; do last=$value; done
  case "$last" in
    */backup.dump)
      status=0
      /usr/bin/python3 "$@" || status=$?
      if [ "$status" = 0 ]; then
        printf 'replacement-after-authorized-hash\n' > "$last"
        chmod 0400 "$last"
      fi
      exit "$status"
      ;;
  esac
fi
exec /usr/bin/python3 "$@"
`);
  const query = new URLSearchParams({ sslmode: 'verify-full', sslrootcert: ca });
  const databaseUrl = `postgresql://restore:fixture-password@localhost:5432/cauce_drill?${query.toString()}`;
  const databaseUrlFile = join(directory, 'database-url');
  await writeFile(databaseUrlFile, `${databaseUrl}\n`, { mode: 0o600 });
  return {
    argvLog,
    backup,
    databaseUrlFile,
    directory,
    evidence,
    restoreLog,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      NODE_ENV: 'test',
      DATABASE_URL_FILE: databaseUrlFile,
      DATABASE_URL: '',
      PGSSLMODE: '',
      PGSSLROOTCERT: '',
      RESTORE_EXPECT_DB: 'cauce_drill',
      RESTORE_EXPECT_BACKUP_SHA256: `sha256:${digest}`,
      RESTORE_TARGET_CLASS: 'isolated-non-production',
      RESTORE_NETWORK_ISOLATION: 'private-test-network-no-egress',
      RESTORE_CONFIRM: 'restore:cauce_drill:isolated-non-production',
      RESTORE_EVIDENCE_FILE: evidence,
      FAKE_RESTORE_LOG: restoreLog,
      FAKE_ARGV_LOG: argvLog,
      FAKE_BACKUP_SOURCE: backup,
      FAKE_DATABASE_URL_SOURCE: databaseUrlFile,
      FAKE_SWAP_MARKER: join(directory, 'database-url-swapped'),
      FAKE_SERVER_VERSION_NUM: '160014',
      FAKE_TLS_ACTIVE: 't',
      FAKE_MARKER_COUNT: '1',
      FAKE_MARKER_VALUE: 'restore-drill',
      FAKE_OTHER_CONNECTIONS: '0',
      FAKE_USER_OBJECTS: '0',
      FAKE_CORE_TABLES: '8',
      FAKE_MIGRATION_COUNT: '29',
      ...overrides,
    },
  };
}

function runRestore(value: RestoreFixture) {
  return spawnSync(restore, [value.backup], {
    cwd: value.directory,
    env: value.env,
    encoding: 'utf8',
  });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('PostgreSQL TLS policy used by backup and restore', () => {
  test('requires verify-full and a readable absolute non-symlink root CA', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-postgres-tls-'));
    scratch.push(directory);
    const ca = join(directory, 'postgres-ca.crt');
    const caLink = join(directory, 'postgres-ca-link.crt');
    await writeFile(ca, 'root CA fixture\n', { mode: 0o600 });
    await symlink(ca, caLink);
    const baseEnvironment = {
      ...process.env,
      NODE_ENV: 'test',
      CAUCE_POSTGRES_TLS_POLICY: 'verify-full',
      PGSSLMODE: '',
      PGSSLROOTCERT: '',
    };
    const validQuery = new URLSearchParams({ sslmode: 'verify-full', sslrootcert: ca });
    const valid = spawnSync('node', [postgresTls], {
      encoding: 'utf8',
      env: { ...baseEnvironment, DATABASE_URL: `postgresql://user:hidden@localhost/db?${validQuery}` },
    });
    expect(valid.status, valid.stderr).toBe(0);

    const weakQuery = new URLSearchParams({ sslmode: 'require', sslrootcert: ca });
    const weak = spawnSync('node', [postgresTls], {
      encoding: 'utf8',
      env: { ...baseEnvironment, DATABASE_URL: `postgresql://user:hidden@localhost/db?${weakQuery}` },
    });
    expect(weak.status).toBe(2);
    expect(weak.stderr).toBe('PostgreSQL requires sslmode=verify-full\n');
    expect(weak.stderr).not.toContain('hidden');

    const linkedQuery = new URLSearchParams({ sslmode: 'verify-full', sslrootcert: caLink });
    const linked = spawnSync('node', [postgresTls], {
      encoding: 'utf8',
      env: { ...baseEnvironment, DATABASE_URL: `postgresql://user:hidden@localhost/db?${linkedQuery}` },
    });
    expect(linked.status).toBe(2);
    expect(linked.stderr).toBe('PostgreSQL root CA must be a regular non-symlink file\n');
    expect(linked.stderr).not.toContain(caLink);

    const duplicated = spawnSync('node', [postgresTls], {
      encoding: 'utf8',
      env: {
        ...baseEnvironment,
        DATABASE_URL: `postgresql://user:hidden@localhost/db?sslmode=verify-full&sslmode=require&sslrootcert=${encodeURIComponent(ca)}`,
      },
    });
    expect(duplicated.status).toBe(2);
    expect(duplicated.stderr).toBe('PostgreSQL TLS parameters must not be repeated\n');
    expect(duplicated.stderr).not.toContain('hidden');
  });
});

describe('isolated PostgreSQL restore gate', () => {
  test('restores a signed backup into a marked empty PostgreSQL 16 target and emits private evidence', async () => {
    const value = await restoreFixture();
    const result = runRestore(value);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(value.restoreLog, 'utf8')).toBe('list\nrestore\n');
    const evidence: unknown = JSON.parse(await readFile(value.evidence, 'utf8'));
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      suite: 'cauce-v3-restore',
      backup: {
        file: 'cauce-fixture.dump', checksumSidecarVerified: true,
        catalogVerified: true, immutableSnapshot: true,
      },
      target: {
        database: 'cauce_drill',
        postgresMajor: 16,
        targetWasEmpty: true,
        databaseMarker: 'cauce.environment=restore-drill',
        productionConnected: false,
        networkIsolationDeclaration: 'private-test-network-no-egress',
      },
      transport: { sslMode: 'verify-full', rootCaConfigured: true, tlsActive: true },
      restore: {
        fullRestore: true,
        singleTransaction: true,
        cleanApplied: false,
        coreTableCount: 8,
        appliedMigrationCount: 29,
      },
    });
    expect((await lstat(value.evidence)).mode & 0o777).toBe(0o600);
    const invokedArguments = await readFile(value.argvLog, 'utf8');
    expect(invokedArguments).toContain('--dbname=service=cauce_restore');
    expect(invokedArguments).not.toContain('fixture-password');
    expect(result.stdout).not.toContain('fixture-password');
    expect(result.stderr).not.toContain('fixture-password');
  });

  test('restores the one hashed immutable snapshot even when the source inode is modified later', async () => {
    const value = await restoreFixture({ FAKE_MUTATE_BACKUP_SOURCE: '1' });
    const result = runRestore(value);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(value.backup, 'utf8')).toBe('mutated-after-snapshot\n');
    expect(await readFile(value.restoreLog, 'utf8')).toBe('list\nrestore\n');
    const evidence = JSON.parse(await readFile(value.evidence, 'utf8')) as {
      backup: { sha256: string };
    };
    expect(evidence.backup.sha256).toBe(
      createHash('sha256').update('custom-format-fixture\n').digest('hex'),
    );
  });

  test('rejects replacement of the snapshot pathname after its single authorized hash', async () => {
    const value = await restoreFixture({ FAKE_REPLACE_SNAPSHOT_AFTER_HASH: '1' });
    const result = runRestore(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('immutable backup snapshot identity changed before restore');
    await expect(lstat(value.evidence)).rejects.toThrow();
    await expect(readFile(value.restoreLog, 'utf8')).rejects.toThrow();
  });

  test('pins one private libpq configuration and rejects an origin swap after the session', async () => {
    const value = await restoreFixture();
    const alternate = join(value.directory, 'database-url-alternate');
    const alternateUrl = new URLSearchParams({
      sslmode: 'verify-full',
      sslrootcert: join(value.directory, 'postgres-ca.crt'),
    });
    await writeFile(
      alternate,
      `postgresql://restore:other-password@other-host:5432/other_restore?${alternateUrl.toString()}\n`,
      { mode: 0o600 },
    );
    value.env.FAKE_SWAP_DATABASE_URL_TO = alternate;
    const result = runRestore(value);
    expect(result.status).toBe(74);
    expect(result.stderr).toContain('connection origin changed during the session');
    expect(result.stderr).not.toContain('fixture-password');
    expect(result.stderr).not.toContain('other-password');
    await expect(lstat(value.evidence)).rejects.toThrow();
    const calls = await readFile(value.argvLog, 'utf8');
    const serviceFiles = [...calls.matchAll(/^service-file=(\S+)/gmu)].map((match) => match[1]);
    expect(new Set(serviceFiles).size).toBe(1);
    expect(calls).toContain('db=cauce_drill');
    expect(calls).not.toContain('db=other_restore');
  });

  test('refuses a non-empty target before invoking the mutating pg_restore', async () => {
    const value = await restoreFixture({ FAKE_USER_OBJECTS: '1' });
    const result = runRestore(value);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('restore target is not empty');
    expect(await readFile(value.restoreLog, 'utf8')).toBe('list\n');
    await expect(lstat(value.evidence)).rejects.toThrow();
  });

  test('refuses PostgreSQL 15, an unmarked database, and concurrent target users', async () => {
    for (const [overrides, diagnostic] of [
      [{ FAKE_SERVER_VERSION_NUM: '150012' }, 'PostgreSQL major version 16'],
      [{ FAKE_MARKER_COUNT: '0' }, 'persistent database-level restore-drill marker'],
      [{ FAKE_OTHER_CONNECTIONS: '1' }, 'other active connections'],
      [{ RESTORE_NETWORK_ISOLATION: 'network-none' }, 'remote restore target contradicts'],
    ] satisfies Array<[NodeJS.ProcessEnv, string]>) {
      const value = await restoreFixture(overrides);
      const result = runRestore(value);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(diagnostic);
      expect(await readFile(value.restoreLog, 'utf8')).toBe('list\n');
      await expect(lstat(value.evidence)).rejects.toThrow();
    }
  });

  test('requires the exact one-entry checksum and never overwrites an evidence path', async () => {
    const unsigned = await restoreFixture();
    await writeFile(`${unsigned.backup}.sha256`, 'not-a-checksum\nextra\n');
    const unsignedResult = runRestore(unsigned);
    expect(unsignedResult.status).not.toBe(0);
    expect(unsignedResult.stderr).toContain('checksum sidecar must contain exactly one entry');

    const collision = await restoreFixture();
    await writeFile(collision.evidence, '{"operator":"existing"}\n', { mode: 0o600 });
    const collisionResult = runRestore(collision);
    expect(collisionResult.status).toBe(2);
    expect(collisionResult.stderr).toContain('RESTORE_EVIDENCE_FILE already exists');
    expect(await readFile(collision.evidence, 'utf8')).toBe('{"operator":"existing"}\n');

    const digestMismatch = await restoreFixture({ RESTORE_EXPECT_BACKUP_SHA256: `sha256:${'f'.repeat(64)}` });
    const mismatchResult = runRestore(digestMismatch);
    expect(mismatchResult.status).not.toBe(0);
    expect(mismatchResult.stderr).toContain('differs from RESTORE_EXPECT_BACKUP_SHA256');
  });

  test('rejects a public or multi-line DATABASE_URL_FILE without exposing its value', async () => {
    for (const fixtureContent of ['single', 'multiple']) {
      const value = await restoreFixture();
      const secret = `postgresql://restore:fixture-password@localhost:5432/cauce_drill`;
      const databaseUrlFile = join(value.directory, `database-url-${fixtureContent}`);
      await writeFile(
        databaseUrlFile,
        fixtureContent === 'single' ? `${secret}\n` : `${secret}\nunexpected-second-line\n`,
        { mode: fixtureContent === 'single' ? 0o644 : 0o600 },
      );
      value.env.DATABASE_URL_FILE = databaseUrlFile;
      const result = runRestore(value);
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain(secret);
      await expect(lstat(value.evidence)).rejects.toThrow();
    }
  });

  test('rejects direct secret-bearing DATABASE_URL input and unsafe backup metadata', async () => {
    const direct = await restoreFixture({ DATABASE_URL: 'postgresql://restore:do-not-print@localhost/db' });
    const directResult = runRestore(direct);
    expect(directResult.status).toBe(2);
    expect(directResult.stderr).toContain('requires DATABASE_URL_FILE');
    expect(directResult.stderr).not.toContain('do-not-print');

    const publicBackup = await restoreFixture();
    await chmod(publicBackup.backup, 0o644);
    const publicResult = runRestore(publicBackup);
    expect(publicResult.status).not.toBe(0);
    expect(publicResult.stderr).toContain('owned private single-link regular file');
  });

  test('removes the reserved evidence file when restore or post-restore verification fails', async () => {
    for (const overrides of [
      { FAKE_PG_RESTORE_STATUS: '1' },
      { FAKE_CORE_TABLES: '7' },
    ]) {
      const value = await restoreFixture(overrides);
      const result = runRestore(value);
      expect(result.status).not.toBe(0);
      expect(await readFile(value.restoreLog, 'utf8')).toBe('list\nrestore\n');
      await expect(lstat(value.evidence)).rejects.toThrow();
      expect(result.stderr).not.toContain('fixture-password');
    }
  });
});

describe('general release migration integrity admission', () => {
  test('release-host gate binds every active Compose profile service to selector, image ID and config hash', () => {
    const result = spawnSync('python3', ['-c', `
import ast
import copy
import json
import pathlib
import types
import sys

tree = ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
definition = next(
    node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name == "verify_active_compose_containers"
)
module = ast.Module(body=[definition], type_ignores=[])
ast.fix_missing_locations(module)
namespace = {"json": json, "pathlib": pathlib, "re": __import__("re"), "OPS": pathlib.Path("/ops")}
exec(compile(module, sys.argv[1], "exec"), namespace)
verify = namespace["verify_active_compose_containers"]

running = ["gateway", "dispatcher", "outbox-metrics", "telegram-bridge", "terminal-relay"]
materialized = list(running)
configured = [*running, "migrator"]
inactive = "shadow-router"
runtime = "registry.invalid/cauce/runtime@sha256:" + ("a" * 64)
old_runtime = "registry.invalid/cauce/runtime@sha256:" + ("e" * 64)
model = {"services": {
    name: ({"image": runtime} if name == "migrator" else {"image": runtime, "healthcheck": {"test": ["CMD", "true"]}})
    for name in [*configured, inactive]
}}
container_ids = {name: format(index + 1, "x") * 12 for index, name in enumerate(materialized)}
service_by_id = {value: key for key, value in container_ids.items()}
commands = []

def runner(arguments, **kwargs):
    commands.append(arguments)
    tail = arguments[2:]
    if tail == ["ps", "--services", "--status", "running"]:
        return types.SimpleNamespace(stdout="\\n".join(running) + "\\n")
    if tail == ["ps", "--all", "--services"]:
        return types.SimpleNamespace(stdout="\\n".join(materialized) + "\\n")
    if tail == ["config", "--services"]:
        return types.SimpleNamespace(stdout="\\n".join(configured) + "\\n")
    if tail[:2] == ["config", "--hash"]:
        service = tail[2]
        return types.SimpleNamespace(stdout=f"{service} {('b' * 64)}\\n")
    if tail[:3] == ["ps", "--all", "--quiet"]:
        return types.SimpleNamespace(stdout=container_ids[tail[3]] + "\\n")
    if arguments[:2] == ["docker", "inspect"]:
        service = service_by_id[arguments[2]]
        return types.SimpleNamespace(stdout=json.dumps([{
            "Image": "sha256:" + ("d" * 64),
            "Config": {"Image": runtime, "Labels": {"com.docker.compose.config-hash": "b" * 64}},
            "State": {
                "Status": "running", "ExitCode": 0, "Health": {"Status": "healthy"},
            },
            "Service": service,
        }]))
    raise AssertionError(arguments)

resolved = []
def image_id(reference):
    resolved.append(reference)
    return "sha256:" + ("d" * 64)

assert verify(model, {}, command_runner=runner, image_id_resolver=image_id) == sorted(materialized)
assert resolved == [runtime], resolved
assert not any(inactive in argument for command in commands for argument in command)
assert {command[-1] for command in commands if command[2:4] == ["config", "--hash"]} == set(materialized)

def reject_drift(field, target):
    def drifted(arguments, **kwargs):
        result = runner(arguments, **kwargs)
        if arguments[:2] != ["docker", "inspect"]: return result
        value = json.loads(result.stdout)
        if service_by_id[arguments[2]] != target: return result
        if field == "selector": value[0]["Config"]["Image"] = old_runtime
        if field == "image-id": value[0]["Image"] = "sha256:" + ("e" * 64)
        if field == "config-hash": value[0]["Config"]["Labels"]["com.docker.compose.config-hash"] = "e" * 64
        if field == "health-starting": value[0]["State"]["Health"]["Status"] = "starting"
        if field == "health-unhealthy": value[0]["State"]["Health"]["Status"] = "unhealthy"
        if field == "health-absent": value[0]["State"].pop("Health")
        return types.SimpleNamespace(stdout=json.dumps(value))
    try:
        verify(model, {}, command_runner=drifted, image_id_resolver=image_id)
    except ValueError:
        return
    raise AssertionError(f"{field} drift for {target} was accepted")

for field, target in (
    ("selector", "gateway"),
    ("image-id", "gateway"),
    ("config-hash", "gateway"),
    ("health-starting", "gateway"),
    ("health-unhealthy", "gateway"),
    ("health-absent", "gateway"),
):
    reject_drift(field, target)

without_healthcheck = copy.deepcopy(model)
without_healthcheck["services"]["gateway"].pop("healthcheck")
try:
    verify(without_healthcheck, {}, command_runner=runner, image_id_resolver=image_id)
except ValueError:
    pass
else:
    raise AssertionError("a healthcheck-free long-lived service was accepted")
disabled_healthcheck = copy.deepcopy(model)
disabled_healthcheck["services"]["gateway"]["healthcheck"] = {"disable": True}
try:
    verify(disabled_healthcheck, {}, command_runner=runner, image_id_resolver=image_id)
except ValueError:
    pass
else:
    raise AssertionError("a healthcheck-disabled long-lived service was accepted")

def missing_materialized(arguments, **kwargs):
    result = runner(arguments, **kwargs)
    if arguments[2:] == ["ps", "--all", "--services"]:
        return types.SimpleNamespace(stdout="\\n".join(materialized[:-1]) + "\\n")
    return result
try:
    verify(model, {}, command_runner=missing_materialized, image_id_resolver=image_id)
except ValueError:
    pass
else:
    raise AssertionError("a configured but non-materialized service was accepted")

def stale_migrator(arguments, **kwargs):
    result = runner(arguments, **kwargs)
    if arguments[2:] == ["ps", "--all", "--services"]:
        return types.SimpleNamespace(stdout="\\n".join(configured) + "\\n")
    return result
try:
    verify(model, {}, command_runner=stale_migrator, image_id_resolver=image_id)
except ValueError:
    pass
else:
    raise AssertionError("a stale materialized one-shot migrator was accepted")

def missing_migrator_config(arguments, **kwargs):
    result = runner(arguments, **kwargs)
    if arguments[2:] == ["config", "--services"]:
        return types.SimpleNamespace(stdout="\\n".join(running) + "\\n")
    return result
try:
    verify(model, {}, command_runner=missing_migrator_config, image_id_resolver=image_id)
except ValueError:
    pass
else:
    raise AssertionError("a configuration without the one-shot migrator was accepted")

gateway_inspects = 0
def degrades_on_final_read(arguments, **kwargs):
    global gateway_inspects
    result = runner(arguments, **kwargs)
    if arguments[:2] == ["docker", "inspect"] and service_by_id[arguments[2]] == "gateway":
        gateway_inspects += 1
        if gateway_inspects == 2:
            value = json.loads(result.stdout)
            value[0]["State"]["Health"]["Status"] = "unhealthy"
            return types.SimpleNamespace(stdout=json.dumps(value))
    return result
try:
    verify(model, {}, command_runner=degrades_on_final_read, image_id_resolver=image_id)
except ValueError:
    pass
else:
    raise AssertionError("health degradation during final verification was accepted")
print("active-compose-identity-enforced")
`, releaseCandidate], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('active-compose-identity-enforced');
  });

  test('runs post-integrity before candidate assembly and makes post evidence mandatory', async () => {
    const gateSource = await readFile(releaseGate, 'utf8');
    const preCall = '"$ROOT/scripts/migration-integrity-gate.sh" pre';
    const postCall = '"$ROOT/scripts/migration-integrity-gate.sh" post';
    const readinessCall = '"$ROOT/scripts/stack-health.sh" "${health_args[@]}"';
    const candidateCall = 'python3 "$ROOT/scripts/release-candidate.py"';
    expect(gateSource.indexOf(preCall)).toBeGreaterThan(-1);
    expect(gateSource.indexOf(postCall)).toBeGreaterThan(gateSource.indexOf(preCall));
    expect(gateSource.indexOf(postCall)).toBeLessThan(gateSource.indexOf(candidateCall));
    expect(gateSource.indexOf(readinessCall)).toBeGreaterThan(gateSource.indexOf(postCall));
    expect(gateSource.indexOf(readinessCall)).toBeLessThan(gateSource.indexOf(candidateCall));

    const candidateSource = await readFile(releaseCandidate, 'utf8');
    expect(candidateSource).toContain('migration_post = load(migration_dir / "post.json")');
    expect(candidateSource).toContain('{"pre.json", "post.json"}');
    expect(candidateSource).toContain('post_report.get("phase") != "post"');
    expect(candidateSource).toContain('post-migration evidence contains pending migrations');
    expect(candidateSource).toContain('post-migration evidence contains a release migration without its atomic ledger');
    expect(candidateSource).toContain('("migration-integrity-post", migration_dir / "post.json")');
  });

  test('functionally rejects missing, pending, duplicate, unledgered, or stale post evidence', () => {
    const result = spawnSync('python3', ['-c', `
import ast
import copy
import datetime
import pathlib
import sys

tree = ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
wanted = {"object_entries", "validate_migration_pair"}
definitions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in wanted]
assert {node.name for node in definitions} == wanted
module = ast.Module(body=definitions, type_ignores=[])
ast.fix_missing_locations(module)
namespace = {"ERRORS": [], "datetime": datetime}
exec(compile(module, sys.argv[1], "exec"), namespace)
validate = namespace["validate_migration_pair"]
errors = namespace["ERRORS"]
sources = {"024_agent_role_templates.sql": "a" * 64, "026_agent_profile.sql": "b" * 64}
legacy = {
    "version": "024_agent_role_templates.sql", "sourceSha256": "a" * 64,
    "applied": True, "sourceOrigin": "undetermined",
    "verificationMethod": "structural-equivalence-v1", "observedSchemaSha256": "c" * 64,
}
pending = {
    "version": "026_agent_profile.sql", "sourceSha256": "b" * 64,
    "applied": False, "sourceOrigin": "pending", "verificationMethod": "not-applied",
}
applied = {
    **pending, "applied": True, "sourceOrigin": "applied-atomically",
    "verificationMethod": "atomic-ledger-v1",
}
pre = {
    "phase": "pre", "generatedAt": "2026-08-25T00:00:00Z",
    "migrationSetSha256": "d" * 64, "entries": [legacy, pending],
}
post = {
    "phase": "post", "generatedAt": "2026-08-25T00:01:00Z",
    "migrationSetSha256": "d" * 64, "entries": [legacy, applied],
}

def diagnostics(pre_value, post_value):
    errors.clear()
    validate(pre_value, post_value, sources)
    return list(errors)

assert diagnostics(pre, post) == []
missing = copy.deepcopy(post); missing["entries"].pop()
assert any("exact release migration sources" in item for item in diagnostics(pre, missing))
still_pending = copy.deepcopy(post); still_pending["entries"][1] = pending
assert any("pending migrations" in item for item in diagnostics(pre, still_pending))
duplicate = copy.deepcopy(post); duplicate["entries"].append(copy.deepcopy(applied))
assert any("exact release migration sources" in item for item in diagnostics(pre, duplicate))
unledgered = copy.deepcopy(post); unledgered["entries"][1]["sourceOrigin"] = "undetermined"
assert any("without its atomic ledger" in item for item in diagnostics(pre, unledgered))
stale = copy.deepcopy(post); stale["generatedAt"] = "2026-08-24T23:59:59Z"
assert any("predates" in item for item in diagnostics(pre, stale))
drifted = copy.deepcopy(post); drifted["entries"][0]["observedSchemaSha256"] = "e" * 64
assert any("structural fingerprint changed" in item for item in diagnostics(pre, drifted))
print("post-integrity-validation-enforced")
`, releaseCandidate], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('post-integrity-validation-enforced');
  });
});
