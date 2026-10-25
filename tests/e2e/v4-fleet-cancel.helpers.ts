import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { FIXTURE_PROVIDER_IDENTITY, enrollComputer, startComputerHarness, type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration, PATTERN_DEFECT_RULE,
  syntheticPerson, type V4Page } from './v4-console-real-browser.helpers.js';

const execute = promisify(execFile);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
export const CANCEL_OWNER = 'f4b-cancelar-1025';
export const cancelRun = randomUUID().replaceAll('-', '').slice(0, 8);
export const cancelPrefix = `zz-canary-${CANCEL_OWNER}-${cancelRun}`;
export const cancelReceipts = join(process.cwd(), '.delegados/v4/recibos', CANCEL_OWNER, cancelRun);
export interface CancelOperation {
  id: string; kind: string; status: string; version: number; error: unknown;
  steps: { name: string; status: string; evidence?: Record<string, unknown> }[];
}
export interface CancelFixture {
  computer: ComputerHarness; page: V4Page; errors: BrowserErrorLog; baseUrl: string; tenantId: string; hostId: string; accountId: string; room: string;
  close(): Promise<void>;
}

async function certificates(directory: string): Promise<{ ca: string; key: string; cert: string }> {
  const ca = join(directory, 'ca.crt'), caKey = join(directory, 'ca.key'), key = join(directory, 'vite.key'), cert = join(directory, 'vite.crt');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-keyout', caKey, '-out', ca,
    '-subj', '/CN=Cauce fleet cancellation E2E CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  const config = join(directory, 'vite.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:FALSE\n'
    + 'keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', join(directory, 'vite.csr'), '-config', config]);
  await execute('openssl', ['x509', '-req', '-in', join(directory, 'vite.csr'), '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert,
    '-days', '2', '-sha256', '-extfile', config, '-extensions', 'ext']);
  await chmod(caKey, 0o600); await chmod(key, 0o600);
  return { ca, key, cert };
}

export async function startCancelFixture(options: { extraSourceFiles?: readonly string[] } = {}): Promise<CancelFixture> {
  await mkdir(cancelReceipts, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tmpdir(), 'cauce-fleet-cancel-'));
  const pki = await certificates(directory);
  const ports = await reserveNamedLoopbackPorts(['frontend'] as const);
  await ports.releaseAll();
  const origin = `https://localhost:${String(ports.ports.frontend)}`;
  let computer: ComputerHarness | undefined;
  let trusted: TrustedBrowser | undefined;
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  let page: V4Page | undefined;
  let errors: BrowserErrorLog | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    for (const action of [async () => trusted?.close(), async () => vite?.close(), async () => {
      if (computer) expect(await computer.close()).toEqual({ containers: '', volumes: '', images: '' });
    }, async () => rm(directory, { recursive: true, force: true })]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'fleet cancellation cleanup failed');
  };
  try {
    computer = await startComputerHarness({ prefix: cancelPrefix, consoleOrigins: [origin], workRoot: '/datos', resourceOwner: CANCEL_OWNER,
      ...options });
    const server = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
      configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory,
      cacheDir: join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true, watch: null, hmr: false,
        https: { key: await readFile(pki.key), cert: await readFile(pki.cert) },
        proxy: { '/v3': { target: computer.gatewayUrl, changeOrigin: false, ws: true } } },
    });
    vite = server; await server.listen();
    trusted = await startTrustedBrowser(pki.ca, directory, [ports.ports.frontend, Number(new URL(computer.gatewayUrl).port)]);
    const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    page = asV4Page(await context.newPage());
    errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
    errors.watch(page, 'fleet-cancel-owner');
    const owner = { ...syntheticPerson('cancel', cancelRun), email: `${cancelPrefix}@example.test`,
      company: { name: `zz-canary-empresa-cancel-${cancelRun}`, slug: `zz-cancel-${cancelRun}` } };
    const form = await openRegistration(page, origin);
    await fillRegistration(form, owner);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const login = await computer.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin }, payload: { email: owner.email, password: owner.password } });
    expect(login.statusCode).toBe(200);
    const header = login.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
    const session = { cookie, origin, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token };
    const hostId = `${owner.company.slug}-pc`;
    await enrollComputer(computer, session, owner.company.slug, hostId);
    const tenantId = (await computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0]?.tenant_id;
    if (!tenantId) throw new Error('cancellation company has no tenant');
    const room = (await computer.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenantId])).rows[0]?.id;
    if (!room) throw new Error('cancellation company has no room');
    const accountId = `zz-cancel-${cancelRun}`;
    await computer.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$2,$3,'env_path','CAUCE_FLEET_CANCEL_PROFILE_PATH',true)`, [accountId, FIXTURE_PROVIDER_IDENTITY, tenantId]);
    return { computer, page, errors, baseUrl: origin, tenantId, hostId, room, accountId, close };
  } catch (error) {
    try {
      if (page) {
        await writeFile(join(cancelReceipts, 'bootstrap-failure.json'), JSON.stringify({
          error: error instanceof Error ? error.message : String(error), page: await bodySnippet(page),
          browserErrors: errors?.unexpected, browserTrace: errors?.trace,
        }, null, 2) + '\n', { mode: 0o600 });
        await page.screenshot({ path: join(cancelReceipts, 'bootstrap-failure.png') }).catch(() => undefined);
      }
    } finally { await close(); }
    throw error;
  }
}

export async function cancelOperations(fixture: CancelFixture, alias: string): Promise<CancelOperation[]> {
  const response = await apiGet(fixture.page, `/v3/console/fleet/operations?resource=agent&tenant_id=${encodeURIComponent(fixture.tenantId)}&alias=${alias}`);
  expect(response.status).toBe(200);
  return response.body.operations as CancelOperation[];
}

export async function cancelCapture(page: V4Page, name: string): Promise<void> {
  const original = page.viewportSize();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: join(cancelReceipts, `${name}-${String(viewport.width)}x${String(viewport.height)}.png`) });
    }
  } finally { if (original) await page.setViewportSize(original); }
}
