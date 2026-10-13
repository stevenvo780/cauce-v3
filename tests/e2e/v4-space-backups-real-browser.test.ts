import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';
import { registerSpaceBackupHostRoutes } from '../../services/gateway/src/fleet/space-backup.routes.js';
import { SpaceBackupHost } from '../../services/gateway/src/fleet/space-backup.host.js';
import { SignedHostChannel } from '../../services/gateway/src/fleet/signed-source.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const python = '/usr/bin/python3';
const projectRoot = process.cwd();
const alias = `zzbackup${run}`;
const runtimeKey = `zz-canary-${run}`;
const hostId = `zz-canary-host-${run}`;
const credentialSecret = `zz-canary-credential-secret-${run}`;
const foreignMarker = `zz-canary-foreign-company-${run}`;
const owner: V4Person = {
  ...syntheticPerson('backup', run),
  email: `zz-canary-backup-${run}@example.test`,
  name: `zz-canary-backup-${run}`,
  company: { name: `zz-canary-empresa-backup-${run}`, slug: `zz-canary-backup-${run}` },
};
const foreign: V4Person = {
  ...syntheticPerson('backup-foreign', run),
  email: `zz-canary-backup-foreign-${run}@example.test`,
  name: `zz-canary-backup-foreign-${run}`,
  company: { name: `zz-canary-empresa-foreign-${run}`, slug: `zz-canary-foreign-${run}` },
};
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let pageA: V4Page | undefined;
let pageB: V4Page | undefined;
let hub = '';
let ownerId = '';
let canaryRoot = '';
let storageDirectory = '';
let policyFile = '';
let identityDirectory = '';
let hostApp: FastifyInstance | undefined;
let worker: SpaceBackupHost | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let backupId = '';
let receiptBytes = 0;
let receiptSha256 = '';
let downloadChannel = 'unstarted';
let pickerLimitDeclared = false;

const active = (): NonNullable<typeof fixture> => { if (!fixture) throw new Error('backup fixture is not initialized'); return fixture; };
const base = (): string => active().baseUrl;
const pool = () => active().database.pool;
const ownerPage = (): V4Page => { if (!pageA) throw new Error('backup owner has no page yet'); return pageA; };
const agentUrl = (): string => `${base()}/messages/${hub}/${alias}?view=context`;
const backupPath = (id: string): string => `/v3/console/spaces/${hub}/${alias}/backups/${id}`;

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 1000 }));
  errors.watch(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function registerCompany(page: V4Page, person: V4Person): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

async function refreshCapabilities(): Promise<void> {
  await pool().query("UPDATE fleet_host_identities SET capabilities_seen_at=now() WHERE host_id=$1", [hostId]);
}

async function storedBackup(): Promise<{ status: string; error: string | null; bytes: number | null; sha256: string | null }> {
  const rows = await pool().query<{ status: string; error: string | null; bytes: string | null; sha256: string | null }>(
    'SELECT status,error,bytes::text,sha256 FROM space_backups WHERE id=$1', [backupId]);
  const row = rows.rows[0];
  if (!row) throw new Error('canary backup row is absent');
  return { status: row.status, error: row.error, bytes: row.bytes === null ? null : Number(row.bytes), sha256: row.sha256 };
}

interface PlaywrightDownload { saveAs(path: string): Promise<void> }
type DownloadCapablePage = V4Page & {
  waitForEvent?: (event: 'download', options?: { timeout?: number }) => Promise<PlaywrightDownload>;
};

async function fetchRealArchive(page: V4Page, destination: string): Promise<{ headerSha: string | null; headerLength: string | null }> {
  const cookies = await page.context().cookies(base());
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const ca = await readFile(active().pki.ca.cert);
  const url = new URL(`${base()}${backupPath(backupId)}/download`);
  const headers = await new Promise<{ headerSha: string | null; headerLength: string | null }>((resolve, reject) => {
    const request = httpsGet({
      hostname: url.hostname, port: url.port, path: url.pathname, ca, rejectUnauthorized: true,
      headers: { Cookie: cookieHeader },
    }, (response) => {
      if (response.statusCode !== 200) { reject(new Error(`real download answered ${String(response.statusCode)}`)); return; }
      const headerSha = typeof response.headers['x-cauce-archive-sha256'] === 'string' ? response.headers['x-cauce-archive-sha256'] : null;
      const headerLength = typeof response.headers['content-length'] === 'string' ? response.headers['content-length'] : null;
      const output = createWriteStream(destination, { mode: 0o600 });
      response.pipe(output);
      output.on('finish', () => { resolve({ headerSha, headerLength }); });
      output.on('error', reject);
      response.on('error', reject);
    });
    request.on('error', reject);
  });
  await chmod(destination, 0o600);
  return headers;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  canaryRoot = await mkdtemp(join(tmpdir(), `cauce-backup-browser-${run}-`));
  await chmod(canaryRoot, 0o700);
  storageDirectory = join(canaryRoot, 'copies');
  process.env.CAUCE_SPACE_BACKUP_DIRECTORY = storageDirectory;
  process.env.CAUCE_PROJECT_ROOT = projectRoot;
  try {
    fixture = await startConsoleFunctionalFixture();
    hostApp = Fastify();
    registerSpaceBackupHostRoutes(hostApp, active().database.pool, { directory: storageDirectory, projectRoot });
    await hostApp.listen({ host: '127.0.0.1', port: 0 });
  } finally {
    delete process.env.CAUCE_SPACE_BACKUP_DIRECTORY;
    delete process.env.CAUCE_PROJECT_ROOT;
  }
}, 600_000);

afterAll(async () => {
  if (refreshTimer) clearInterval(refreshTimer);
  try { await hostApp?.close(); }
  finally {
    try {
      if (canaryRoot) {
        await rm(canaryRoot, { recursive: true, force: true });
        await expect(access(canaryRoot)).rejects.toThrow();
      }
    } finally { await fixture?.close(); }
  }
}, 180_000);

describe('copia de espacio desde navegador real con exportación física firmada', () => {
  it('prepara dos empresas y un espacio canario propio mayor de 32 MiB', async () => {
    pageA = await freshPage('backup-owner');
    await step(ownerPage(), 'canary company registration', async () => { await registerCompany(ownerPage(), owner); });
    const identity = await pool().query<{ id: string; tenant_id: string }>(
      'SELECT id::text,tenant_id FROM console_users WHERE email=$1', [owner.email]);
    ownerId = identity.rows[0]?.id ?? '';
    hub = identity.rows[0]?.tenant_id ?? '';
    expect(ownerId).not.toBe('');
    expect(hub).toMatch(/^hub-/u);

    pageB = await freshPage('backup-foreign');
    const foreignPage = (): V4Page => { if (!pageB) throw new Error('foreign owner has no page yet'); return pageB; };
    await step(foreignPage(), 'foreign company registration', async () => { await registerCompany(foreignPage(), foreign); });
    const foreignHub = (await pool().query<{ tenant_id: string }>(
      'SELECT tenant_id FROM console_users WHERE email=$1', [foreign.email])).rows[0]?.tenant_id ?? '';
    expect(foreignHub).not.toBe('');
    expect(foreignHub).not.toBe(hub);

    const account = userInfo();
    const hostRoot = join(canaryRoot, 'host');
    const roots = Object.fromEntries(['state', 'runtime', 'pki', 'tokens', 'identities'].map((name) => [name, join(hostRoot, name)]));
    for (const directory of Object.values(roots)) await mkdir(directory, { recursive: true, mode: 0o700 });
    const runtimeRoot = roots.runtime ?? '';
    const stateDirectory = join(runtimeRoot, runtimeKey);
    const space = join(stateDirectory, 'space');
    await mkdir(stateDirectory, { mode: 0o700 });
    for (const name of ['context', 'directives', 'projects', 'config', 'data', 'logs']) {
      await mkdir(join(space, name), { recursive: true, mode: 0o700 });
    }
    const large = randomBytes(33 * 1024 * 1024 + 4097);
    await writeFile(join(space, 'projects/large.bin'), large, { mode: 0o600 });
    await writeFile(join(space, 'projects/work.txt'), Buffer.alloc(100_000, 65), { mode: 0o600 });
    await writeFile(join(space, 'context/note.md'), 'canary context note', { mode: 0o600 });
    await writeFile(join(space, 'config/context-state.json'), JSON.stringify({
      company_id: owner.company.slug, tenant_id: hub, alias, runtime_key: runtimeKey,
    }), { mode: 0o600 });
    await writeFile(join(space, 'config/auth.json'), credentialSecret, { mode: 0o600 });
    await writeFile(join(space, 'projects/.env'), `TOKEN=${credentialSecret}`, { mode: 0o600 });
    await writeFile(join(space, 'logs/ignored.log'), 'unexported', { mode: 0o600 });
    const foreignSpace = join(canaryRoot, 'foreign-space/projects');
    await mkdir(foreignSpace, { recursive: true, mode: 0o700 });
    await writeFile(join(foreignSpace, 'secret.txt'), foreignMarker, { mode: 0o600 });

    policyFile = join(hostRoot, 'policy.json');
    const policy = {
      schemaVersion: 1, host_id: hostId, executor_user: account.username, roots,
      native: [{ runtime_user: account.username, systemd_user: account.username, home_directory: account.homedir, state_root: runtimeRoot }],
      containers: {}, profiles: {}, hooks: {}, bundles: { codex: {} },
    };
    const policyBytes = JSON.stringify(policy);
    await writeFile(policyFile, policyBytes, { mode: 0o600 });

    await pool().query('INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES($1,$2,$3) ON CONFLICT (host_id) DO NOTHING',
      [hostId, owner.company.slug, 'Ordenador canario de copias']);
    await pool().query(
      `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,company_id,host_id,runtime_key,runtime_mode,
         container_name,runtime_user,home_directory,state_directory,systemd_user)
       VALUES($1,$2,'codex',$2,false,$3,$4,$5,'native',$6,$7,$8,$9,$7)`,
      [hub, alias, owner.company.slug, hostId, runtimeKey, `host:${hostId}`, account.username, account.homedir, stateDirectory]);
    await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [hub, alias]);

    const keys = generateKeyPairSync('ed25519');
    const enrollment = await pool().query<{ id: string }>(
      `INSERT INTO fleet_host_enrollments(company_id,host_id,display_name,invited_by,token_hash,nonce,expires_at,state,enrolled_at)
       VALUES($1,$2,'Ordenador canario de copias',$3,$4,$5,now()+interval '1 day','enrolled',now()) RETURNING id::text`,
      [owner.company.slug, hostId, ownerId, randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]);
    const enrollmentId = enrollment.rows[0]?.id;
    if (!enrollmentId) throw new Error('canary host enrollment was not created');
    const publicDer = keys.publicKey.export({ type: 'spki', format: 'der' });
    const capabilities = {
      resource: 'host', action: 'capabilities', schemaVersion: 1, executor_version: 'v4-backup-browser',
      policy_sha256: digest(policyBytes), fleet_executor: true, quota_executor: false, quota_providers: [],
      quota_provider_actions: {}, templates: [{ template_id: 'zz-canary-backup', provider: 'codex', harness_id: 'codex',
        runtime_user: account.username, mode: 'native', home_directory: account.homedir, state_root: runtimeRoot, container_prefix: 'zz-canary-' }],
    };
    await pool().query(
      `INSERT INTO fleet_host_identities(host_id,company_id,enrollment_id,public_key,key_fingerprint,capabilities,capabilities_seen_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,now())`,
      [hostId, owner.company.slug, enrollmentId, publicDer.toString('base64'), digest(publicDer), JSON.stringify(capabilities)]);
    refreshTimer = setInterval(() => { void refreshCapabilities().catch(() => undefined); }, 20_000);
    refreshTimer.unref();

    const address = hostApp?.server.address();
    if (!address || typeof address === 'string') throw new Error('host channel address is absent');
    identityDirectory = join(canaryRoot, 'host-identity');
    await mkdir(identityDirectory, { mode: 0o700 });
    await writeFile(join(identityDirectory, 'identity.json'), JSON.stringify({
      enrollment_id: enrollmentId, company_id: owner.company.slug, host_id: hostId,
      gateway: `http://127.0.0.1:${String(address.port)}`, state: 'enrolled',
      key_fingerprint: digest(publicDer), executor_ready: true,
    }), { mode: 0o600 });
    await writeFile(join(identityDirectory, 'private.pem'),
      keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    worker = new SpaceBackupHost(await SignedHostChannel.load(identityDirectory),
      { python, projectRoot, policyFile });
    expect((await pool().query('SELECT 1 FROM space_backups')).rowCount).toBe(0);
  }, 120_000);

  it('solicita la copia en el panel, la exporta por el canal firmado, descarga los bytes reales y restaura con hashes iguales', async () => {
    const page = ownerPage();
    await step(page, 'open canary agent backup panel', async () => {
      await page.goto(agentUrl(), { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: `Perfil y contexto de ${alias}`, exact: true }).waitFor({ timeout: 30_000 });
      await page.getByRole('region', { name: 'Backup del espacio', exact: true }).waitFor({ timeout: 20_000 });
      await page.getByText('Todavía no se creó un backup desde esta ficha. Crea el primero para poder descargarlo.', { exact: true })
        .waitFor({ timeout: 20_000 });
    });
    const panel = page.getByRole('region', { name: 'Backup del espacio', exact: true });
    await step(page, 'request backup from the real panel', async () => {
      await panel.getByRole('button', { name: 'Crear backup del espacio', exact: true }).click();
      await panel.getByText('Backup pendiente', { exact: true }).waitFor({ timeout: 30_000 });
    });
    backupId = (await pool().query<{ id: string }>(
      'SELECT id::text FROM space_backups WHERE tenant_id=$1 AND alias=$2 ORDER BY created_at DESC LIMIT 1', [hub, alias])
    ).rows[0]?.id ?? '';
    expect(backupId).toMatch(/^[0-9a-f-]{36}$/u);
    expect((await storedBackup()).status).toBe('pending');

    const host = worker;
    if (!host) throw new Error('space backup host worker is not initialized');
    await step(page, 'signed physical export above 32 MiB', async () => {
      const deadline = Date.now() + 200_000;
      let current = await storedBackup();
      while (Date.now() < deadline) {
        await refreshCapabilities();
        const worked = await host.runOnce(new AbortController().signal);
        current = await storedBackup();
        if (current.status === 'ready' || current.status === 'failed') break;
        if (!worked) await sleep(500);
      }
      expect(current, JSON.stringify(current)).toMatchObject({ status: 'ready', error: null });
      expect(current.bytes ?? 0).toBeGreaterThan(32 * 1024 * 1024);
      receiptBytes = current.bytes ?? 0;
      receiptSha256 = current.sha256 ?? '';
      expect(receiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    });

    await step(page, 'panel rereads the ready receipt', async () => {
      await panel.getByText('Backup disponible', { exact: true }).waitFor({ timeout: 30_000 });
      await panel.getByText(receiptSha256, { exact: true }).waitFor({ timeout: 20_000 });
      await panel.getByRole('button', { name: 'Actualizar estado del backup', exact: true }).click();
      await panel.getByText('Backup disponible', { exact: true }).waitFor({ timeout: 20_000 });
    });

    const pickerKind = await page.evaluate(() => typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker);
    const downloadable = page as DownloadCapablePage;
    let downloadWait: Promise<PlaywrightDownload | null> = Promise.resolve(null);
    if (typeof downloadable.waitForEvent === 'function') {
      downloadWait = downloadable.waitForEvent('download', { timeout: 25_000 }).catch(() => null);
    }
    await panel.getByRole('button', { name: 'Descargar backup ZIP', exact: true }).click();
    const browserDownload = await downloadWait;
    const downloadDirectory = join(canaryRoot, 'download');
    await mkdir(downloadDirectory, { mode: 0o700 });
    const archive = join(downloadDirectory, `space-${alias}-${backupId}.zip`);
    let headerSha: string | null = null;
    let headerLength: string | null = null;
    if (browserDownload) {
      await browserDownload.saveAs(archive);
      await chmod(archive, 0o600);
      downloadChannel = 'anchor-download';
    } else {
      const fetched = await fetchRealArchive(page, archive);
      headerSha = fetched.headerSha;
      headerLength = fetched.headerLength;
      expect(headerLength).toBe(String(receiptBytes));
      expect(headerSha).toBe(receiptSha256);
      const verifiedText = await panel.getByText(/Descarga verificada/u).count().catch(() => 0);
      if (verifiedText > 0) {
        downloadChannel = 'file-system-access-verified';
        expect(await panel.getByText(/SHA-256 calculado del archivo guardado/u).count()).toBeGreaterThan(0);
      } else {
        downloadChannel = 'real-link-picker-unavailable';
        pickerLimitDeclared = pickerKind === 'function';
        expect(pickerLimitDeclared || pickerKind === 'undefined').toBe(true);
      }
    }
    const archiveBytes = await readFile(archive);
    expect(archiveBytes.byteLength).toBe(receiptBytes);
    expect(digest(archiveBytes)).toBe(receiptSha256);
    expect(archiveBytes.includes(Buffer.from(credentialSecret))).toBe(false);
    expect(archiveBytes.includes(Buffer.from(foreignMarker))).toBe(false);
    const storedZip = await readFile(join(storageDirectory, `${backupId}.zip`));
    expect(storedZip.equals(archiveBytes)).toBe(true);

    const restored = join(canaryRoot, 'restored-space');
    const restoration = spawnSync(python, [join(projectRoot, 'ops/cli/space_archive.py'), 'restore',
      '--archive', archive, '--directory', restored, '--company-id', owner.company.slug,
      '--tenant-id', hub, '--alias', alias, '--runtime-key', runtimeKey],
    { encoding: 'utf8', timeout: 120_000 });
    expect(restoration.status, restoration.stderr).toBe(0);
    const restoredReceipt = JSON.parse(restoration.stdout) as {
      state: string; identity: Record<string, string>; files: number; omissions: { path: string; reason: string }[];
    };
    expect(restoredReceipt).toMatchObject({
      state: 'restored',
      identity: { company_id: owner.company.slug, tenant_id: hub, alias, runtime_key: runtimeKey },
    });
    const manifestProbe = spawnSync(python, ['-c',
      'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read("space-manifest.json").decode()); print("\\n".join(sorted(z.namelist())))', archive],
    { encoding: 'utf8', timeout: 60_000 });
    expect(manifestProbe.status, manifestProbe.stderr).toBe(0);
    const firstBreak = manifestProbe.stdout.indexOf('\n');
    const manifestJson = manifestProbe.stdout.slice(0, firstBreak);
    const namesJoined = manifestProbe.stdout.slice(firstBreak + 1);
    const manifest = JSON.parse(manifestJson) as {
      identity: Record<string, string>; files: { path: string; sha256: string }[]; omissions: { path: string; reason: string }[];
    };
    expect(manifest.identity).toEqual({ company_id: owner.company.slug, tenant_id: hub, alias, runtime_key: runtimeKey });
    const names = namesJoined.split('\n').filter(Boolean);
    expect(names).toContain('projects/large.bin');
    expect(names.some((name) => name.endsWith('auth.json') || name.endsWith('.env') || name.includes('foreign'))).toBe(false);
    expect(manifest.omissions).toEqual(expect.arrayContaining([
      { path: 'config/auth.json', reason: 'sensitive_path' },
      { path: 'projects/.env', reason: 'sensitive_path' },
    ]));
    const largeEntry = manifest.files.find((file) => file.path === 'projects/large.bin');
    if (!largeEntry) throw new Error('large canary file is absent from the manifest');
    expect(digest(await readFile(join(restored, 'projects/large.bin')))).toBe(largeEntry.sha256);
    expect(digest(await readFile(join(restored, 'projects/work.txt')))).toBe(digest(Buffer.alloc(100_000, 65)));
    await expect(readFile(join(restored, 'config/auth.json'))).rejects.toThrow();
    await expect(readFile(join(restored, 'projects/.env'))).rejects.toThrow();
    await expect(readFile(join(restored, 'logs/ignored.log'))).rejects.toThrow();
    console.info('SPACE_BACKUP_BROWSER_RECEIPT ' + JSON.stringify({
      backup_id: backupId, tenant_id: hub, alias, runtime_key: runtimeKey, host_id: hostId,
      bytes: receiptBytes, sha256: receiptSha256, download_channel: downloadChannel,
      picker_limit_declared: pickerLimitDeclared, header_sha256: headerSha, header_length: headerLength,
      restored_files: restoredReceipt.files, omissions: restoredReceipt.omissions,
    }));
  }, 240_000);

  it('rechaza la lectura y la ficha del espacio para otra empresa sin filtrar su copia', async () => {
    if (!pageB) throw new Error('foreign owner has no page yet');
    const page = pageB;
    errors.expectHttpError(backupPath(backupId), 404);
    const direct = await apiGet(page, backupPath(backupId));
    expect(direct.status).toBe(404);
    expect(JSON.stringify(direct.body)).not.toContain(receiptSha256);
    await step(page, 'foreign owner cannot open the canary agent', async () => {
      await page.goto(agentUrl(), { waitUntil: 'domcontentloaded' });
      await page.getByText('No encontramos esa conversación', { exact: true }).waitFor({ timeout: 20_000 });
      const body = await page.locator('body').innerText();
      expect(body).not.toContain('Backup del espacio');
      expect(body).not.toContain(receiptSha256);
    });
    errors.assertClean();
  }, 120_000);
});
