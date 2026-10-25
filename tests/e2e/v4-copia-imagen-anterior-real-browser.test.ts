import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserDocker, browserExec } from './browser-owned-lifecycle.js';
import { apiGet, type V4Page } from './v4-console-real-browser.helpers.js';
import { evidence, sha256, startImageBackupFixture, type DownloadPage, type ImageBackupFixture, type ImageBackupTarget } from './v4-copia-imagen-anterior-real-browser.fixtures.js';

interface BackupRow { id: string; status: string; error: string | null; bytes: string | null; sha256: string | null; manifest_sha256: string | null }
interface ArchiveManifest { identity: Record<string, string>; files: { path: string; sha256: string }[]; omissions: unknown[] }
let fixture: ImageBackupFixture | undefined;
const active = (): ImageBackupFixture => { if (!fixture) throw new Error('image backup fixture is absent'); return fixture; };

async function capture(page: V4Page, name: string): Promise<void> {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: join(evidence, `${name}-${String(viewport.width)}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function row(id: string): Promise<BackupRow> {
  const current = (await active().consoleFixture.database.pool.query<BackupRow>(
    'SELECT id::text,status,error,bytes::text,sha256,manifest_sha256 FROM space_backups WHERE id=$1', [id])).rows[0];
  if (!current) throw new Error('created backup row is absent');
  return current;
}

async function requestCopy(target: ImageBackupTarget): Promise<string> {
  const { page, agent } = target;
  await target.refresh();
  await page.goto(`${active().consoleFixture.baseUrl}/messages/${agent.tenant_id}/${agent.alias}?view=context`, { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('region', { name: 'Copia de seguridad del espacio', exact: true });
  await panel.getByRole('button', { name: 'Crear copia del espacio', exact: true }).click();
  await panel.getByText('Copia pendiente', { exact: true }).waitFor({ timeout: 30_000 });
  const id = (await active().consoleFixture.database.pool.query<{ id: string }>(
    'SELECT id::text FROM space_backups WHERE tenant_id=$1 AND alias=$2 ORDER BY created_at DESC LIMIT 1', [agent.tenant_id, agent.alias])).rows[0]?.id;
  if (!id) throw new Error('UI omitted its durable backup request');
  expect((await row(id)).status).toBe('pending');
  await capture(page, `${agent.harness_id}-${agent.alias}-pending`);
  return id;
}

async function exportCopy(target: ImageBackupTarget, id: string): Promise<BackupRow> {
  await target.refresh();
  expect(await target.worker.runOnce(new AbortController().signal)).toBe(true);
  const current = await row(id);
  expect(['ready', 'failed']).toContain(current.status);
  return current;
}

async function verifyUnchanged(target: ImageBackupTarget): Promise<void> {
  const after = await target.observe();
  expect(target.before.image).not.toBe(target.approved_image);
  expect(target.before.configured_image).toBe(target.before.image);
  expect(after.observed).toEqual(target.before);
  expect(after.source_files).toEqual(target.source_files);
  expect(after.observed.running).toBe(true);
  expect(after.observed.release_mount).toBe(join(target.runtime_release, 'ops/cli'));
  expect(target.previous_policy_sha256).not.toBe(target.policy_sha256);
  const capabilities = (await active().consoleFixture.database.pool.query<{ capabilities: { policy_sha256: string } }>(
    'SELECT capabilities FROM fleet_host_identities WHERE host_id=$1', [target.agent.host_id])).rows[0]?.capabilities;
  expect(capabilities?.policy_sha256).toBe(target.policy_sha256);
  expect(sha256(await readFile(target.policy_file))).toBe(target.policy_sha256);
}

async function downloadAndRestore(target: ImageBackupTarget, receipt: BackupRow): Promise<void> {
  const panel = target.page.getByRole('region', { name: 'Copia de seguridad del espacio', exact: true });
  await panel.getByText('Copia disponible', { exact: true }).waitFor({ timeout: 30_000 });
  if (!receipt.sha256 || !receipt.manifest_sha256 || !receipt.bytes) throw new Error('ready receipt is incomplete');
  await panel.getByText(receipt.sha256, { exact: true }).waitFor({ timeout: 20_000 });
  await capture(target.page, `${target.agent.harness_id}-${target.agent.alias}-ready`);
  await target.page.evaluate(() => { if ('showSaveFilePicker' in window) Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const downloadWait = (target.page as DownloadPage).waitForEvent('download', { timeout: 30_000 });
  await panel.getByRole('button', { name: 'Descargar copia ZIP', exact: true }).click();
  const browserFile = await (await downloadWait).path();
  if (!browserFile?.startsWith('/tmp/playwright-artifacts-') || browserFile.includes('..')) throw new Error('download escaped the owned browser artifact directory');
  const downloads = join(target.directory, 'download');
  await mkdir(downloads, { mode: 0o700 });
  const archive = join(downloads, `${receipt.id}.zip`);
  await browserDocker(['cp', `${active().consoleFixture.browserContainer}:${browserFile}`, archive]);
  await chmod(archive, 0o600);
  const bytes = await readFile(archive);
  expect(bytes.byteLength).toBe(Number(receipt.bytes));
  expect(sha256(bytes)).toBe(receipt.sha256);
  expect(await readFile(join(active().storage, `${receipt.id}.zip`))).toEqual(bytes);
  await panel.getByText(/Descarga iniciada en el navegador/u).waitFor();
  await capture(target.page, `${target.agent.harness_id}-${target.agent.alias}-download`);
  const identity = Object.fromEntries(['company_id', 'tenant_id', 'alias', 'runtime_key'].map(field => [field, target.agent[field as keyof typeof target.agent]]));
  const restored = join(downloads, 'restored');
  const restoration = await browserExec('bash', ['ops/cli/cauce', 'spaces', 'restore', '--archive', archive,
    '--directory', restored, '--company-id', target.agent.company_id, '--tenant-id', target.agent.tenant_id,
    '--alias', target.agent.alias, '--runtime-key', target.agent.runtime_key], { timeout: 120_000 });
  const restoreReceipt = JSON.parse(restoration.stdout) as { state: string; identity: Record<string, string>; files: number; manifest_sha256: string };
  expect(restoreReceipt).toMatchObject({ state: 'restored', identity, files: Object.keys(target.source_files).length,
    manifest_sha256: receipt.manifest_sha256 });
  const inspected = await browserExec('/usr/bin/python3', ['-I', '-B', '-c',
    'import hashlib,json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);b=z.read("space-manifest.json");print(json.dumps({"sha256":hashlib.sha256(b).hexdigest(),"manifest":json.loads(b)}))', archive]);
  const manifest = JSON.parse(inspected.stdout) as { sha256: string; manifest: ArchiveManifest };
  expect(manifest.sha256).toBe(receipt.manifest_sha256);
  expect(manifest.manifest.identity).toEqual(identity);
  expect(manifest.manifest.omissions).toEqual([]);
  expect(Object.fromEntries(manifest.manifest.files.map(file => [file.path, file.sha256]))).toEqual(target.source_files);
  for (const [path, hash] of Object.entries(target.source_files)) expect(sha256(await readFile(join(restored, path))), path).toBe(hash);
  await verifyUnchanged(target);
  await writeFile(join(evidence, `${target.agent.harness_id}-${target.agent.alias}-result.json`), JSON.stringify({
    harness: target.agent.harness_id, backup_id: receipt.id, receipt, source_files: target.source_files,
    restore_receipt: restoreReceipt, download_transport: 'chromium-native-download-owned-browser-container',
    screen_sha256: receipt.sha256, downloaded_sha256: sha256(bytes), manifest_sha256: manifest.sha256,
    container_before: target.before, container_after: (await target.observe()).observed,
    approved_image: target.approved_image, policy_sha256: target.policy_sha256, file_comparison_verified: true,
    previous_policy_sha256: target.previous_policy_sha256, runtime_release: target.runtime_release,
    current_release: target.project_root, source_release_files: target.release_source,
  }, null, 2));
}

beforeAll(async () => { fixture = await startImageBackupFixture(); }, 600_000);
afterAll(async () => { await fixture?.close(); }, 180_000);

describe.sequential('copia física desde contenedor con imagen anterior a la aprobada', () => {
  it.each(['openclaw', 'grok'] as const)('%s: crea desde UI, descarga en Chromium y restaura cada archivo sin actualizar ejecución', async harness => {
    const target = await active().prepareTarget(harness);
    try {
      await verifyUnchanged(target);
      const id = await requestCopy(target);
      const receipt = await exportCopy(target, id);
      expect(receipt, JSON.stringify(receipt)).toMatchObject({ status: 'ready', error: null });
      await downloadAndRestore(target, receipt);
    } catch (error) {
      await capture(target.page, `${harness}-${target.agent.alias}-failure`).catch(() => undefined);
      throw error;
    } finally { await target.close(); }
  }, 300_000);

  it('rechaza aislamiento físico alterado y conserva causa y acción en API, auditoría y UI recargada', async () => {
    const target = await active().prepareTarget('openclaw');
    try {
      await target.fault();
      const id = await requestCopy(target);
      expect(await exportCopy(target, id)).toMatchObject({ status: 'failed', error: 'EXPORT_FAILED' });
      const path = `/v3/console/spaces/${target.agent.tenant_id}/${target.agent.alias}/backups/${id}`;
      const detail = await apiGet(target.page, path);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ status: 'failed', failure: { type: 'SafeFailure', stage: 'runtime' } });
      const reported = detail.body.failure as { message: string };
      expect(reported.message).toMatch(/container.*(?:isolation|resources|limits).*differ/iu);
      const audit = await active().consoleFixture.database.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action='space.backup.failed' AND metadata->>'id'=$1", [id]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.metadata).toMatchObject({ id, error: 'EXPORT_FAILED', failure: { type: 'SafeFailure', stage: 'runtime' } });
      await target.page.reload({ waitUntil: 'domcontentloaded' });
      const panel = target.page.getByRole('region', { name: 'Copia de seguridad del espacio', exact: true });
      await panel.getByRole('button', { name: `Ver copia ${id.slice(0, 8)}`, exact: true }).click();
      await panel.getByText(/Causa: SafeFailure: container.*(?:isolation|resources|limits).*differ/iu).waitFor({ timeout: 30_000 });
      await panel.getByText('Restablece la propiedad, los permisos y el aislamiento aprobados del contenedor antes de crear otra copia.', { exact: false }).waitFor();
      expect(await panel.getByRole('button', { name: 'Descargar copia ZIP', exact: true }).count()).toBe(0);
      await capture(target.page, `negative-isolation-${target.agent.alias}`);
      await writeFile(join(evidence, 'negative-isolation-result.json'), JSON.stringify({ backup_id: id,
        api: detail.body, audit: audit.rows[0]?.metadata, reloaded_ui_has_cause_and_action: true }, null, 2));
    } catch (error) {
      await capture(target.page, `negative-isolation-${target.agent.alias}-failure`).catch(() => undefined);
      await writeFile(join(evidence, 'negative-isolation-failure.txt'), await target.page.locator('body').innerText());
      throw error;
    } finally { await target.recover(); await target.close(); }
  }, 300_000);
});
