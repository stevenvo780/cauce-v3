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
  syntheticPerson, type IgnoredConsoleRule, type V4Locator, type V4Page } from './v4-console-real-browser.helpers.js';

const execute = promisify(execFile);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
export const COVERAGE_OWNER = 'e2e-a2-cobertura-l-1025';
export interface CoverageOperation {
  id: string; kind: string; status: string; version: number; error: unknown; request_sha256: string;
  steps: { name: string; status: string; evidence?: Record<string, unknown> }[];
}
export interface CoverageFixture {
  computer: ComputerHarness; page: V4Page; errors: BrowserErrorLog; baseUrl: string; tenantId: string; companyId: string;
  hostId: string; accountId: string; room: string; unit: string; prefix: string; receipts: string; run: string;
  close(): Promise<void>;
}

async function certificates(directory: string): Promise<{ ca: string; key: string; cert: string }> {
  const ca = join(directory, 'ca.crt'), caKey = join(directory, 'ca.key'), key = join(directory, 'vite.key'), cert = join(directory, 'vite.crt');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-keyout', caKey, '-out', ca,
    '-subj', '/CN=Cauce lifecycle coverage E2E CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  const config = join(directory, 'vite.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:FALSE\n'
    + 'keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', join(directory, 'vite.csr'), '-config', config]);
  await execute('openssl', ['x509', '-req', '-in', join(directory, 'vite.csr'), '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert,
    '-days', '2', '-sha256', '-extfile', config, '-extensions', 'ext']);
  await chmod(caKey, 0o600); await chmod(key, 0o600);
  return { ca, key, cert };
}

export async function startCoverageFixture(section: string, options: {
  providerLogin?: boolean; extraSourceFiles?: readonly string[]; ignoredConsoleRules?: readonly IgnoredConsoleRule[];
} = {}): Promise<CoverageFixture> {
  if (!/^[a-z]{1,4}$/u.test(section)) throw new Error('coverage section must contain one to four lowercase letters');
  const run = randomUUID().replaceAll('-', '').slice(0, 8);
  const prefix = `zz-canary-${COVERAGE_OWNER}-${section}-${run}`;
  const receipts = join(process.cwd(), '.delegados/v4/recibos', COVERAGE_OWNER, section, run);
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  console.info('AGENTES_COVERAGE_RECEIPTS', JSON.stringify({ section, run, prefix, receipts }));
  const directory = await mkdtemp(join(tmpdir(), 'cauce-agent-coverage-'));
  const pki = await certificates(directory);
  const ports = await reserveNamedLoopbackPorts(['frontend'] as const); await ports.releaseAll();
  const baseUrl = `https://localhost:${String(ports.ports.frontend)}`;
  let computer: ComputerHarness | undefined, trusted: TrustedBrowser | undefined;
  let page: V4Page | undefined;
  const { ignoredConsoleRules = [], ...computerOptions } = options;
  const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE, ...ignoredConsoleRules]);
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    for (const action of [async () => trusted?.close(), async () => vite?.close(), async () => {
      if (computer) {
        const after = await computer.close();
        await writeFile(join(receipts, 'cleanup.json'), JSON.stringify(after, null, 2) + '\n');
        expect(after).toEqual({ containers: '', volumes: '', images: '' });
      }
    }, async () => rm(directory, { recursive: true, force: true })]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'agent coverage cleanup failed');
  };
  try {
    computer = await startComputerHarness({ prefix, consoleOrigins: [baseUrl], workRoot: '/datos', resourceOwner: COVERAGE_OWNER, ...computerOptions });
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
    errors.watch(page, `coverage-${section}-owner`);
    const person = { ...syntheticPerson(`coverage-${section}`, run), email: `${prefix}@example.test`,
      company: { name: `${prefix}-empresa`, slug: `zz-${section}-${run}` } };
    const form = await openRegistration(page, baseUrl); await fillRegistration(form, person);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const login = await computer.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl }, payload: { email: person.email, password: person.password } });
    expect(login.statusCode).toBe(200);
    const header = login.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
    const session = { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token };
    const hostId = `${person.company.slug}-pc`;
    const unit = await enrollComputer(computer, session, person.company.slug, hostId);
    const tenantId = (await computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email])).rows[0]?.tenant_id;
    if (!tenantId) throw new Error('coverage company has no tenant');
    const room = (await computer.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenantId])).rows[0]?.id;
    if (!room) throw new Error('coverage company has no room');
    const accountId = `zz-${section}-${run}`;
    await computer.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$2,$3,'env_path','CAUCE_COVERAGE_PROFILE_PATH',true)`, [accountId, FIXTURE_PROVIDER_IDENTITY, tenantId]);
    return { computer, page, errors, baseUrl, tenantId, companyId: person.company.slug, hostId, accountId, room, unit, prefix, receipts, run, close };
  } catch (error) {
    try {
      if (page) {
        const diagnostic = { error: error instanceof Error ? error.stack : String(error), page: await bodySnippet(page),
          trace: errors.trace, unexpected: errors.unexpected };
        await writeFile(join(receipts, 'startup-failure.json'), JSON.stringify(diagnostic, null, 2) + '\n', { mode: 0o600 });
        await page.screenshot({ path: join(receipts, 'startup-failure.png') }).catch(() => undefined);
        console.info('AGENTES_COVERAGE_STARTUP_FAILURE', JSON.stringify(diagnostic));
      }
    } finally { await close(); }
    throw error;
  }
}

export async function coverageOperations(fixture: CoverageFixture, alias: string): Promise<CoverageOperation[]> {
  const response = await apiGet(fixture.page, `/v3/console/fleet/operations?resource=agent&tenant_id=${encodeURIComponent(fixture.tenantId)}&alias=${encodeURIComponent(alias)}`);
  expect(response.status).toBe(200);
  return response.body.operations as CoverageOperation[];
}
export async function coverageCapture(fixture: CoverageFixture, name: string): Promise<void> {
  const original = fixture.page.viewportSize();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await fixture.page.setViewportSize(viewport);
      await fixture.page.screenshot({ path: join(fixture.receipts, `${name}-${String(viewport.width)}x${String(viewport.height)}.png`) });
    }
  } finally { if (original) await fixture.page.setViewportSize(original); }
}
export async function coverageEnabled(locator: V4Locator): Promise<void> {
  await expect.poll(() => locator.isDisabled(), { timeout: 30_000 }).toBe(false);
}
export async function coverageEnqueue(fixture: CoverageFixture, panel: V4Locator, alias: string, kind: string,
  statuses = ['succeeded']): Promise<CoverageOperation> {
  const known = new Set((await coverageOperations(fixture, alias)).map(row => row.id));
  const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await coverageEnabled(preview); await preview.click();
  const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
  await coverageEnabled(confirm); await confirm.click();
  let result: CoverageOperation | undefined;
  await expect.poll(async () => {
    result = (await coverageOperations(fixture, alias)).find(row => !known.has(row.id) && row.kind === kind);
    if (result && ['failed', 'cancelled'].includes(result.status) && !statuses.includes(result.status)) {
      throw new Error(`${kind} failed: ${JSON.stringify(result)}; ${await bodySnippet(fixture.page)}`);
    }
    return result !== undefined && statuses.includes(result.status);
  }, { timeout: 240_000, interval: 1000 }).toBe(true);
  if (!result) throw new Error(`${kind} produced no operation`);
  return result;
}
export async function createCoverageAgent(fixture: CoverageFixture, alias: string, runtimeKey: string): Promise<CoverageOperation> {
  const { page, baseUrl, tenantId, room, hostId } = fixture;
  await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const panel = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await panel.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
  await panel.getByLabel('Alias operativo').fill(alias);
  await panel.getByLabel('Nombre visible operativo').fill(`Cobertura ${alias}`);
  await panel.getByLabel('Clave física de ejecución').fill(runtimeKey);
  await panel.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
  await panel.getByLabel('Grupo primario').selectOption(room);
  await panel.getByLabel('Host operativo').locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await panel.getByLabel('Host operativo').selectOption(hostId);
  await panel.getByLabel('Plantilla de ejecución').selectOption('0');
  return coverageEnqueue(fixture, panel, alias, 'create');
}
