import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const monitor = join(repository, 'ops/scripts/host-backup-monitor.sh');
const backup = join(repository, 'ops/scripts/host-backup.sh');
const deploy = join(repository, 'deploy/deploy.sh');
const scratch: string[] = [];

function validStatus() {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    schema_version: 4,
    run_started_utc: now,
    run_finished_utc: now,
    host: 'fixture',
    db: { status: 'ok', file: '/private/backup.dump', detail: '' },
    restore: {
      status: 'ok',
      detail: '',
      evidence_file: '/private/backup.dump.restore.json',
      isolated: true,
      network: 'none',
    },
    retention: { skip_requested: false, status: 'local-pruned-after-offsite', days: 14 },
    ut_nexus: { enabled: false, status: 'disabled', detail: '' },
    offsite: {
      host: 'fixture',
      strategy: 'append-only-no-delete',
      db_status: 'ok',
      db_detail: '',
      ut_nexus_status: 'disabled',
      ut_nexus_detail: '',
    },
    blobs: undefined as undefined | {
      archive_file: string;
      archive_sha256: string;
      manifest_file: string;
      manifest_sha256: string;
      volume: string;
      table_present: boolean;
      volume_present: boolean;
    },
    overall: 'ok',
  };
}

interface MonitorPaths { dumpFile: string; evidenceFile: string; statusFile: string; archiveFile: string; manifestFile: string }

async function runMonitor(
  status: unknown,
  options: {
    maxAgeHours?: string;
    requireRetention?: boolean;
    requireBlobs?: boolean;
    blobs?: boolean;
    mutate?: (paths: MonitorPaths) => Promise<void>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-backup-monitor-'));
  scratch.push(directory);
  const typed = status as ReturnType<typeof validStatus>;
  const dumpFile = join(directory, 'backup.dump');
  const evidenceFile = `${dumpFile}.restore.json`;
  const digest = createHash('sha256').update('private backup fixture\n').digest('hex');
  typed.db.file = dumpFile;
  typed.restore.evidence_file = evidenceFile;
  await writeFile(dumpFile, 'private backup fixture\n', { mode: 0o600 });
  await writeFile(`${dumpFile}.sha256`, `${digest}  backup.dump\n`, { mode: 0o600 });
  const evidence: Record<string, unknown> = {
    schema_version: 1,
    suite: 'cauce-v3-host-backup-restore',
    verified_at_utc: typed.run_finished_utc,
    dump_file: 'backup.dump',
    dump_sha256: digest,
    database_image_digest: `sha256:${'b'.repeat(64)}`,
    isolated: true,
    network: 'none',
    full_restore: true,
    core_table_count: 8,
    applied_migration_count: 29,
  };
  const archiveFile = `${dumpFile}.blobs.tar`;
  const manifestFile = `${dumpFile}.blobs.tsv`;
  if (options.blobs) {
    const bytes = Buffer.from('private blob fixture\n');
    const blobDigest = createHash('sha256').update(bytes).digest('hex');
    const blobDirectory = join(directory, 'blob-source');
    await mkdir(blobDirectory);
    await writeFile(join(blobDirectory, blobDigest), bytes, { mode: 0o600 });
    const tar = spawnSync('tar', ['-C', blobDirectory, '-cf', archiveFile, '.'], { encoding: 'utf8' });
    expect(tar.status).toBe(0);
    await chmod(archiveFile, 0o600);
    const archiveDigest = createHash('sha256').update(await readFile(archiveFile)).digest('hex');
    const manifest = `${blobDigest}\t${String(bytes.length)}\n`;
    const manifestDigest = createHash('sha256').update(manifest).digest('hex');
    await writeFile(`${archiveFile}.sha256`, `${archiveDigest}  ${basename(archiveFile)}\n`, { mode: 0o600 });
    await writeFile(manifestFile, manifest, { mode: 0o600 });
    typed.blobs = {
      archive_file: archiveFile,
      archive_sha256: archiveDigest,
      manifest_file: manifestFile,
      manifest_sha256: manifestDigest,
      volume: 'cauce-v3-prod_blobs_data',
      table_present: true,
      volume_present: true,
    };
    Object.assign(evidence, {
      schema_version: 2,
      blob_archive_file: 'backup.dump.blobs.tar',
      blob_archive_sha256: archiveDigest,
      blob_manifest_file: 'backup.dump.blobs.tsv',
      blob_manifest_sha256: manifestDigest,
      blob_volume: 'cauce-v3-prod_blobs_data',
      blob_table_present: true,
      blob_volume_present: true,
      blob_row_count: 1,
      blob_row_bytes: bytes.length,
      archived_blob_count: 1,
      blob_restore_verified: true,
      blob_restore_uid: 1000,
      blob_restore_network: 'none',
      blob_restore_row_count: 1,
    });
  }
  await writeFile(evidenceFile, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  const statusFile = join(directory, 'status.json');
  await writeFile(statusFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  await options.mutate?.({ dumpFile, evidenceFile, statusFile, archiveFile, manifestFile });
  return spawnSync(monitor, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      STATUS_FILE: statusFile,
      MAX_AGE_HOURS: options.maxAgeHours ?? '30',
      REQUIRE_RETENTION_PRESERVED: options.requireRetention ? '1' : '0',
      REQUIRE_BLOB_VOLUME: options.requireBlobs ? '1' : '0',
    },
  });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('host backup monitor', () => {
  test('the producer performs a full isolated restore and cannot propagate deletion off-host', async () => {
    const source = await readFile(backup, 'utf8');
    expect(source).toContain('--network none');
    expect(source).toContain('pg_restore -U postgres -d cauce_restore');
    expect(source).toContain('--exit-on-error --single-transaction');
    expect(source).toContain('rsync -a --ignore-existing');
    expect(source).toContain('--checksum --dry-run --itemize-changes');
    expect(source).not.toContain('rsync -a --delete');
    expect(source).toContain('cauce-v3-host-backup-restore');
    expect(source).toContain('docker volume create --label cauce.v3.backup-verify=true');
    expect(source).toContain("GROUP BY sha256 ORDER BY sha256");
    expect(source).toContain("$final.blobs.tar");
  });

  test('accepts a recent Cauce DB backup mirrored off-host with ut-nexus explicitly disabled', async () => {
    const result = await runMonitor(validStatus());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('overall=ok');
  });

  test('rejects a failed DB stage even if the aggregate flag says ok', async () => {
    const status = validStatus();
    status.db.status = 'failed';
    const result = await runMonitor(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('db: failed');
  });

  test('rejects a missing off-host DB mirror independently of the aggregate flag', async () => {
    const status = validStatus();
    status.offsite.db_status = 'skipped';
    const result = await runMonitor(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('offsite.db_status: skipped');
  });

  test('requires internally consistent disabled state for the optional workload', async () => {
    const status = validStatus();
    status.offsite.ut_nexus_status = 'ok';
    const result = await runMonitor(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('disabled state is internally inconsistent');
  });

  test('requires both local and off-host ut-nexus backups when explicitly enabled', async () => {
    const status = validStatus();
    status.ut_nexus = { enabled: true, status: 'ok', detail: '' };
    status.offsite.ut_nexus_status = 'failed';
    const result = await runMonitor(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('offsite.ut_nexus_status: failed');
  });

  test('fails closed on an unknown status schema', async () => {
    const status = validStatus();
    status.schema_version = 3;
    const result = await runMonitor(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported status schema_version=3');
  });

  test('rejects future and reversed run timestamps instead of treating negative age as fresh', async () => {
    const future = validStatus();
    future.run_started_utc = '2099-01-01T00:00:00Z';
    future.run_finished_utc = '2099-01-01T00:01:00Z';
    const futureResult = await runMonitor(future);
    expect(futureResult.status).toBe(1);
    expect(futureResult.stderr).toContain('run_finished_utc is in the future');
    expect(futureResult.stderr).toContain('negative age');

    const reversed = validStatus();
    reversed.run_started_utc = '2026-01-02T00:00:00Z';
    reversed.run_finished_utc = '2026-01-01T00:00:00Z';
    const reversedResult = await runMonitor(reversed);
    expect(reversedResult.status).toBe(1);
    expect(reversedResult.stderr).toContain('run_started_utc is after run_finished_utc');
  });

  test.each(['0', '-1', 'nan', 'inf', 'not-a-number'])(
    'rejects invalid MAX_AGE_HOURS=%s with a bounded diagnostic',
    async (maxAgeHours) => {
      const result = await runMonitor(validStatus(), { maxAgeHours });
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(
        'ALERT backup monitor MAX_AGE_HOURS must be a finite positive number\n',
      );
      expect(result.stderr).not.toContain('Traceback');
    },
  );

  test('rejects list-only backups and any offsite strategy that can propagate deletion', async () => {
    const status = validStatus();
    status.restore.status = 'skipped';
    status.offsite.strategy = 'mirror-with-delete';
    const result = await runMonitor(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('restore: skipped');
    expect(result.stderr).toContain('offsite.strategy: mirror-with-delete');
  });

  test('release mode requires an explicit no-retention snapshot', async () => {
    const status = validStatus();
    let result = await runMonitor(status, { requireRetention: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not preserve retention');
    status.retention = { skip_requested: true, status: 'preserved-for-release', days: 14 };
    result = await runMonitor(status, { requireRetention: true });
    expect(result.status).toBe(0);
  });

  test('authenticates status/evidence metadata and binds the evidence to actual dump bytes', async () => {
    const publicStatus = await runMonitor(validStatus(), {
      mutate: async ({ statusFile }) => chmod(statusFile, 0o644),
    });
    expect(publicStatus.status).toBe(1);
    expect(publicStatus.stderr).toContain('owned private single-link regular file');

    const replacedEvidence = await runMonitor(validStatus(), {
      mutate: async ({ evidenceFile }) => {
        const target = `${evidenceFile}.target`;
        await writeFile(target, '{}\n', { mode: 0o600 });
        await unlink(evidenceFile);
        await symlink(target, evidenceFile);
      },
    });
    expect(replacedEvidence.status).toBe(1);
    expect(replacedEvidence.stderr).toContain('restore evidence invalid');

    const changedDump = await runMonitor(validStatus(), {
      mutate: async ({ dumpFile }) => writeFile(dumpFile, 'different private backup bytes\n', { mode: 0o600 }),
    });
    expect(changedDump.status).toBe(1);
    expect(changedDump.stderr).toContain('checksum sidecar mismatch');
  });

  test('requires a verified blob archive and restored named volume when the blob API is enabled', async () => {
    const legacy = await runMonitor(validStatus(), { requireBlobs: true });
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toContain('requires schema 2 restore evidence');

    const verified = await runMonitor(validStatus(), { blobs: true, requireBlobs: true });
    expect(verified.status).toBe(0);

    const missingVolume = await runMonitor(validStatus(), {
      blobs: true,
      requireBlobs: true,
      mutate: async ({ evidenceFile }) => {
        const evidence = JSON.parse(await readFile(evidenceFile, 'utf8')) as Record<string, unknown>;
        evidence.blob_volume_present = false;
        await writeFile(evidenceFile, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
      },
    });
    expect(missingVolume.status).toBe(1);
    expect(missingVolume.stderr).toContain('blob restore evidence contract mismatch');
  });

  test('rejects blob bytes that disagree with the restored database even with updated checksums', async () => {
    const result = await runMonitor(validStatus(), {
      blobs: true,
      requireBlobs: true,
      mutate: async ({ manifestFile, evidenceFile, statusFile }) => {
        const manifest = await readFile(manifestFile, 'utf8');
        const changed = manifest.replace(/\t\d+\n$/u, '\t999\n');
        const digest = createHash('sha256').update(changed).digest('hex');
        await writeFile(manifestFile, changed, { mode: 0o600 });
        const evidence = JSON.parse(await readFile(evidenceFile, 'utf8')) as Record<string, unknown>;
        evidence.blob_manifest_sha256 = digest;
        evidence.blob_row_bytes = 999;
        await writeFile(evidenceFile, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
        const status = JSON.parse(await readFile(statusFile, 'utf8')) as ReturnType<typeof validStatus>;
        if (status.blobs === undefined) throw new Error('missing fixture blobs');
        status.blobs.manifest_sha256 = digest;
        await writeFile(statusFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('blob archive digest or restored row size differs');
  });

  test('rejects a changed blob archive and a foreign volume identity', async () => {
    const changed = await runMonitor(validStatus(), {
      blobs: true,
      requireBlobs: true,
      mutate: async ({ archiveFile }) => writeFile(archiveFile, 'changed archive\n', { mode: 0o600 }),
    });
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain('blob archive digest does not match status');

    const foreign = await runMonitor(validStatus(), {
      blobs: true,
      requireBlobs: true,
      mutate: async ({ statusFile }) => {
        const status = JSON.parse(await readFile(statusFile, 'utf8')) as ReturnType<typeof validStatus>;
        if (status.blobs === undefined) throw new Error('missing fixture blobs');
        status.blobs.volume = 'foreign_blobs_data';
        await writeFile(statusFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
      },
    });
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toContain('blob volume does not match the expected instance');
  });

  test('deploy accepts authenticated Hospital and central contracts and rejects missing blob proof', async () => {
    const source = await readFile(deploy, 'utf8');
    const marker = 'python3 - "$BACKUP_STATUS_FILE" "$BACKUP_BLOB_VOLUME"';
    const start = source.indexOf('import json\nimport pathlib\nimport sys\n', source.indexOf(marker));
    const end = source.indexOf('\nPY\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const verifier = source.slice(start, end);
    const directory = await mkdtemp(join(tmpdir(), 'cauce-blob-deploy-gate-'));
    scratch.push(directory);
    const dump = join(directory, 'backup.dump');
    const evidenceFile = `${dump}.restore.json`;
    const statusFile = join(directory, 'status.json');
    const check = async (schema: 2 | 4, volumePresent: boolean) => {
      const evidence = {
        schema_version: 2,
        suite: schema === 2 ? 'hospital-cauce-backup-restore' : 'cauce-v3-host-backup-restore',
        dump_file: 'backup.dump',
        full_restore: true,
        blob_table_present: true,
        blob_volume_present: volumePresent,
        blob_restore_verified: true,
      };
      const status = schema === 2
        ? { schema_version: 2, overall: 'ok', dump_file: dump, restore_evidence_file: evidenceFile }
        : {
            schema_version: 4,
            overall: 'ok',
            db: { file: dump },
            restore: { evidence_file: evidenceFile },
            blobs: { volume: 'cauce-v3-prod_blobs_data' },
          };
      await writeFile(evidenceFile, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
      await writeFile(statusFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
      return spawnSync('python3', ['-', statusFile, 'cauce-v3-prod_blobs_data'], {
        encoding: 'utf8',
        input: verifier,
      });
    };
    expect((await check(2, true)).status).toBe(0);
    expect((await check(4, true)).status).toBe(0);
    expect((await check(2, false)).status).toBe(1);
    expect((await check(4, false)).status).toBe(1);
  });

  test('migration 043 pre-build guard rejects active old blob API and indeterminate database state', async () => {
    const source = await readFile(deploy, 'utf8');
    const start = source.indexOf('check_blob_migration_window() {');
    const end = source.indexOf('\n}\ncheck_blob_migration_window', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.indexOf('check_blob_migration_window\nREQUIRE_BLOB_BACKUP')).toBeLessThan(source.indexOf('docker build -f deploy/Dockerfile'));
    expect(source).toContain("version='043_blob_tenant_entitlements.sql'");
    expect(source).toContain('REQUIRE_BLOB_VOLUME="$REQUIRE_BLOB_BACKUP"');
    expect(source).toContain('if [ "$REQUIRE_BLOB_BACKUP" = 1 ]; then');
    const guard = source.slice(start, end + 2);
    const directory = await mkdtemp(join(tmpdir(), 'cauce-043-deploy-gate-'));
    scratch.push(directory);
    const bin = join(directory, 'bin');
    const migrations = join(directory, 'packages/store/migrations');
    await mkdir(bin);
    await mkdir(migrations, { recursive: true });
    await writeFile(join(migrations, '043_blob_tenant_entitlements.sql'), '-- fixture\n');
    await writeFile(join(bin, 'docker'), String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'ps') {
  if (process.env.MOCK_PS_FAIL === '1') process.exit(1);
  process.stdout.write((process.env.MOCK_CONTAINERS || '') + '\n');
} else if (args[0] === 'inspect') {
  const target = args.at(-1);
  if (args.includes('{{.Image}}')) process.stdout.write(process.env.MOCK_GATEWAY_IMAGE + '\n');
  else process.stdout.write((target.includes('postgres') ? process.env.MOCK_PG_RUNNING : process.env.MOCK_GATEWAY_RUNNING) + '\n');
} else if (args[0] === 'image' && args[1] === 'inspect') {
  if (process.env.MOCK_IMAGE_INSPECT_FAIL === '1') process.exit(1);
  process.stdout.write((process.env.MOCK_COMPAT || '') + '\n');
} else if (args[0] === 'exec') {
  if (args.includes('psql')) {
    if (process.env.MOCK_PSQL_FAIL === '1') process.exit(1);
    process.stdout.write(process.env.MOCK_MIGRATION + '\n');
  } else if (args.includes('printenv')) {
    process.stdout.write(process.env.MOCK_GATEWAY_FLAG + '\n');
  }
} else if (args[0] === 'volume' && args[1] === 'ls') {
  process.stdout.write((process.env.MOCK_VOLUMES || '') + '\n');
}
`, { mode: 0o700 });
    const script = `set -euo pipefail\ndie() { echo "$*" >&2; exit 1; }\n${guard}\ncheck_blob_migration_window\nprintf '%s\\n' "$BLOB_MIGRATION_PENDING"\n`;
    const base = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      REPO: directory,
      PROJECT_NAME: 'cauce-v3-prod',
      PG_CONTAINER: 'cauce-v3-prod-postgres-1',
      GATEWAY_CONTAINER: 'cauce-v3-prod-gateway-1',
      PG_USER: 'cauce',
      PG_DB: 'cauce',
      BLOB_API_ENABLED: '0',
      MOCK_CONTAINERS: 'cauce-v3-prod-postgres-1\ncauce-v3-prod-gateway-1',
      MOCK_PG_RUNNING: 'true',
      MOCK_GATEWAY_RUNNING: 'true',
      MOCK_MIGRATION: '0',
      MOCK_GATEWAY_FLAG: '0',
      MOCK_GATEWAY_IMAGE: 'sha256:' + 'a'.repeat(64),
      MOCK_COMPAT: '043_blob_tenant_entitlements.sql',
    };
    const check = (overrides: Record<string, string> = {}) => spawnSync('bash', ['-c', script], {
      encoding: 'utf8', env: { ...base, ...overrides },
    });
    expect(check().stdout).toBe('1\n');
    expect(check({ MOCK_MIGRATION: '1', BLOB_API_ENABLED: '1' }).stdout).toBe('0\n');
    expect(check({ MOCK_MIGRATION: '1', BLOB_API_ENABLED: '1', MOCK_GATEWAY_FLAG: '1' }).stdout).toBe('0\n');
    expect(check({ MOCK_MIGRATION: '1', BLOB_API_ENABLED: '1', MOCK_GATEWAY_FLAG: '1', MOCK_COMPAT: '044_next.sql' }).stdout)
      .toBe('0\n');
    expect(check({ MOCK_MIGRATION: '1', MOCK_GATEWAY_FLAG: '1', MOCK_COMPAT: '042_blobs.sql' }).stderr)
      .toContain('incompatible con 043 aplicada');
    expect(check({ MOCK_MIGRATION: '1', MOCK_GATEWAY_FLAG: '1', MOCK_COMPAT: '' }).stderr)
      .toContain('sin label de compatibilidad valido');
    expect(check({ MOCK_MIGRATION: '1', MOCK_GATEWAY_FLAG: '1', MOCK_GATEWAY_IMAGE: 'unknown' }).stderr)
      .toContain('identidad indeterminada');
    expect(check({ MOCK_MIGRATION: '1', MOCK_GATEWAY_FLAG: '1', MOCK_IMAGE_INSPECT_FAIL: '1' }).stderr)
      .toContain('no pude inspeccionar la compatibilidad');
    expect(check({ MOCK_MIGRATION: '1', MOCK_GATEWAY_FLAG: 'unknown' }).stderr)
      .toContain('flag de blobs del gateway vivo indeterminado');
    expect(check({ MOCK_CONTAINERS: '' }).stdout).toBe('0\n');
    expect(check({ MOCK_CONTAINERS: '', MOCK_VOLUMES: 'cauce-v3-prod_cauce_pgdata' }).stderr)
      .toContain('estado de 043 indeterminado');
    expect(check({ MOCK_CONTAINERS: 'cauce-v3-prod-gateway-1' }).stderr)
      .toContain('estado de 043 indeterminado');
    expect(check({ BLOB_API_ENABLED: '1' }).stderr).toContain('CAUCE_BLOB_API_ENABLED=0');
    expect(check({ MOCK_GATEWAY_FLAG: '1' }).stderr).toContain('gateway anterior sigue');
    expect(check({ MOCK_PG_RUNNING: 'false' }).stderr).toContain('estado de la migracion 043 indeterminado');
    expect(check({ MOCK_MIGRATION: '2' }).stderr).toContain('estado ambiguo');
    expect(check({ MOCK_PSQL_FAIL: '1' }).stderr).toContain('no pude consultar schema_migrations');
    expect(check({ MOCK_PS_FAIL: '1' }).stderr).toContain('no pude enumerar contenedores');
  });

  test('the host producer publishes a blob restore only after archiving and restoring its named volume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-host-backup-producer-'));
    scratch.push(directory);
    const bin = join(directory, 'bin');
    const blobSource = join(directory, 'blob-source');
    const blobRestored = join(directory, 'blob-restored');
    const archiveRoot = join(directory, 'db');
    const statusRoot = join(directory, 'status');
    await Promise.all([mkdir(bin), mkdir(blobSource), mkdir(blobRestored), mkdir(statusRoot)]);
    const bytes = Buffer.from('producer blob fixture\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(blobSource, digest), bytes, { mode: 0o600 });
    const docker = join(bin, 'docker');
    await writeFile(docker, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG, args.join(' ') + '\n');
const command = args[0];
const whole = args.join(' ');
if (command === 'inspect') {
  process.stdout.write(whole.includes('.State.Running') ? 'true\n' : 'sha256:' + 'a'.repeat(64) + '\n');
} else if (command === 'exec') {
  if (whole.includes('pg_dump')) process.stdout.write('fixture database dump\n');
  else if (whole.includes('to_regclass')) process.stdout.write('t\n');
  else if (whole.includes('HAVING min(bytes)<>max(bytes)')) process.stdout.write('0\n');
  else if (whole.includes('COPY (SELECT sha256')) {
    process.stdout.write(process.env.MOCK_BLOB_DIGEST + '\t' + process.env.MOCK_BLOB_BYTES + '\n');
  } else if (whole.includes('information_schema.tables')) process.stdout.write('8\n');
  else if (whole.includes('SELECT count(*) FROM schema_migrations')) process.stdout.write('42\n');
} else if (command === 'volume') {
  if (args[1] === 'inspect' && process.env.MOCK_VOLUME_PRESENT === '0') process.exit(1);
  if (args[1] === 'create') process.stdout.write('f'.repeat(64) + '\n');
} else if (command === 'run') {
  if (args.includes('-d')) process.stdout.write('mock-container\n');
  else if (args.includes('--exclude=./tmp')) {
    process.exit(spawnSync('tar', ['-C', process.env.MOCK_BLOB_SOURCE, '--exclude=./tmp', '-cf', '-', '.'], { stdio: 'inherit' }).status ?? 1);
  } else if (args.includes('-xf')) {
    process.exit(spawnSync('tar', ['-C', process.env.MOCK_BLOB_RESTORED, '-xf', '-'], { stdio: 'inherit' }).status ?? 1);
  } else if (args.includes('-cf')) {
    process.exit(spawnSync('tar', ['-C', process.env.MOCK_BLOB_RESTORED, '-cf', '-', '.'], { stdio: 'inherit' }).status ?? 1);
  } else if (args.includes('sh')) {
    for (const line of fs.readFileSync(0, 'utf8').trim().split('\n')) {
      if (!line) continue;
      const [digest, expected] = line.split('\t');
      const data = fs.readFileSync(process.env.MOCK_BLOB_RESTORED + '/' + digest);
      if (data.length !== Number(expected) || createHash('sha256').update(data).digest('hex') !== digest) process.exit(1);
    }
  }
}
`, { mode: 0o700 });
    const rsync = join(bin, 'rsync');
    await writeFile(rsync, '#!/bin/sh\nprintf "%s\\n" "$*" >>"$MOCK_RSYNC_LOG"\n', { mode: 0o700 });
    const key = join(directory, 'offsite-key');
    await writeFile(key, 'fixture\n', { mode: 0o600 });
    const statusFile = join(statusRoot, 'status.json');
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      DB_BACKUP_DIR: archiveRoot,
      STATUS_DIR: statusRoot,
      OFFSITE_KEY: key,
      CAUCE_BACKUP_SKIP_RETENTION: '1',
      MOCK_DOCKER_LOG: join(directory, 'docker.log'),
      MOCK_RSYNC_LOG: join(directory, 'rsync.log'),
      MOCK_BLOB_SOURCE: blobSource,
      MOCK_BLOB_RESTORED: blobRestored,
      MOCK_BLOB_DIGEST: digest,
      MOCK_BLOB_BYTES: String(bytes.length),
      MOCK_VOLUME_PRESENT: '1',
    };
    const produced = spawnSync(backup, [], { encoding: 'utf8', env });
    expect(produced.status, produced.stderr).toBe(0);
    const monitored = spawnSync(monitor, [], {
      encoding: 'utf8',
      env: { ...env, STATUS_FILE: statusFile, MAX_AGE_HOURS: '24', REQUIRE_BLOB_VOLUME: '1', REQUIRE_RETENTION_PRESERVED: '1' },
    });
    expect(monitored.status, monitored.stderr).toBe(0);
    const producedStatus = JSON.parse(await readFile(statusFile, 'utf8')) as ReturnType<typeof validStatus>;
    expect(producedStatus.blobs?.archive_file).toMatch(/\.dump\.blobs\.tar$/u);
    const dockerLog = await readFile(env.MOCK_DOCKER_LOG, 'utf8');
    expect(dockerLog).toContain('volume create --label cauce.v3.backup-verify=true');
    expect(dockerLog).toContain('volume rm');
    const rsyncLog = await readFile(env.MOCK_RSYNC_LOG, 'utf8');
    expect(rsyncLog).toContain('--ignore-existing');
    expect(rsyncLog).toContain('--checksum --dry-run --itemize-changes');

    const missing = spawnSync(backup, [], { encoding: 'utf8', env: { ...env, MOCK_VOLUME_PRESENT: '0' } });
    expect(missing.status).toBe(1);
    const failedStatus = JSON.parse(await readFile(statusFile, 'utf8')) as ReturnType<typeof validStatus>;
    expect(failedStatus.overall).toBe('failed');
  });
});
