import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CauceRepository, FleetOperationsRepository } from '@cauce/store';
import { expect } from 'vitest';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { SignedFleetAuthorityClient } from '../../services/gateway/src/fleet/authority/signed-client.js';
import { docker, startComputerHarness, type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { HostSetupPackager } from '../../services/gateway/src/fleet/host-setup.js';
import { inviteSetupHost, type SetupOwnerSession } from '../../services/gateway/src/fleet/host-setup.fixtures.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { asV4Page, fillRegistration, openRegistration, syntheticPerson, type V4Locator, type V4Page } from './v4-console-real-browser.helpers.js';

export const TASK = 'c8d-copias-v3-reales-1025';
export const RUN = randomUUID().replaceAll('-', '').slice(0, 8);
export const PREFIX = `zz-canary-c8d-${RUN}`;
export const EVIDENCE = join(process.cwd(), '.delegados/v4/recibos', TASK, RUN);
export const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));

export interface LegacyCopyFixture {
  computer: ComputerHarness; browser: TrustedBrowser; page: V4Page; directory: string; storage: string;
  baseUrl: string; company: string; tenant: string; host: string; alias: string; runtimeKey: string;
  legacy: string; undeclared: string; foreignContainer: string;
  activate(backupsOnly: boolean): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function receipt(name: string, value: unknown): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
  await writeFile(join(EVIDENCE, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export async function capture(page: V4Page, phase: string, target: V4Locator): Promise<void> {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await target.evaluate(element => { element.scrollIntoView({ block: 'center' }); });
    expect(await target.isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: join(EVIDENCE, `${phase}-${String(viewport.width)}x${String(viewport.height)}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

export async function sourcePython(container: string, program: string, args: string[] = []): Promise<string> {
  return docker(['exec', '--user', 'dev', container, 'python3', '-I', '-B', '-c', program, ...args]);
}

export async function registerCompany(page: V4Page, baseUrl: string, tag: string) {
  const owner = syntheticPerson(tag, RUN);
  owner.company = { name: `${PREFIX}-${tag}`, slug: `zz-c8d-${tag}-${RUN}` };
  const form = await openRegistration(page, baseUrl); await fillRegistration(form, owner);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  return owner;
}

async function legacyContainer(computer: ComputerHarness, name: string): Promise<void> {
  await docker(['run', '-d', '--name', name, '--label', `cauce.e2e.owner=${TASK}`, '--network', 'none',
    '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'CHOWN',
    '--security-opt', 'no-new-privileges', '--entrypoint', '/bin/sleep', `${computer.prefix}:computer`, 'infinity']);
  await docker(['exec', name, 'useradd', '-m', '-u', '1600', '-s', '/bin/sh', 'dev']);
}

export async function startLegacyCopyFixture(): Promise<LegacyCopyFixture> {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || !process.env.HOME?.startsWith(`/tmp/cauce-e2e-home-${TASK}-`)) {
    throw new Error('the canonical isolated docker-lab runner is required');
  }
  await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tmpdir(), `${PREFIX}-`)); await chmod(directory, 0o700);
  const storage = join(directory, 'copies'); const tls = createSelfSignedCert({ directory });
  const ports = await reserveNamedLoopbackPorts(['frontend'] as const);
  const baseUrl = `https://localhost:${String(ports.ports.frontend)}`;
  const company = `zz-c8d-owner-${RUN}`, host = `${company}-pc`;
  const alias = `zz-copy-${RUN}`, runtimeKey = `zz-runtime-${RUN}`;
  const legacy = `${PREFIX}-legacy`, undeclared = `${PREFIX}-undeclared`, foreignContainer = `${PREFIX}-foreign`;
  let computer: ComputerHarness | undefined, browser: TrustedBrowser | undefined;
  let gateway: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  const close = async () => {
    const failures: unknown[] = []; const states: Record<string, unknown> = {};
    for (const [name, action] of [
      ['browser', async () => browser?.close()], ['frontend', async () => vite?.close()],
      ['gateway', async () => gateway?.close()], ['computer', async () => {
        if (computer) { states.inventory = await computer.close(); expect(states.inventory).toEqual({ containers: '', volumes: '', images: '' }); }
      }], ['ports', async () => ports.releaseAll()], ['directory', async () => rm(directory, { recursive: true, force: true })],
    ] as const) {
      try { await action(); states[name] = 'closed'; }
      catch (error) { failures.push(error); states[name] = error instanceof Error ? error.message : String(error); }
    }
    await receipt('cleanup', { ...states, complete: failures.length === 0 });
    if (failures.length) throw new AggregateError(failures, 'legacy setup copy cleanup incomplete');
  };
  try {
    const untracked = await execute('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', 'ops/cli', 'services/gateway/src']);
    const extraSourceFiles = untracked.stdout.split('\0').filter(path => /\.(?:py|ts)$/u.test(path) && !path.includes('.test.'));
    const previous = { storage: process.env.CAUCE_SPACE_BACKUP_DIRECTORY, root: process.env.CAUCE_PROJECT_ROOT };
    process.env.CAUCE_SPACE_BACKUP_DIRECTORY = storage; process.env.CAUCE_PROJECT_ROOT = process.cwd();
    try { computer = await startComputerHarness({ prefix: PREFIX, consoleOrigins: [baseUrl], resourceOwner: TASK, workRoot: '/datos', extraSourceFiles }); }
    finally {
      if (previous.storage === undefined) delete process.env.CAUCE_SPACE_BACKUP_DIRECTORY; else process.env.CAUCE_SPACE_BACKUP_DIRECTORY = previous.storage;
      if (previous.root === undefined) delete process.env.CAUCE_PROJECT_ROOT; else process.env.CAUCE_PROJECT_ROOT = previous.root;
    }
    const active = computer;
    for (const container of [legacy, undeclared, foreignContainer]) await legacyContainer(active, container);
    const baseline = active.packager.build({ company_id: company, host_id: host, harnesses: ['codex'] }).package.policy as { authority: Record<string, unknown> };
    baseline.authority = { ...baseline.authority, host_id: '@host@' };
    const signer = generateKeyPairSync('ed25519').privateKey;
    const signerFile = join(directory, 'activation-signing.pem');
    await writeFile(signerFile, signer.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    let hasEnrolled = false;
    const activate = async (backupsOnly: boolean) => {
      const configFile = join(directory, 'host-activation.json');
      const activation = { version: 1, signing_key_file: signerFile, release_directory: join(dirname(active.installRoot), 'host-release'),
        files: [{ name: 'fleet-ca', path: join(dirname(active.installRoot), 'authority/ca.crt') }], policy: baseline,
        legacy_backup_containers: { [company]: { [host]: { [legacy]: { runtime_user: 'dev', systemd_user: 'dev', home_directory: '/home/dev' } } } },
        ...(backupsOnly ? { backup_only_hosts: { [company]: [host] } } : {}) };
      const activationBytes = JSON.stringify(activation);
      await writeFile(configFile, activationBytes, { mode: 0o600 });
      await receipt(backupsOnly ? 'B-activation' : 'A-activation', { configuration: activation,
        sha256: hash(activationBytes), loaded_with: 'HostSetupPackager.load', hand_written_executor_policy: false });
      const packager = await HostSetupPackager.load(configFile);
      if (gateway) await gateway.close(); else await active.app.close();
      gateway = await buildGateway({ pool: active.pool, repository: new CauceRepository(active.pool), consoleOrigins: [baseUrl], logger: false,
        authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(active.pool), signingKey: Buffer.alloc(32, 61) }),
        hostSetup: packager, fleetOperationsRepository: new FleetOperationsRepository(active.pool),
        signedFleetAuthorityClient: new SignedFleetAuthorityClient(join(dirname(active.installRoot), 'authority/signed.sock'),
          { ownerUid: process.geteuid?.() ?? 0, peerUid: process.geteuid?.() ?? 0 }),
        spaceBackups: { directory: storage, projectRoot: process.cwd() } });
      await gateway.listen({ host: '127.0.0.1', port: Number(new URL(active.gatewayUrl).port) });
      if (hasEnrolled) {
        const setup = await active.onComputer(['bash', '/opt/cauce-cli/cauce', 'hosts', 'setup', '--install-root', active.installRoot]);
        await receipt(backupsOnly ? 'B-setup-command' : 'A-setup-command', { command: 'cauce hosts setup --install-root <owned-lab-root>', ...setup });
        expect(setup.code, setup.stderr).toBe(0);
      }
      return activation;
    };
    await activate(false);
    vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
      configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory, cacheDir: join(directory, 'vite-cache'),
      server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true, watch: null, hmr: false,
        https: { key: await readFile(tls.key_path), cert: await readFile(tls.cert_path) },
        proxy: { '/v3': { target: active.gatewayUrl, changeOrigin: false, ws: true } } },
    });
    await ports.releaseAll(); await vite.listen();
    browser = await startTrustedBrowser(tls.cert_path, directory, [ports.ports.frontend, Number(new URL(active.gatewayUrl).port)], 1800);
    const context = await browser.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    const page = asV4Page(await context.newPage()); const owner = await registerCompany(page, baseUrl, 'owner');
    expect(owner.company.slug).toBe(company);
    if (!gateway) throw new Error('activation gateway is absent');
    const login = await gateway.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl }, payload: { email: owner.email, password: owner.password } });
    expect(login.statusCode).toBe(200); const setCookie = login.headers['set-cookie'];
    const session: SetupOwnerSession = { origin: baseUrl, cookie: (Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie]).map(value => value.split(';', 1)[0]).join('; '),
      'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token };
    const invitation = await inviteSetupHost(gateway, session, host);
    const enrolled = await active.onComputer(['bash', '/opt/cauce-cli/cauce', 'hosts', 'enroll', '--gateway', active.gatewayUrl, '--invitation-stdin'], JSON.stringify(invitation));
    expect(enrolled.code, enrolled.stderr).toBe(0);
    hasEnrolled = true;
    await activate(false);
    const tenant = (await active.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0]?.tenant_id ?? '';
    expect(tenant).not.toBe('');
    return { computer: active, browser, page, directory, storage, baseUrl, company, tenant, host, alias, runtimeKey, legacy, undeclared, foreignContainer, activate, close };
  } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'legacy setup startup failed'); } throw error; }
}
