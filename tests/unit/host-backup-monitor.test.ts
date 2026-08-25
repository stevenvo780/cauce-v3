import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const monitor = join(repository, 'ops/scripts/host-backup-monitor.sh');
const backup = join(repository, 'ops/scripts/host-backup.sh');
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
    overall: 'ok',
  };
}

async function runMonitor(status: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-backup-monitor-'));
  scratch.push(directory);
  const typed = status as ReturnType<typeof validStatus>;
  const evidenceFile = join(directory, 'backup.dump.restore.json');
  typed.restore.evidence_file = evidenceFile;
  await writeFile(evidenceFile, `${JSON.stringify({
    schema_version: 1,
    suite: 'cauce-v3-host-backup-restore',
    verified_at_utc: typed.run_finished_utc,
    dump_file: 'backup.dump',
    dump_sha256: 'a'.repeat(64),
    database_image_digest: `sha256:${'b'.repeat(64)}`,
    isolated: true,
    network: 'none',
    full_restore: true,
    core_table_count: 8,
    applied_migration_count: 29,
  })}\n`, { mode: 0o600 });
  const statusFile = join(directory, 'status.json');
  await writeFile(statusFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  return spawnSync(monitor, [], {
    encoding: 'utf8',
    env: { ...process.env, STATUS_FILE: statusFile, MAX_AGE_HOURS: '30' },
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
    const directory = await mkdtemp(join(tmpdir(), 'cauce-backup-release-monitor-'));
    scratch.push(directory);
    const statusFile = join(directory, 'status.json');
    const evidenceFile = join(directory, 'backup.dump.restore.json');
    status.restore.evidence_file = evidenceFile;
    await writeFile(evidenceFile, `${JSON.stringify({
      schema_version: 1,
      suite: 'cauce-v3-host-backup-restore',
      dump_file: 'backup.dump',
      dump_sha256: 'a'.repeat(64),
      database_image_digest: `sha256:${'b'.repeat(64)}`,
      isolated: true,
      network: 'none',
      full_restore: true,
      core_table_count: 8,
      applied_migration_count: 29,
    })}\n`, { mode: 0o600 });
    await writeFile(statusFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    let result = spawnSync(monitor, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        STATUS_FILE: statusFile,
        MAX_AGE_HOURS: '30',
        REQUIRE_RETENTION_PRESERVED: '1',
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not preserve retention');
    status.retention = { skip_requested: true, status: 'preserved-for-release', days: 14 };
    await writeFile(statusFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    result = spawnSync(monitor, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        STATUS_FILE: statusFile,
        MAX_AGE_HOURS: '30',
        REQUIRE_RETENTION_PRESERVED: '1',
      },
    });
    expect(result.status).toBe(0);
  });
});
