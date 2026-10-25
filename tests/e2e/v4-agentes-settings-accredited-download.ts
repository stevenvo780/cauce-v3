import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { expect } from 'vitest';
import { SPACE_BACKUP_MAX_BYTES, SpaceBackupHash, type spaceBackupReceipt } from '@cauce/store';
import { browserDocker, browserExec } from './browser-owned-lifecycle.js';
import { apiGet, type V4Locator, type V4Page } from './v4-console-real-browser.helpers.js';

type BackupReceipt = ReturnType<typeof spaceBackupReceipt>;
interface Download {
  path(): Promise<string | null>;
  failure(): Promise<string | null>;
  suggestedFilename(): string;
}
interface DownloadPage extends V4Page {
  waitForEvent(event: 'download', options: { timeout: number }): Promise<Download>;
  screenshot(options: { path: string; fullPage?: boolean; mask?: V4Locator[] }): Promise<Buffer>;
}
export interface SpaceBackupDownloadOptions {
  page: V4Page; tenant: string; alias: string; companyId: string; runtimeKey: string;
  browserContainerId: string; evidenceDirectory: string; storageDirectory: string;
  expectedFile?: { path: string; bytes: number; sha256: string };
}
type BackupRequestOptions = Pick<SpaceBackupDownloadOptions, 'page' | 'tenant' | 'alias' | 'companyId' | 'evidenceDirectory'>;
interface ArchiveInspection {
  identity: { company_id: string; tenant_id: string; alias: string; runtime_key: string };
  manifest_sha256: string;
  files: { path: string; bytes: number; sha256: string }[];
  verified_files: number;
}

function parseBackup(value: unknown): BackupReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('backup receipt must be an object');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(row.id)
    || !['company_id', 'tenant_id', 'alias', 'status', 'created_at', 'expires_at'].every(key => typeof row[key] === 'string')
    || !['pending', 'running', 'ready', 'failed'].includes(String(row.status))
    || !Number.isFinite(Date.parse(String(row.created_at))) || !Number.isFinite(Date.parse(String(row.expires_at)))
    || row.bytes !== null && !(typeof row.bytes === 'number' && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= SPACE_BACKUP_MAX_BYTES)
    || ![row.sha256, row.manifest_sha256].every(hash => hash === null || SpaceBackupHash.safeParse(hash).success)
    || row.error !== null && typeof row.error !== 'string' || row.download_url !== null && typeof row.download_url !== 'string') {
    throw new Error('backup receipt differs from the space backup contract');
  }
  return row as unknown as BackupReceipt;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function privateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || path === '/') throw new Error('backup evidence directory must be canonical');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || (info.mode & 0o077) !== 0) {
    throw new Error('backup evidence directory must be private');
  }
}

async function capture(options: Pick<SpaceBackupDownloadOptions, 'page' | 'alias' | 'evidenceDirectory'>, label: string): Promise<string[]> {
  const page = options.page as DownloadPage; const paths: string[] = [];
  const original = page.viewportSize();
  try {
    for (const [device, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      const path = join(options.evidenceDirectory, `${options.alias}-${label}-${device}.png`);
      await page.screenshot({ path, fullPage: true, mask: [page.locator('input[type="password"], input[type="email"], [data-sensitive="true"]')] });
      await chmod(path, 0o600); paths.push(path);
    }
  } finally { await page.setViewportSize(original ?? { width: 1440, height: 900 }); }
  return paths;
}

async function listBackups(options: BackupRequestOptions, path: string): Promise<BackupReceipt[]> {
  const response = await apiGet(options.page, path);
  expect(response.status, 'read-only backup listing').toBe(200);
  if (!Array.isArray(response.body.backups)) throw new Error('backup listing is absent');
  const backups = response.body.backups.map(parseBackup);
  for (const backup of backups) expect(backup).toMatchObject({
    company_id: options.companyId, tenant_id: options.tenant, alias: options.alias,
  });
  expect(new Set(backups.map(backup => backup.id)).size).toBe(backups.length);
  return backups;
}

async function readyBackup(options: BackupRequestOptions, path: string): Promise<BackupReceipt> {
  const panel = options.page.getByRole('region', { name: 'Copia de seguridad del espacio', exact: true });
  await panel.waitFor({ timeout: 30_000 });
  const before = await listBackups(options, path);
  const existing = before.find(row => row.status === 'ready' && Date.parse(row.expires_at) > Date.now())
    ?? before.find(row => row.status === 'pending' || row.status === 'running');
  if (!existing) {
    const create = panel.getByRole('button', { name: /^Crear (?:otra copia|copia del espacio)$/u });
    await expect.poll(() => create.isDisabled(), { timeout: 30_000 }).toBe(false);
    await create.click();
  }
  let latest: BackupReceipt | undefined;
  try {
    await expect.poll(async () => {
      const rows = await listBackups(options, path);
      latest = existing ? rows.find(row => row.id === existing.id) : rows.find(row => !before.some(old => old.id === row.id));
      return latest?.status === 'ready' || latest?.status === 'failed';
    }, { timeout: 180_000, interval: 1_000 }).toBe(true);
  } finally {
    const statePath = join(options.evidenceDirectory, `${options.alias}-backup-terminal.json`);
    await writeFile(statePath, JSON.stringify(latest ?? null, null, 2) + '\n', { mode: 0o600 });
    await chmod(statePath, 0o600);
  }
  if (!latest) throw new Error('backup receipt is absent after the UI request');
  expect(latest, JSON.stringify(latest)).toMatchObject({ status: 'ready', error: null });
  expect(latest.download_url).toBe(`${path}/${latest.id}/download`);
  expect(latest.bytes).not.toBeNull(); expect(latest.sha256).not.toBeNull(); expect(latest.manifest_sha256).not.toBeNull();
  await panel.getByRole('button', { name: `Ver copia ${latest.id.slice(0, 8)}`, exact: true }).click();
  await panel.getByText('Copia disponible', { exact: true }).waitFor({ timeout: 30_000 });
  await panel.getByText(latest.sha256 ?? '', { exact: true }).first().waitFor({ timeout: 30_000 });
  return latest;
}

export async function prepareSpaceBackupForDownload(options: BackupRequestOptions): Promise<string> {
  await privateDirectory(options.evidenceDirectory);
  const contextPath = `/messages/${encodeURIComponent(options.tenant)}/${encodeURIComponent(options.alias)}?view=context`;
  await options.page.goto(new URL(contextPath, options.page.url()).href, { waitUntil: 'domcontentloaded' });
  const path = `/v3/console/spaces/${encodeURIComponent(options.tenant)}/${encodeURIComponent(options.alias)}/backups`;
  const backup = await readyBackup(options, path);
  await capture(options, `${backup.id}-backup-prepared`);
  return backup.id;
}

async function inspectArchive(archive: string) {
  const result = await browserExec('python3', ['-I', '-B', '-c', `import hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 raw=archive.read('space-manifest.json');manifest=json.loads(raw);verified=0
 for item in manifest['files']:
  digest=hashlib.sha256();size=0
  with archive.open(item['path']) as stream:
   while chunk:=stream.read(1024*1024): digest.update(chunk);size+=len(chunk)
  if digest.hexdigest()!=item['sha256'] or size!=item['bytes']: raise ValueError('archive file differs from manifest')
  verified+=1
 print(json.dumps({'identity':manifest['identity'],'manifest_sha256':hashlib.sha256(raw).hexdigest(),
  'files':[{key:item[key] for key in ('path','bytes','sha256')} for item in manifest['files']], 'verified_files':verified}))
`, archive], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  const inspection = JSON.parse(result.stdout) as ArchiveInspection;
  SpaceBackupHash.parse(inspection.manifest_sha256);
  return inspection;
}

export async function verifySpaceBackupDownload(options: SpaceBackupDownloadOptions) {
  await privateDirectory(options.evidenceDirectory);
  if (!/^[a-f0-9]{64}$/u.test(options.browserContainerId)) throw new Error('backup download requires an exact browser container ID');
  if (!isAbsolute(options.storageDirectory) || await realpath(options.storageDirectory) !== options.storageDirectory) {
    throw new Error('backup storage must be an absolute canonical fixture directory');
  }
  const page = options.page as DownloadPage;
  const contextPath = `/messages/${encodeURIComponent(options.tenant)}/${encodeURIComponent(options.alias)}?view=context`;
  const link = page.getByRole('dialog').getByRole('link', { name: 'Descargar copia', exact: true });
  expect(await link.evaluate(element => element.getAttribute('href'))).toBe(contextPath);
  const screenshots = await capture(options, 'purge-before-copy');
  await link.click();
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search, { timeout: 30_000 }).toBe(contextPath);
  const backupsPath = `/v3/console/spaces/${encodeURIComponent(options.tenant)}/${encodeURIComponent(options.alias)}/backups`;
  const backup = await readyBackup(options, backupsPath);
  screenshots.push(...await capture(options, `${backup.id}-backup-ready`));
  const pickerBefore = await page.evaluate(() => typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker);
  await page.evaluate(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const pending = page.waitForEvent('download', { timeout: 180_000 });
  await page.getByRole('region', { name: 'Copia de seguridad del espacio', exact: true })
    .getByRole('button', { name: 'Descargar copia ZIP', exact: true }).click();
  const download = await pending; expect(await download.failure()).toBeNull();
  const browserPath = await download.path();
  if (!browserPath || !/^\/tmp\/playwright-artifacts-[A-Za-z0-9]+\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(browserPath)) {
    throw new Error('backup download escaped the owned Chromium artifacts');
  }
  const daemonName = (await browserDocker(['info', '--format', '{{.Name}}'])).stdout.trim();
  expect(daemonName, 'backup download Docker daemon').toBe('docker-lab');
  const browserId = (await browserDocker(['inspect', '--format', '{{.Id}}', options.browserContainerId])).stdout.trim();
  expect(browserId).toBe(options.browserContainerId);
  const archive = join(options.evidenceDirectory, `${options.alias}-${backup.id}.zip`);
  await browserDocker(['cp', `${browserId}:${browserPath}`, archive], { timeout: 180_000 });
  await chmod(archive, 0o600);
  const file = await lstat(archive); const sha256 = await hashFile(archive);
  expect(file.isFile()).toBe(true); expect(file.isSymbolicLink()).toBe(false);
  expect(file.mode & 0o777).toBe(0o600); expect(file.size).toBe(backup.bytes); expect(sha256).toBe(backup.sha256);
  const serverArchive = join(options.storageDirectory, `${backup.id}.zip`);
  expect((await lstat(serverArchive)).size).toBe(file.size); expect(await hashFile(serverArchive)).toBe(sha256);
  const manifest = await inspectArchive(archive);
  expect(manifest.identity).toEqual({ company_id: options.companyId, tenant_id: options.tenant, alias: options.alias, runtime_key: options.runtimeKey });
  expect(manifest.manifest_sha256).toBe(backup.manifest_sha256); expect(manifest.verified_files).toBe(manifest.files.length);
  if (options.expectedFile) expect(manifest.files.find(file => file.path === options.expectedFile?.path)).toEqual(options.expectedFile);
  screenshots.push(...await capture(options, `${backup.id}-browser-download`));
  const receipt = { backup, archive, bytes: file.size, sha256, manifest_sha256: manifest.manifest_sha256,
    server_archive: serverArchive, manifest, screenshots, channel: 'real-playwright-download-event',
    browser_container_id: browserId, browser_artifact_path: browserPath, picker_before: pickerBefore,
    picker_disabled_for_native_anchor: true, suggested_filename: download.suggestedFilename(), download_failure: null };
  const receiptPath = join(options.evidenceDirectory, `${options.alias}-${backup.id}-download.json`);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); await chmod(receiptPath, 0o600);
  return { ...receipt, receipt_path: receiptPath };
}
