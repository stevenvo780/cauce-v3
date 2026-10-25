import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { browserDocker } from './browser-owned-lifecycle.js';
import { apiGet, type V4Page } from './v4-console-real-browser.helpers.js';
import { ALIAS, OVERSIZED_BYTES, RUN, RUNTIME_KEY, SUPPORTED_BYTES, TASK, agentPython, capture,
  receipt, startCopyRestorationFixture, type CopyRestorationFixture } from './v4-copias-restauracion.runtime.js';

interface BackupRow {
  id: string; status: string; error: string | null; bytes: string | null; received_bytes: string; sha256: string | null; manifest_sha256: string | null;
}
interface ManifestFile { path: string; bytes: number; sha256: string }
interface ArchiveInspection {
  identity: Record<string, string>; manifest_sha256: string; files: ManifestFile[]; omissions: unknown[]; entries: string[];
}
interface Download {
  path(): Promise<string | null>; failure(): Promise<string | null>; suggestedFilename(): string;
}
interface DownloadPage extends V4Page { waitForEvent(event: 'download', options: { timeout: number }): Promise<Download> }
let fixture: CopyRestorationFixture | undefined;
let seed: { expected_files: Record<string, string>; context_base64: string; logical_bytes: number; allocated_bytes: number; sparse: boolean };
let failedBackup = '';
const active = () => { if (!fixture) throw new Error('copy restoration fixture is not initialized'); return fixture; };
const pool = () => active().computer.pool;
const backupPath = () => `/v3/console/spaces/${active().tenant}/${ALIAS}/backups`;
const panel = () => active().page.getByRole('region', { name: 'Backup del espacio', exact: true });

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function backupRows(): Promise<BackupRow[]> {
  return (await pool().query<BackupRow>(`SELECT id::text,status,error,bytes::text,received_bytes::text,sha256,manifest_sha256
    FROM space_backups WHERE tenant_id=$1 AND alias=$2 ORDER BY created_at,id`, [active().tenant, ALIAS])).rows;
}

async function waitBackup(previous: string[], status: 'ready' | 'failed'): Promise<BackupRow> {
  let row: BackupRow | undefined;
  try {
    await expect.poll(async () => {
      row = (await backupRows()).find(candidate => !previous.includes(candidate.id));
      return row && ['ready', 'failed'].includes(row.status);
    }, { timeout: 420_000, interval: 1_000 }).toBe(true);
  } catch (error) {
    await receipt('backup-wait-timeout', { expected_status: status, last_observed: row, timeout_ms: 420_000 });
    throw error;
  }
  if (!row) throw new Error('new backup row is absent');
  expect(row, JSON.stringify(row)).toMatchObject({ status });
  return row;
}

async function sourceHashes(files: ManifestFile[], restored?: string): Promise<Record<string, string>> {
  return JSON.parse(await agentPython(active(), `import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); output={}
for relative in json.loads(sys.argv[2]):
 path=root/relative
 if not path.resolve().is_relative_to(root.resolve()): raise ValueError('file escaped the owned root')
 digest=hashlib.sha256()
 with path.open('rb') as stream:
  while chunk:=stream.read(1024*1024): digest.update(chunk)
 output[relative]=digest.hexdigest()
print(json.dumps(output))
`, [restored ?? join(active().agent.state_directory, 'space'), JSON.stringify(files.map(file => file.path))])) as Record<string, string>;
}

beforeAll(async () => { fixture = await startCopyRestorationFixture(); }, 600_000);
afterAll(async () => { await fixture?.close(); }, 240_000);

describe('copias de espacio y restauración con proveedor sintético que lee archivos reales', () => {
  it('rechaza el fichero sintético de 1 GB decimal desde la consola sin entregar una copia incompleta', async () => {
    const started = performance.now();
    seed = JSON.parse(await agentPython(active(), `import base64,hashlib,json,os,pathlib,sys,uuid
space=pathlib.Path(sys.argv[1])/'space'
for name in ('context','directives','projects','config','data'):
 (space/name).mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(space/name,0o700)
context=('Archivo restaurado '+uuid.uuid4().hex+'\\n').encode()
files={'context/recovery.md':context,'directives/rules.md':b'Conservar el espacio de laboratorio.\\n',
 'projects/work.txt':b'Proyecto de prueba recuperable.\\n','data/rows.jsonl':b'{"row":1}\\n'}
for relative,data in files.items():
 (space/relative).write_bytes(data);os.chmod(space/relative,0o600)
large=space/'projects/large.bin'
with large.open('wb') as stream: stream.truncate(int(sys.argv[2]))
os.chmod(large,0o600);info=large.stat()
print(json.dumps({'expected_files':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()},
 'context_base64':base64.b64encode(context).decode(),'logical_bytes':info.st_size,'allocated_bytes':info.st_blocks*512,
 'sparse':info.st_blocks*512<info.st_size}))
`, [active().agent.state_directory, String(OVERSIZED_BYTES)])) as typeof seed;
    expect(seed.logical_bytes).toBe(OVERSIZED_BYTES);
    expect(seed.sparse).toBe(true);
    const page = active().page;
    const nativePath = `/v3/console/tenants/${active().tenant}/agents/${ALIAS}/native/skill`;
    active().errors.expectHttpError(nativePath, 501);
    await page.goto(`${active().baseUrl}/messages/${active().tenant}/${ALIAS}?view=context`, { waitUntil: 'domcontentloaded' });
    await panel().getByText('No hay copias guardadas de este espacio.', { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByText('Piezas nativas · MCP, skills y subagentes', { exact: true }).click();
    const nativeEditor = page.getByRole('region', { name: 'Editor de piezas nativas', exact: true });
    active().errors.expectHttpError(nativePath, 501);
    await nativeEditor.getByRole('button', { name: 'Leer inventario nativo', exact: true }).click();
    const nativeUnavailable = nativeEditor.getByRole('alert').getByText('Este arnés o esta cuenta no publica edición nativa para este tipo.', { exact: true });
    await nativeUnavailable.waitFor({ timeout: 30_000 });
    expect(await nativeEditor.getByRole('button', { name: 'Guardar pieza nativa', exact: true }).isDisabled()).toBe(true);
    expect(await nativeEditor.getByRole('button', { name: 'Borrar pieza nativa', exact: true }).isDisabled()).toBe(true);
    active().errors.expectHttpError(nativePath, 501);
    const nativeResponse = await apiGet(page, nativePath);
    expect(nativeResponse).toEqual({ status: 501, body: { error: 'unsupported',
      message: 'Este arnés no publica edición nativa para este tipo o esta cuenta.' } });
    const nativeConsoleErrors = active().errors.trace.filter(line => line.includes(nativePath) && line.includes('status of 501')).length;
    expect(nativeConsoleErrors).toBe(4);
    await capture(page, 'native-administration-unavailable', nativeUnavailable);
    await receipt('native-administration-unavailable', { native_administration: false, method: 'GET', path: nativePath,
      response: nativeResponse, console_501_count: nativeConsoleErrors, ui_explanation: await nativeUnavailable.innerText(),
      save_disabled: true, delete_disabled: true });
    await panel().getByRole('button', { name: 'Crear backup del espacio', exact: true }).click();
    const row = await waitBackup([], 'failed'); failedBackup = row.id;
    expect(row).toMatchObject({ error: 'LIMIT_EXCEEDED', bytes: null, sha256: null, manifest_sha256: null, received_bytes: '0' });
    const failed = panel().getByText('El backup falló', { exact: true });
    await failed.waitFor({ timeout: 30_000 });
    await panel().getByText(/El espacio supera el límite de tamaño del backup|Revisa el tamaño del espacio y la capacidad del ordenador/u)
      .waitFor({ timeout: 30_000 });
    expect(await panel().getByRole('button', { name: 'Descargar backup ZIP', exact: true }).count()).toBe(0);
    expect((await apiGet(page, `${backupPath()}/${row.id}`))).toMatchObject({ status: 200, body: { status: 'failed', error: 'LIMIT_EXCEEDED', download_url: null } });
    await capture(page, 'one-gb-rejected', failed);
    await receipt('one-gb-rejection', { task: TASK, run: RUN, result: 'SUPPORTED_LIMIT_REPRODUCED',
      requested_file_bytes: OVERSIZED_BYTES, sparse: seed.sparse, logical_bytes: seed.logical_bytes, allocated_bytes: seed.allocated_bytes,
      elapsed_ms: performance.now() - started, backup: row, current_max_file_bytes: 128 * 1024 * 1024,
      requested_restoration_completed: false, overall_scope: 'PARCIAL', product_limits_modified: false, native_administration: false });
    active().errors.assertClean();
  }, 480_000);

  it('descarga una copia soportada, restaura por la CLI y acredita una respuesta leyendo la ruta restaurada', async () => {
    active().errors.assertClean();
    expect(failedBackup).not.toBe('');
    const page = active().page;
    const started = performance.now();
    const reduced = JSON.parse(await agentPython(active(), `import hashlib,json,os,pathlib,sys
path=pathlib.Path(sys.argv[1])/'space/projects/large.bin';remaining=int(sys.argv[2]);digest=hashlib.sha256()
with path.open('wb') as stream:
 while remaining:
  chunk=os.urandom(min(1024*1024,remaining));stream.write(chunk);digest.update(chunk);remaining-=len(chunk)
os.chmod(path,0o600);info=path.stat()
print(json.dumps({'bytes':info.st_size,'allocated_bytes':info.st_blocks*512,'sha256':digest.hexdigest()}))
`, [active().agent.state_directory, String(SUPPORTED_BYTES)])) as { bytes: number; allocated_bytes: number; sha256: string };
    expect(reduced.bytes).toBe(SUPPORTED_BYTES);
    expect(reduced.bytes).toBeLessThanOrEqual(128 * 1024 * 1024);
    const unchanged = await sourceHashes(Object.entries(seed.expected_files).map(([path, sha256]) => ({ path, sha256, bytes: 0 })));
    expect(unchanged).toEqual(seed.expected_files);
    await panel().getByRole('button', { name: 'Crear otro backup', exact: true }).click();
    const ready = await waitBackup([failedBackup], 'ready');
    expect(ready.error).toBeNull();
    expect(Number(ready.bytes)).toBeGreaterThan(SUPPORTED_BYTES);
    expect(ready.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const available = panel().getByText('Backup disponible', { exact: true });
    await available.waitFor({ timeout: 30_000 });
    await capture(page, 'supported-backup-ready', available);
    const exportMs = performance.now() - started;
    const pickerAvailable = await page.evaluate(() => typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker);
    await page.evaluate(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
    expect(await page.evaluate(() => typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker)).toBe('undefined');
    const downloadStarted = performance.now();
    const waitDownload = (page as DownloadPage).waitForEvent('download', { timeout: 120_000 });
    await panel().getByRole('button', { name: 'Descargar backup ZIP', exact: true }).click();
    const download = await waitDownload;
    const archive = join(active().directory, 'downloaded-space.zip');
    const browserPath = await download.path();
    if (!browserPath || !/^\/tmp\/playwright-artifacts-[A-Za-z0-9]+\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(browserPath)) {
      throw new Error('download path is outside the owned Chromium artifacts');
    }
    expect(await download.failure()).toBeNull();
    const browserContainerId = (await browserDocker(['inspect', '--format', '{{.Id}}', active().browser.container])).stdout.trim();
    expect(browserContainerId).toBe(active().browser.containerId);
    expect(browserContainerId).toMatch(/^[a-f0-9]{64}$/u);
    await browserDocker(['cp', `${browserContainerId}:${browserPath}`, archive], { timeout: 120_000 });
    await chmod(archive, 0o600);
    expect((await stat(archive)).size).toBe(Number(ready.bytes));
    expect(await hashFile(archive)).toBe(ready.sha256);
    expect(await hashFile(join(active().storage, `${ready.id}.zip`))).toBe(ready.sha256);
    const downloadMs = performance.now() - downloadStarted;
    await capture(page, 'browser-download-complete', panel().getByText('Descarga iniciada en el navegador: si no aparece, la copia pudo vencer o no tienes permiso; vuelve a generarla.', { exact: true }));

    const inspection = JSON.parse(await agentPython(active(), `import json,pathlib,sys
parent=pathlib.Path(sys.argv[1]);parent.mkdir(mode=0o700)
print(json.dumps({'archive':str(parent/'downloaded.zip'),'destination':str(pathlib.Path(sys.argv[2]))}))
`, [join(active().agent.state_directory, `download-${RUN}`), join(active().agent.state_directory, `restored-${RUN}`)])) as { archive: string; destination: string };
    await docker(['cp', archive, `${active().agent.container_name}:${inspection.archive}`]);
    await docker(['exec', '--user', '0', active().agent.container_name, 'chown', `${active().agent.runtime_user}:${active().agent.runtime_user}`, inspection.archive]);
    await agentPython(active(), 'import os,sys;os.chmod(sys.argv[1],0o600)', [inspection.archive]);
    const manifest = JSON.parse(await agentPython(active(), `import hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 raw=archive.read('space-manifest.json');manifest=json.loads(raw)
 print(json.dumps({'identity':manifest['identity'],'manifest_sha256':hashlib.sha256(raw).hexdigest(),
  'files':manifest['files'],'omissions':manifest['omissions'],'entries':archive.namelist()}))
`, [inspection.archive])) as ArchiveInspection;
    expect(manifest.identity).toEqual({ company_id: active().company, tenant_id: active().tenant, alias: ALIAS, runtime_key: RUNTIME_KEY });
    expect(manifest.manifest_sha256).toBe(ready.manifest_sha256);
    expect(manifest.files.find(file => file.path === 'projects/large.bin')).toMatchObject({ bytes: reduced.bytes, sha256: reduced.sha256 });
    const source = await sourceHashes(manifest.files);
    expect(source).toEqual(Object.fromEntries(manifest.files.map(file => [file.path, file.sha256])));
    for (const [relative, sha256] of Object.entries(seed.expected_files)) expect(source[relative]).toBe(sha256);
    const removed = JSON.parse(await agentPython(active(), `import json,pathlib,sys
path=pathlib.Path(sys.argv[1])/'space/context/recovery.md'
path.unlink()
print(json.dumps({'path':str(path),'absent':not path.exists()}))
`, [active().agent.state_directory])) as { path: string; absent: boolean };
    expect(removed).toEqual({ path: join(active().agent.state_directory, 'space/context/recovery.md'), absent: true });
    const restoreStarted = performance.now();
    const restoreArgs = ['exec', '--user', active().agent.runtime_user, active().agent.container_name,
      'bash', '/cauce/executor/cauce', 'spaces', 'restore', '--archive', inspection.archive, '--directory', inspection.destination,
      '--company-id', active().company, '--tenant-id', active().tenant, '--alias', ALIAS, '--runtime-key', RUNTIME_KEY];
    const restored = JSON.parse(await docker(restoreArgs)) as { state: string; identity: Record<string, string>; files: number; bytes: number; omissions: unknown[] };
    expect(restored).toMatchObject({ state: 'restored', identity: manifest.identity, files: manifest.files.length });
    expect(await sourceHashes(manifest.files, inspection.destination)).toEqual(source);
    const restoreMs = performance.now() - restoreStarted;

    const restoredFile = join(inspection.destination, 'context/recovery.md');
    const prompt = `RESTORED_READ_PATH=${restoredFile}`;
    expect(prompt).not.toContain(seed.context_base64);
    expect(prompt).not.toContain(Buffer.from(seed.context_base64, 'base64').toString('utf8').trim());
    expect((await pool().query(`SELECT 1 FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias='owner'`,
      [active().tenant, active().room])).rowCount).toBe(1);
    const readStarted = performance.now();
    await page.goto(`${active().baseUrl}/messages/${active().tenant}/${ALIAS}`, { waitUntil: 'domcontentloaded' });
    const composer = page.getByLabel(`Mensaje para ${ALIAS}`, { exact: true });
    await composer.waitFor({ timeout: 30_000 });
    await composer.fill(prompt);
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    let message: { message_id: string } | undefined;
    await expect.poll(async () => {
      message = (await pool().query<{ message_id: string }>(`SELECT id::text AS message_id FROM messages
        WHERE tenant_id=$1 AND actor_alias='owner' AND body->>'text'=$2 ORDER BY created_at DESC LIMIT 1`, [active().tenant, prompt])).rows[0];
      return message !== undefined;
    }, { timeout: 30_000, interval: 250 }).toBe(true);
    if (!message) throw new Error('the UI did not publish the restored-path request');
    const messageId = message.message_id;
    let delivery: { delivery_id: string; status: string; reply: string | null; last_error: string | null } | undefined;
    await expect.poll(async () => {
      delivery = (await pool().query<NonNullable<typeof delivery>>(`SELECT id::text AS delivery_id,status,result->'output'->>'reply' AS reply,last_error
        FROM deliveries WHERE message_id=$1 AND recipient_alias=$2`, [messageId, ALIAS])).rows[0];
      return delivery?.status;
    }, { timeout: 90_000, interval: 500 }).toBe('done');
    if (!delivery?.reply) throw new Error('synthetic reader did not return its real file read');
    const read = JSON.parse(delivery.reply) as { reader: string; path: string; bytes: number; sha256: string; content_base64: string;
      pid: number; expected_contents_in_native_prompt: boolean };
    expect(read).toMatchObject({ reader: 'synthetic-provider-real-filesystem', path: restoredFile,
      content_base64: seed.context_base64, sha256: seed.expected_files['context/recovery.md'], bytes: Buffer.from(seed.context_base64, 'base64').length,
      expected_contents_in_native_prompt: false });
    expect(read.pid).toBeGreaterThan(0);
    expect(delivery.last_error).toBeNull();
    expect((await pool().query("SELECT 1 FROM delivery_acks WHERE delivery_id=$1 AND status='done' AND applied=true", [delivery.delivery_id])).rowCount).toBe(1);
    const readMs = performance.now() - readStarted;
    await page.goto(`${active().baseUrl}/messages/${active().tenant}/${ALIAS}`, { waitUntil: 'domcontentloaded' });
    await page.getByText(prompt, { exact: true }).waitFor({ timeout: 30_000 });
    await capture(page, 'restored-path-request-in-chat', page.getByText(prompt, { exact: true }));
    const reply = page.getByRole('region', { name: `Respuesta canónica de ${active().tenant}:${ALIAS}`, exact: true })
      .getByText(delivery.reply, { exact: true });
    await reply.waitFor({ timeout: 30_000 });
    await capture(page, 'restored-file-response-in-chat', reply);
    await receipt('supported-restore-and-read', { task: TASK, run: RUN, overall_scope: 'PARCIAL',
      limitation: 'A 1 GB file exceeds the unchanged 128 MiB per-file product limit; the successful copy uses 33 MiB.',
      synthetic_provider: true, commercial_provider: false, native_administration: false, requested_large_file_bytes: OVERSIZED_BYTES,
      supported_file: reduced, backup: ready, download: { channel: 'real-playwright-download-event',
        browser_container_id: browserContainerId, browser_artifact_path: browserPath,
        picker_before: pickerAvailable, picker_disabled_for_native_anchor: true, suggested_filename: download.suggestedFilename(), sha256: await hashFile(archive) },
      manifest, source_hashes: source, original_file_removed: removed, restored_hashes: await sourceHashes(manifest.files, inspection.destination),
      restore: { argv: ['docker', ...restoreArgs], receipt: restored },
      bus: { message_id: message.message_id, ...delivery, input: prompt, expected_contents_in_prompt: false, filesystem_read: read,
        ui_request_visible: true, ui_response_visible: true },
      elapsed_ms: { export: exportMs, browser_download: downloadMs, restore: restoreMs, agent_read: readMs, total: performance.now() - started } });
    active().errors.assertClean();
  }, 600_000);
});
