import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect } from 'vitest';
import { FIXTURE_PROVIDER_IDENTITY, docker, enrollComputer, startComputerHarness,
  type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration,
  syntheticPerson, type V4Locator, type V4Page, type V4Person } from './v4-console-real-browser.helpers.js';
import { standardRecoveryBundle } from './v4-reiniciar-agente-standard.fixtures.js';

export const accreditedTask = 'a2x-filas-ejecutor-acreditado-1025';
export interface AccreditedFixture {
  computer: ComputerHarness; page: V4Page; trusted: TrustedBrowser; errors: BrowserErrorLog; baseUrl: string;
  tenant: string; host: string; account: string; room: string; prefix: string; run: string; evidence: string; storage: string;
  person: V4Person; close(): Promise<void>;
  unsupportedNativeTargets: Set<string>; retiredContextTargets: Set<string>;
}

export async function accreditedReceipt(fixture: Pick<AccreditedFixture, 'evidence'>, name: string, value: unknown): Promise<void> {
  await writeFile(join(fixture.evidence, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export async function accreditedCapture(fixture: AccreditedFixture, name: string, focus?: V4Locator): Promise<void> {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await fixture.page.setViewportSize({ width, height });
    if (focus) await focus.evaluate(element => { element.scrollIntoView({ block: 'center' }); });
    const path = join(fixture.evidence, `${name}-${String(width)}.png`);
    const safe = fixture.page as V4Page & { screenshot(options: {
      path: string; fullPage: boolean; mask: ReturnType<V4Page['locator']>[];
    }): Promise<Buffer> };
    await safe.screenshot({ path, fullPage: true, mask: [fixture.page.locator('input[type="password"]')] });
    await chmod(path, 0o600);
  }
  await fixture.page.setViewportSize({ width: 1440, height: 900 });
}

export async function startAccreditedFixture(): Promise<AccreditedFixture> {
  if (await docker(['info', '--format', '{{.Name}}']) !== 'docker-lab') throw new Error('Accredited settings require docker-lab');
  const run = randomUUID().slice(0, 8), prefix = `zz-canary-a2xs-${run}`;
  const evidence = join(process.cwd(), '.delegados/v4/recibos', accreditedTask, 'settings', run);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp('/tmp/zz-canary-a2xs-private-');
  const storage = join(directory, 'backups');
  await mkdir(storage, { mode: 0o700 });
  const tls = createSelfSignedCert({ directory });
  await chmod(tls.key_path, 0o600);
  const ports = await reserveNamedLoopbackPorts(['frontend', 'spare'] as const);
  await ports.releaseAll();
  const baseUrl = `https://localhost:${String(ports.ports.frontend)}`;
  const person = { ...syntheticPerson('a2xs', run), name: prefix, email: `${prefix}@example.invalid`,
    company: { name: prefix, slug: prefix } };
  let computer: ComputerHarness | undefined, trusted: TrustedBrowser | undefined;
  let tenant = '';
  const unsupportedNativeTargets = new Set<string>(), retiredContextTargets = new Set<string>();
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  const close = async () => {
    const failed: string[] = [];
    let inventory: { containers: string; volumes: string; images: string } | undefined;
    for (const [name, action] of [
      ['browser', async () => trusted?.close()], ['frontend', async () => vite?.close()],
      ['computer', async () => { if (computer) inventory = await computer.close(); }],
      ['private-files', async () => rm(directory, { recursive: true, force: true })],
    ] as const) {
      try { await action(); } catch { failed.push(name); }
    }
    await accreditedReceipt({ evidence }, 'cleanup', { prefix, failed, inventory });
    expect(failed).toEqual([]);
    if (inventory) expect(inventory).toEqual({ containers: '', volumes: '', images: '' });
  };
  try {
    const previous = { directory: process.env.CAUCE_SPACE_BACKUP_DIRECTORY, root: process.env.CAUCE_PROJECT_ROOT };
    process.env.CAUCE_SPACE_BACKUP_DIRECTORY = storage;
    process.env.CAUCE_PROJECT_ROOT = process.cwd();
    try {
      computer = await startComputerHarness({ prefix, consoleOrigins: [baseUrl], workRoot: '/datos',
        resourceOwner: accreditedTask, runtimeBundle: standardRecoveryBundle });
    } finally {
      if (previous.directory === undefined) delete process.env.CAUCE_SPACE_BACKUP_DIRECTORY;
      else process.env.CAUCE_SPACE_BACKUP_DIRECTORY = previous.directory;
      if (previous.root === undefined) delete process.env.CAUCE_PROJECT_ROOT;
      else process.env.CAUCE_PROJECT_ROOT = previous.root;
    }
    const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
    vite = await (consoleRequire('vite') as { createServer(options: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
      configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory,
      cacheDir: join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true,
        watch: null, hmr: false, https: { key: await readFile(tls.key_path), cert: await readFile(tls.cert_path) },
        proxy: { '/v3': { target: computer.gatewayUrl, changeOrigin: false, ws: true } } },
    });
    await vite.listen();
    trusted = await startTrustedBrowser(tls.cert_path, directory, [ports.ports.frontend, ports.ports.spare]);
    const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    const page = asV4Page(await context.newPage()), errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
      id: 'owned-native-probe-unavailable', reason: 'the owned computer fixture proves its native document probe is not installed',
      matches: (text, url) => {
        if (!text.includes('status of 501') || computer?.app.sondaDeDocumentos?.instalada !== false) return false;
        const path = new URL(url);
        return path.origin === baseUrl && path.search === '' && [...unsupportedNativeTargets]
          .some(alias => path.pathname === `/v3/console/tenants/${tenant}/agents/${alias}/native/skill`);
      },
    }, {
      id: 'owned-retired-context-unavailable', reason: 'context reads require an active agent; retirement was verified in the owned database',
      matches: (text, url) => {
        if (!text.includes('status of 404')) return false;
        const path = new URL(url);
        return path.origin === baseUrl && path.search === '' && [...retiredContextTargets].some(alias =>
          [`/v3/console/context/agents/${tenant}/${alias}`, `/v3/console/context/agents/${tenant}/${alias}/history`].includes(path.pathname));
      },
    }]);
    errors.watch(page, 'accredited-settings-owner');
    const registration = await openRegistration(page, baseUrl);
    await fillRegistration(registration, person);
    await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const login = await computer.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl },
      payload: { email: person.email, password: person.password } });
    expect(login.statusCode).toBe(200);
    const header = login.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header : header ? [header] : []).map(value => value.split(';', 1)[0]).join('; ');
    const host = `${prefix}-pc`;
    await enrollComputer(computer, { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token }, person.company.slug, host);
    tenant = (await computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email])).rows[0]?.tenant_id ?? '';
    if (!tenant) throw new Error('Accredited settings tenant unavailable');
    const room = (await computer.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id;
    if (!room) throw new Error('Accredited settings room unavailable');
    const account = `${prefix}-account`;
    await computer.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$2,$3,'env_path','CAUCE_E2E_SETTINGS_PROFILE_PATH',true)`, [account, FIXTURE_PROVIDER_IDENTITY, tenant]);
    const files = ['tests/e2e/v4-agentes-settings-cobertura-real-browser.test.ts',
      'tests/e2e/v4-agentes-settings-accredited.fixture.ts', 'tests/e2e/v4-agentes-settings-accredited.lifecycle.ts'];
    const sourceSha256 = Object.fromEntries(await Promise.all(files.map(async file =>
      [file, createHash('sha256').update(await readFile(file)).digest('hex')] as const)));
    await accreditedReceipt({ evidence }, 'fixture', { task: accreditedTask, run, prefix, tenant, host, account, room,
      daemon: 'docker-lab', sharedTui: true, syntheticProvider: true, sourceSha256, envAndCacheOutsideConsole: true });
    return { computer, trusted, page, errors, baseUrl, tenant, host, account, room, prefix, run, evidence, storage, person,
      unsupportedNativeTargets, retiredContextTargets, close };
  } catch (error) {
    await close();
    throw error;
  }
}
