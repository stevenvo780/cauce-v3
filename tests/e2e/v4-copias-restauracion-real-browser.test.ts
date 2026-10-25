import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { backupFailure, safeBackupFailure, SpaceBackupFailureSchema } from '../../services/gateway/src/fleet/space-backup.failure.js';
import { browserDocker } from './browser-owned-lifecycle.js';
import type { V4Page } from './v4-console-real-browser.helpers.js';
import { LARGE_BYTES, RUN, SMALL_FILES, TASK, agentPython, capture, receipt,
  startCopyRestorationFixture, type CopyRestorationFixture } from './v4-copias-restauracion.runtime.js';
import calibration from './v4-copias-rendimiento.calibration.json' with { type: 'json' };
import { installBackupMeasurement, collectBackupMeasurement } from './v4-copias-rendimiento.js';

function measuredBudget(scenario:'large'|'many') {
  const samples=calibration[scenario];
  const ready=Math.ceil(Math.max(...samples.map(sample=>sample.ready_ms))*calibration.margin);
  const total=Math.ceil(Math.max(...samples.map(sample=>sample.ready_ms+sample.browser_download_ms+sample.restore_ms+sample.agent_read_ms))*calibration.margin);
  return {ready,total,source_shas:[...new Set(samples.map(sample=>sample.source_sha))],
    source_receipts:samples.map(sample=>sample.source_receipt),margin:calibration.margin};
}

interface BackupRow {
  id: string; status: string; error: string | null; bytes: string | null; received_bytes: string;
  sha256: string | null; manifest_sha256: string | null;
  claim_epoch: number; lease_until: string | null; created_at: string; expires_at: string;
}
interface ManifestFile { path: string; bytes: number; sha256: string }
interface ArchiveInspection {
  identity: Record<string, string>; manifest_sha256: string; files: ManifestFile[]; omissions: unknown[]; entries: string[];
}
interface Download { path(): Promise<string | null>; failure(): Promise<string | null>; suggestedFilename(): string }
interface DownloadPage extends V4Page { waitForEvent(event: 'download', options: { timeout: number }): Promise<Download> }
interface Seed { files: number; bytes: number; allocated_bytes: number; reader_path: string; reader_bytes: number; reader_sha256: string }

async function backupDiagnostics(f: CopyRestorationFixture, row: BackupRow | undefined, phase: string) {
  const result: Record<string, unknown> = { phase, row: row ?? null };
  if (row) {
    try {
      const events = await f.computer.pool.query<{ created_at: string; failure: unknown }>(`SELECT created_at::text,
        metadata->'failure' AS failure FROM audit_events WHERE company_id=$1 AND tenant_id=$2 AND actor_alias=$3
        AND action='space.backup.failed' AND metadata->>'id'=$4 AND metadata->>'host_id'=$5
        AND metadata->>'claim_epoch'=$6 AND metadata->>'error'=$7 ORDER BY created_at DESC LIMIT 10`,
      [f.company, f.tenant, f.alias, row.id, f.host, String(row.claim_epoch), row.error]);
      result.audit = events.rows.map(event => {
        const parsed = SpaceBackupFailureSchema.safeParse(event.failure);
        return { created_at: event.created_at, failure: parsed.success ? safeBackupFailure(parsed.data) : null };
      });
    } catch (error) { result.audit_error = backupFailure(error); }
  }
  try {
    const journal = await browserDocker(['exec', '--user', 'cauce', '-e', 'HOME=/home/cauce',
      '-e', 'XDG_RUNTIME_DIR=/run/user/1500', f.computer.prefix, 'timeout', '15s', 'journalctl', '--user', '-u',
      `cauce-v3-host-executor-${f.company}-${f.host}.service`, '--no-pager', '-o', 'cat', '-n', '1000'],
    { timeout: 25_000, maxBuffer: 512 * 1024 });
    result.journal = journal.stdout.split('\n').flatMap<Record<string, unknown>>(line => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.event === 'space_backup_failure' && event.id === row?.id) {
          const parsed = SpaceBackupFailureSchema.safeParse(event.failure);
          return [{ event: event.event, failure: parsed.success ? safeBackupFailure(parsed.data) : null }];
        }
        if (event.event === 'space_backup_metrics' && event.backup_id === row?.id) {
          return [{ event: event.event, python_peak_rss_kib: event.python_peak_rss_kib, node_max_rss_kib: event.node_max_rss_kib }];
        }
      } catch { return []; }
      return [];
    });
  } catch (error) { result.journal_error = backupFailure(error); }
  await receipt(`${f.scenario}-backup-${phase}`, result);
  return result;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
async function sourceHashes(f: CopyRestorationFixture, files: ManifestFile[], restored?: string): Promise<Record<string, string>> {
  return JSON.parse(await agentPython(f, `import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); output={}
for relative in json.loads(sys.argv[2]):
 path=root/relative
 if not path.resolve().is_relative_to(root.resolve()): raise ValueError('file escaped the owned root')
 digest=hashlib.sha256()
 with path.open('rb') as stream:
  while chunk:=stream.read(1024*1024): digest.update(chunk)
 output[relative]=digest.hexdigest()
print(json.dumps(output))
`, [restored ?? join(f.agent.state_directory, 'space'), JSON.stringify(files.map(file => file.path))])) as Record<string, string>;
}
async function seedSpace(f: CopyRestorationFixture): Promise<Seed> {
  return JSON.parse(await agentPython(f, `import hashlib,json,os,pathlib,sys
space=pathlib.Path(sys.argv[1])/'space'; scenario=sys.argv[2]
for name in ('context','directives','projects','config','data'):
 (space/name).mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(space/name,0o700)
files={'context/recovery.md':b'Contexto recuperable.\\n','directives/rules.md':b'Conservar el espacio de laboratorio.\\n',
 'projects/work.txt':b'Proyecto recuperable.\\n','data/rows.jsonl':b'{"row":1}\\n'}
for relative,data in files.items():
 (space/relative).write_bytes(data);os.chmod(space/relative,0o600)
if scenario=='large':
 relative='projects/large.bin';path=space/relative;remaining=int(sys.argv[3]);digest=hashlib.sha256();chunk=os.urandom(1024*1024)
 with path.open('wb') as stream:
  while remaining:
   piece=chunk[:min(len(chunk),remaining)];stream.write(piece);digest.update(piece);remaining-=len(piece)
 os.chmod(path,0o600);info=path.stat();count=len(files)+1
else:
 directory=space/'projects/many';directory.mkdir(mode=0o700);count=int(sys.argv[4])+len(files)
 for number in range(int(sys.argv[4])):
  path=directory/f'file-{number:05d}.bin';path.write_bytes(number.to_bytes(4,'big')+os.urandom(4092));os.chmod(path,0o600)
 relative='projects/many/file-00000.bin';path=space/relative;digest=hashlib.sha256(path.read_bytes());info=path.stat()
print(json.dumps({'files':count,'bytes':sum(p.stat().st_size for p in space.rglob('*') if p.is_file()),
 'allocated_bytes':info.st_blocks*512,'reader_path':relative,'reader_bytes':info.st_size,'reader_sha256':digest.hexdigest()}))
`, [f.agent.state_directory, f.scenario, String(LARGE_BYTES), String(SMALL_FILES)])) as Seed;
}
async function downloadCopy(f: CopyRestorationFixture, ready: BackupRow) {
  const page = f.page; const panel = page.getByRole('region', { name: 'Backup del espacio', exact: true });
  const pickerAvailable = await page.evaluate(() => typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker);
  await page.evaluate(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const waitDownload = (page as DownloadPage).waitForEvent('download', { timeout: 180_000 });
  await panel.getByRole('button', { name: 'Descargar backup ZIP', exact: true }).click();
  const download = await waitDownload; const archive = join(f.directory, 'downloaded-space.zip'); const browserPath = await download.path();
  if (!browserPath || !/^\/tmp\/playwright-artifacts-[A-Za-z0-9]+\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(browserPath)) {
    throw new Error('download path is outside the owned Chromium artifacts');
  }
  expect(await download.failure()).toBeNull();
  const browserId = (await browserDocker(['inspect', '--format', '{{.Id}}', f.browser.container])).stdout.trim();
  expect(browserId).toBe(f.browser.containerId);
  await browserDocker(['cp', `${browserId}:${browserPath}`, archive], { timeout: 180_000 }); await chmod(archive, 0o600);
  expect((await stat(archive)).size).toBe(Number(ready.bytes)); expect(await hashFile(archive)).toBe(ready.sha256);
  expect(await hashFile(join(f.storage, `${ready.id}.zip`))).toBe(ready.sha256);
  await capture(page, `${f.scenario}-browser-download`, panel.getByText('Descarga iniciada en el navegador: si no aparece, la copia pudo vencer o no tienes permiso; vuelve a generarla.', { exact: true }));
  return { archive, channel: 'real-playwright-download-event', browser_container_id: browserId, browser_artifact_path: browserPath,
    picker_before: pickerAvailable, picker_disabled_for_native_anchor: true, suggested_filename: download.suggestedFilename(), sha256: ready.sha256 };
}
async function readRestored(f: CopyRestorationFixture, restoredFile: string, seed: Seed) {
  const page = f.page; const prompt = `RESTORED_READ_PATH=${restoredFile}`; expect(prompt).not.toContain(seed.reader_sha256);
  await page.goto(`${f.baseUrl}/messages/${f.tenant}/${f.alias}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(`Mensaje para ${f.alias}`, { exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  let delivery: { message_id: string; delivery_id: string; status: string; reply: string | null; last_error: string | null } | undefined;
  await expect.poll(async () => {
    delivery = (await f.computer.pool.query<NonNullable<typeof delivery>>(`SELECT m.id::text AS message_id,d.id::text AS delivery_id,
      d.status,d.result->'output'->>'reply' AS reply,d.last_error FROM messages m JOIN deliveries d ON d.message_id=m.id
      WHERE m.tenant_id=$1 AND m.actor_alias='owner' AND m.body->>'text'=$2 AND d.recipient_alias=$3
      ORDER BY m.created_at DESC LIMIT 1`, [f.tenant, prompt, f.alias])).rows[0];
    return delivery?.status;
  }, { timeout: 90_000, interval: 500 }).toBe('done');
  if (!delivery?.reply) throw new Error('synthetic reader did not return its real file read');
  const read = JSON.parse(delivery.reply) as { reader: string; bytes: number; sha256: string; pid: number; peak_rss_kib: number };
  expect(read).toMatchObject({ reader: 'synthetic-provider-real-filesystem', sha256: seed.reader_sha256, bytes: seed.reader_bytes });
  expect(read.pid).toBeGreaterThan(0); expect(read.peak_rss_kib).toBeLessThan(128 * 1024); expect(delivery.last_error).toBeNull();
  expect((await f.computer.pool.query("SELECT 1 FROM delivery_acks WHERE delivery_id=$1 AND status='done' AND applied=true", [delivery.delivery_id])).rowCount).toBe(1);
  await page.goto(`${f.baseUrl}/messages/${f.tenant}/${f.alias}`, { waitUntil: 'domcontentloaded' });
  const reply = page.getByRole('region', { name: `Respuesta canónica de ${f.tenant}:${f.alias}`, exact: true }).getByText(delivery.reply, { exact: true });
  await reply.waitFor({ timeout: 30_000 }); await capture(page, `${f.scenario}-restored-file-response`, reply);
  return { ...delivery, input: prompt, filesystem_read: read, expected_contents_in_prompt: false, ui_response_visible: true };
}

describe.each(['large', 'many'] as const)('copia completa por streaming del espacio %s', scenario => {
  let fixture: CopyRestorationFixture | undefined;
  const active = () => { if (!fixture) throw new Error('copy fixture is not initialized'); return fixture; };
  beforeAll(async () => { fixture = await startCopyRestorationFixture(scenario); }, 600_000);
  afterAll(async () => { await fixture?.close(); }, 240_000);
  it('crea en consola, descarga en Chromium, restaura y responde leyendo el archivo restaurado', async () => {
    const f = active(); const page = f.page; const pool = f.computer.pool; const preparation=performance.now();const seed = await seedSpace(f);
    if (scenario === 'large') { expect(seed.reader_bytes).toBe(LARGE_BYTES); expect(seed.allocated_bytes).toBeGreaterThanOrEqual(LARGE_BYTES); }
    else expect(seed.files).toBe(SMALL_FILES + 4);
    await installBackupMeasurement(f);const preparationMs=performance.now()-preparation;const started=performance.now();const budget=measuredBudget(scenario);
    await page.goto(`${f.baseUrl}/messages/${f.tenant}/${f.alias}?view=context`, { waitUntil: 'domcontentloaded' });
    const panel = page.getByRole('region', { name: 'Backup del espacio', exact: true });
    await panel.getByText('No hay copias guardadas de este espacio.', { exact: true }).waitFor({ timeout: 30_000 }); f.errors.assertClean();
    await panel.getByRole('button', { name: 'Crear backup del espacio', exact: true }).click();
    let ready: BackupRow | undefined;
    try {
      await expect.poll(async () => {
        ready = (await pool.query<BackupRow>(`SELECT id::text,status,error,bytes::text,received_bytes::text,sha256,manifest_sha256,
          claim_epoch,lease_until::text,created_at::text,expires_at::text
          FROM space_backups WHERE tenant_id=$1 AND alias=$2 ORDER BY created_at DESC LIMIT 1`, [f.tenant, f.alias])).rows[0];
        return ready && ['ready', 'failed'].includes(ready.status);
      }, { timeout: budget.ready, interval: 1_000 }).toBe(true);
    } catch (error) { await backupDiagnostics(f, ready, 'timeout'); throw error; }
    if (!ready) throw new Error('new backup row is absent');
    const readyId = ready.id;
    const diagnostics = await backupDiagnostics(f, ready, 'terminal');
    expect(ready, JSON.stringify(diagnostics)).toMatchObject({ status: 'ready', error: null });
    expect(Number(ready.bytes)).toBeGreaterThan(seed.bytes);
    const available = panel.getByText('Backup disponible', { exact: true }); await available.waitFor({ timeout: 30_000 });
    await capture(page, `${scenario}-backup-ready`, available); const exportMs = performance.now() - started;
    const measurement=await collectBackupMeasurement(f,readyId);
    await receipt(`${scenario}-upload-measurement`,{...measurement,ready_ms:exportMs,preparation_ms:preparationMs,budget});
    const downloadStarted = performance.now(); const download = await downloadCopy(f, ready); const downloadMs = performance.now() - downloadStarted;
    const inspection = JSON.parse(await agentPython(f, `import json,pathlib,sys
parent=pathlib.Path(sys.argv[1]);parent.mkdir(mode=0o700)
print(json.dumps({'archive':str(parent/'downloaded.zip'),'destination':sys.argv[2]}))
`, [join(f.agent.state_directory, `download-${RUN}`), join(f.agent.state_directory, `restored-${RUN}`)])) as { archive: string; destination: string };
    await docker(['cp', download.archive, `${f.agent.container_name}:${inspection.archive}`]);
    await docker(['exec', '--user', '0', f.agent.container_name, 'chown', `${f.agent.runtime_user}:${f.agent.runtime_user}`, inspection.archive]);
    await agentPython(f, 'import os,sys;os.chmod(sys.argv[1],0o600)', [inspection.archive]);
    const manifest = JSON.parse(await agentPython(f, `import hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 raw=archive.read('space-manifest.json');manifest=json.loads(raw)
 print(json.dumps({'identity':manifest['identity'],'manifest_sha256':hashlib.sha256(raw).hexdigest(),
  'files':manifest['files'],'omissions':manifest['omissions'],'entries':archive.namelist()}))
`, [inspection.archive])) as ArchiveInspection;
    expect(manifest.identity).toEqual({ company_id: f.company, tenant_id: f.tenant, alias: f.alias, runtime_key: f.runtimeKey });
    expect(manifest.manifest_sha256).toBe(ready.manifest_sha256);
    expect(manifest.files.find(file => file.path === seed.reader_path)).toMatchObject({ bytes: seed.reader_bytes, sha256: seed.reader_sha256 });
    expect(manifest.files.length).toBe(seed.files);
    const source = await sourceHashes(f, manifest.files); expect(source).toEqual(Object.fromEntries(manifest.files.map(file => [file.path, file.sha256])));
    const removed = JSON.parse(await agentPython(f, `import json,pathlib,sys
path=pathlib.Path(sys.argv[1])/sys.argv[2];path.unlink();print(json.dumps({'path':str(path),'absent':not path.exists()}))
`, [join(f.agent.state_directory, 'space'), seed.reader_path])) as { path: string; absent: boolean }; expect(removed.absent).toBe(true);
    const restoreStarted = performance.now();
    const restoreArgs = ['bash', '/cauce/executor/cauce', 'spaces', 'restore', '--archive', inspection.archive, '--directory', inspection.destination,
      '--company-id', f.company, '--tenant-id', f.tenant, '--alias', f.alias, '--runtime-key', f.runtimeKey];
    const restored = JSON.parse(await agentPython(f, `import json,resource,subprocess,sys
result=subprocess.run(sys.argv[1:],capture_output=True,text=True)
if result.returncode: sys.exit(result.stderr)
print(json.dumps({'receipt':json.loads(result.stdout),'peak_rss_kib':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss}))
`, restoreArgs)) as { receipt: { state: string; identity: Record<string, string>; files: number; bytes: number }; peak_rss_kib: number };
    expect(restored.receipt).toMatchObject({ state: 'restored', identity: manifest.identity, files: manifest.files.length });
    expect(restored.peak_rss_kib).toBeLessThan(128 * 1024);
    const restoredHashes = await sourceHashes(f, manifest.files, inspection.destination); expect(restoredHashes).toEqual(source);
    const restoreMs = performance.now() - restoreStarted; const readStarted = performance.now();
    const bus = await readRestored(f, join(inspection.destination, seed.reader_path), seed); const readMs = performance.now() - readStarted;
    const journal = await f.computer.onComputer(['journalctl', '--user', '-u', `cauce-v3-host-executor-${f.company}-${f.host}.service`, '--no-pager', '-o', 'cat']);
    expect(journal.code).toBe(0);
    const metrics = journal.stdout.split('\n').filter(line => line.includes('"event":"space_backup_metrics"'))
      .map(line => JSON.parse(line) as { backup_id: string; python_peak_rss_kib: number; node_max_rss_kib: number })
      .find(metric => metric.backup_id === readyId);
    expect(metrics).toBeDefined(); expect(metrics?.python_peak_rss_kib).toBeGreaterThan(0); expect(metrics?.python_peak_rss_kib).toBeLessThan(128 * 1024);
    const workerPeak = await f.computer.onComputer(['python3', '-I', '-B', '-c', `import json,pathlib,re,subprocess,sys
pid=int(subprocess.check_output(['systemctl','--user','show','-p','MainPID','--value',sys.argv[1]],text=True))
if pid<=0: raise ValueError('backup worker is not running')
status=pathlib.Path(f'/proc/{pid}/status').read_text()
match=re.search(r'^VmHWM:\\s+(\\d+) kB$',status,re.M)
if match is None: raise ValueError('worker peak RSS is unavailable')
print(json.dumps({'node_pid':pid,'node_peak_rss_kib_after_finish':int(match.group(1))}))
`, `cauce-v3-host-executor-${f.company}-${f.host}.service`]);
    expect(workerPeak.code).toBe(0);
    const memory = JSON.parse(workerPeak.stdout) as { node_pid: number; node_peak_rss_kib_after_finish: number };
    expect(memory.node_peak_rss_kib_after_finish).toBeGreaterThan(0);
    expect(memory.node_peak_rss_kib_after_finish).toBeLessThan(768 * 1024);
    await receipt(`${scenario}-restore-and-read`, { task: TASK, run: RUN, scenario, synthetic_provider: true, commercial_provider: false,
      native_administration: false, seed, backup: ready, download, manifest, source_hashes: source, original_file_removed: removed,
      restored_hashes: restoredHashes, restore: { argv: restoreArgs, ...restored }, worker_metrics: { ...metrics, ...memory }, bus,
      elapsed_ms: { preparation:preparationMs,export: exportMs, browser_download: downloadMs, restore: restoreMs, agent_read: readMs, total: performance.now() - started } });
    f.errors.assertClean();
  }, measuredBudget(scenario).total+60_000);
});
