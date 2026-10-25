import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { browserDocker } from './browser-owned-lifecycle.js';
import { fireUserTimer, type prepareGuardRuntime } from './b2-guards-runtime.helpers.js';
import { isaTenant, type startContextFixture } from './context-multiuser-continuity.fixtures.js';

interface BackupStatus {
  overall: string; db: { status: string; file: string }; restore: { status: string; evidence_file: string; isolated: boolean; network: string };
  retention: { status: string }; ut_nexus: { enabled: boolean; status: string }; offsite: { db_status: string; db_detail: string };
}
interface ScriptResult { code: number; stdout: string; stderr: string }
async function removeOwnedBlobVolume(volume: string, owner: string) {
  const actual = (await browserDocker(['volume', 'inspect', '--format', '{{index .Labels "cauce.e2e.owner"}}', volume])).stdout.trim();
  if (actual !== owner) throw new Error('owned backup volume identity changed');
  await browserDocker(['volume', 'rm', volume]);
}
export async function verifyRealBackups(fixture: Awaited<ReturnType<typeof startContextFixture>>,
  runtime: Awaited<ReturnType<typeof prepareGuardRuntime>>, evidence: string) {
  const volume = `zz-canary-b2-blobs-${runtime.run}`;
  const bytes = `owned backup payload ${runtime.run}\n`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  await browserDocker(['volume', 'create', '--label', `cauce.e2e.owner=${runtime.run}`, volume]);
  try {
    await browserDocker(['run', '--rm', '--network', 'none', '--user', 'root', '--mount', `type=volume,src=${volume},dst=/blobs`,
      '--entrypoint', 'python3', runtime.image, '-c',
      'import os,pathlib,sys;root=pathlib.Path("/blobs");file=root/sys.argv[1];file.write_text(sys.argv[2]);root.chmod(0o700);os.chown(root,1000,1000);file.chmod(0o600);os.chown(file,1000,1000)', digest, bytes]);
    await fixture.database.pool.query(`INSERT INTO blobs(sha256,bytes,media_type,name,tenant_id,created_by)
      VALUES($1,$2,'text/plain','owned-backup.txt',$3,$4)`, [digest, Buffer.byteLength(bytes), isaTenant.tenant, isaTenant.target]);
    await runtime.execute(['python3', join(process.cwd(), 'tests/e2e/b2-backups-runtime.setup.py'),
      JSON.stringify({ repo: process.cwd(), volume, database: fixture.database.container.getId() })]);
    await runtime.user(['systemctl', '--user', 'daemon-reload']);
    await fireUserTimer(runtime, 'cauce-v3-host-backup', 1);
    await expect.poll(async () => {
      try { return JSON.parse((await runtime.execute(['cat', '/lab/status/status.json'])).stdout) as BackupStatus; }
      catch { return null; }
    }, { timeout: 180_000, interval: 500 }).not.toBeNull();
    const status = JSON.parse((await runtime.execute(['cat', '/lab/status/status.json'])).stdout) as BackupStatus;
    expect(status).toMatchObject({ overall: 'failed', db: { status: 'ok' }, restore: { status: 'ok', isolated: true, network: 'none' },
      ut_nexus: { enabled: false, status: 'disabled' }, offsite: { db_status: 'failed' }, retention: { status: 'not-run' } });
    expect(status.offsite.db_detail).toContain('/lab/key-does-not-exist');
    await runtime.execute(['test', '-f', '/lab/backups/cauce-20000101T000000Z.dump']);
    const restore = JSON.parse((await runtime.execute(['cat', status.restore.evidence_file])).stdout) as Record<string, unknown>;
    expect(restore).toMatchObject({ schema_version: 2, full_restore: true, core_table_count: 8, blob_row_count: 1,
      blob_restore_verified: true, blob_restore_uid: 1000, blob_restore_network: 'none', blob_restore_row_count: 1 });
    const database = fixture.database.container.getId();
    await browserDocker(['exec', database, 'createdb', '-U', 'cauce_test', 'cauce_test_backup_probe']);
    await runtime.execute(['sh', '-c', 'docker exec -i "$1" pg_restore -U cauce_test -d cauce_test_backup_probe --exit-on-error --single-transaction --no-owner --no-acl < "$2"',
      'owned-restore', database, status.db.file]);
    const restored = await browserDocker(['exec', database, 'psql', '-XAtq', '-U', 'cauce_test', '-d', 'cauce_test_backup_probe',
      '-c', `SELECT sha256||':'||bytes::text FROM blobs WHERE sha256='${digest}'`]);
    expect(restored.stdout.trim()).toBe(`${digest}:${String(Buffer.byteLength(bytes))}`);
    await fireUserTimer(runtime, 'cauce-v3-host-backup-monitor', 1);
    await expect.poll(async () => (await runtime.user(['systemctl', '--user', 'show', '--property=Result', '--value', 'cauce-v3-host-backup-monitor.service'])).stdout.trim(),
      { timeout: 10_000 }).toBe('exit-code');
    const monitorJournal = (await runtime.execute(['journalctl', '--no-pager', '_UID=1000', '_SYSTEMD_USER_UNIT=cauce-v3-host-backup-monitor.service'])).stdout;
    expect(monitorJournal).toContain('overall="failed"');
    await expect.poll(async () => (await runtime.execute(['journalctl', '--no-pager', 'SYSLOG_IDENTIFIER=cauce-v3-backup'])).stdout,
      { timeout: 10_000 }).toContain('UNIT FAILED: cauce-v3-host-backup.service');
    const alertJournal = (await runtime.execute(['journalctl', '--no-pager', 'SYSLOG_IDENTIFIER=cauce-v3-backup'])).stdout;
    await runtime.execute(['python3', '-c', 'import pathlib,sys;file=pathlib.Path(sys.argv[1]);file.write_bytes(file.read_bytes()+b"tampered")', status.db.file]);
    const tampered = await runtime.user(['python3', '-c',
      'import json,os,subprocess,sys;result=subprocess.run(["sh",sys.argv[1]],env=dict(os.environ,STATUS_FILE="/lab/status/status.json",BLOB_VOLUME=sys.argv[2],REQUIRE_BLOB_VOLUME="1"),capture_output=True,text=True);print(json.dumps({"code":result.returncode,"stdout":result.stdout,"stderr":result.stderr}))',
      join(process.cwd(), 'ops/scripts/host-backup-monitor.sh'), volume]);
    const tamperResult = JSON.parse(tampered.stdout) as ScriptResult;
    expect(tamperResult.code).toBe(1);
    expect(tamperResult.stderr).toContain('database dump checksum sidecar mismatch');
    await writeFile(join(evidence, 'backup.json'), JSON.stringify({ status, restore, restored_blob: restored.stdout.trim(),
      tamper_result: tamperResult, monitor_journal: monitorJournal, alert_journal: alertJournal,
      scope: 'real local backup and isolated restore; missing offsite key deliberately prevents SSH and retention' }, null, 2), { mode: 0o600 });
  } finally {
    await removeOwnedBlobVolume(volume, runtime.run);
  }
}
