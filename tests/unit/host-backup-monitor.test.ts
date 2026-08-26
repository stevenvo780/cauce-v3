import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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

type MonitorPaths = { dumpFile: string; evidenceFile: string; statusFile: string };

async function runMonitor(
  status: unknown,
  options: {
    maxAgeHours?: string;
    requireRetention?: boolean;
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
  await writeFile(evidenceFile, `${JSON.stringify({
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
  })}\n`, { mode: 0o600 });
  const statusFile = join(directory, 'status.json');
  await writeFile(statusFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  await options.mutate?.({ dumpFile, evidenceFile, statusFile });
  return spawnSync(monitor, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      STATUS_FILE: statusFile,
      MAX_AGE_HOURS: options.maxAgeHours ?? '30',
      REQUIRE_RETENTION_PRESERVED: options.requireRetention ? '1' : '0',
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
});
