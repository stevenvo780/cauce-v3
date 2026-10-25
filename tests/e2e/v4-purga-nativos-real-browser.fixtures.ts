import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { enrollComputer, startComputerHarness, type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { asV4Page, fillRegistration, openRegistration, syntheticPerson, type V4Page } from './v4-console-real-browser.helpers.js';

const execute = promisify(execFile);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
interface ViteServer { close(): Promise<void>; listen(): Promise<void> }
export const OWNER = 'f3b-commit-1025';
export const RECEIPTS = join(process.cwd(), '.delegados/v4/recibos', OWNER, `native-${randomUUID()}`);

export interface NativeManifest {
  key: string; unit: string; files: string[]; state: string; control: string; adoption: string;
  home: string; user: string; host: string; active: string; enabled: string;
}
export interface NativeObservation {
  properties: { LoadState?: string; ActiveState?: string; FragmentPath?: string; UnitFileState?: string; MainPID?: string };
  paths: Record<string, boolean>; enabled_link: boolean; adoption_policy_preserved: boolean;
  file_hashes: Record<string, string>;
}
export interface NativeFixture {
  computer: ComputerHarness; page: V4Page; tenant: string; company: string; host: string; baseUrl: string;
  close(): Promise<void>;
}

async function certificates(directory: string) {
  const ca = join(directory, 'ca.crt'), caKey = join(directory, 'ca.key');
  const key = join(directory, 'vite.key'), cert = join(directory, 'vite.crt'), config = join(directory, 'vite.cnf');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-keyout', caKey,
    '-out', ca, '-subj', '/CN=Cauce native purge E2E CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:FALSE\n'
    + 'keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', join(directory, 'vite.csr'), '-config', config]);
  await execute('openssl', ['x509', '-req', '-in', join(directory, 'vite.csr'), '-CA', ca, '-CAkey', caKey, '-CAcreateserial',
    '-out', cert, '-days', '2', '-sha256', '-extfile', config, '-extensions', 'ext']);
  await chmod(caKey, 0o600); await chmod(key, 0o600);
  return { ca, key, cert };
}

async function nativeComputer(prefix: string, baseUrl: string): Promise<ComputerHarness> {
  const workRoot = await mkdtemp('/datos/f3n-');
  try {
    await chmod(workRoot, 0o755);
    const computer = await startComputerHarness({ prefix, consoleOrigins: [baseUrl], workRoot, resourceOwner: OWNER });
    return { ...computer, close: async () => {
      try { return await computer.close(); }
      finally { await rm(workRoot, { recursive: true, force: true }); }
    } };
  } catch (error) { await rm(workRoot, { recursive: true, force: true }); throw error; }
}

export async function nativeFixture(run: string): Promise<NativeFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-native-purge-'));
  let computer: ComputerHarness | undefined, browser: TrustedBrowser | undefined, vite: ViteServer | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    for (const cleanup of [() => browser?.close(), () => vite?.close(), () => computer?.close(),
      () => rm(directory, { recursive: true, force: true })]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'native purge cleanup incomplete');
  };
  try {
    const pki = await certificates(directory);
    const ports = await reserveNamedLoopbackPorts(['frontend', 'spare'] as const); await ports.releaseAll();
    const baseUrl = `https://localhost:${String(ports.ports.frontend)}`;
    computer = await nativeComputer(`zz-canary-${OWNER}-${run}`, baseUrl);
    const server = await (consoleRequire('vite') as { createServer(options: Record<string, unknown>): Promise<ViteServer> }).createServer({
      configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory,
      server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true, hmr: false, watch: null,
        https: { key: await readFile(pki.key), cert: await readFile(pki.cert) },
        proxy: { '/v3': { target: computer.gatewayUrl, changeOrigin: false, ws: true } } },
    });
    vite = server; await server.listen();
    browser = await startTrustedBrowser(pki.ca, directory, [ports.ports.frontend, Number(new URL(computer.gatewayUrl).port)]);
    const context = await browser.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    const page = asV4Page(await context.newPage());
    const owner = { ...syntheticPerson('nativepurge', run), company: { slug: `zz-native-${run}`, name: `zz-canary purga nativa ${run}` } };
    const form = await openRegistration(page, baseUrl); await fillRegistration(form, owner);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const login = await computer.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl },
      payload: { email: owner.email, password: owner.password } });
    if (login.statusCode !== 200) throw new Error(`native purge login answered ${String(login.statusCode)}`);
    const header = login.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
    const session = { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token };
    const host = `${owner.company.slug}-pc`;
    await enrollComputer(computer, session, owner.company.slug, host);
    const tenant = (await computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0]?.tenant_id;
    if (!tenant) throw new Error('native purge company has no tenant');
    return { computer, page, tenant, company: owner.company.slug, host, baseUrl, close };
  } catch (error) { await close(); throw error; }
}

export async function nativeCommand<T>(fixture: NativeFixture, ...args: string[]): Promise<T> {
  const script = await readFile(join(process.cwd(), 'tests/e2e/v4-purga-nativos-systemd.fixture.py'), 'utf8');
  const result = await fixture.computer.onComputer(['python3', '-c', script, ...args]);
  if (result.code !== 0) throw new Error(`native fixture ${args[0] ?? ''} failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

export async function seedNative(fixture: NativeFixture, alias: string, key: string, foreign = false, retired = true): Promise<NativeManifest> {
  const manifest = await nativeCommand<NativeManifest>(fixture, 'prepare', fixture.computer.installRoot, fixture.tenant, alias, key,
    foreign ? 'foreign' : 'managed');
  await fixture.computer.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,lifecycle_state,retired_at,
    company_id,runtime_key,host_id,runtime_mode,container_name,runtime_user,home_directory,state_directory,systemd_user)
    VALUES($1,$2,'codex',$2,$10,CASE WHEN $10 THEN 'ready' ELSE 'retired' END,
      CASE WHEN $10 THEN NULL ELSE now() END,$3,$4,$5,'native',$6,$7,$8,$9,$7)`,
  [fixture.tenant, alias, fixture.company, key, fixture.host, `host:${fixture.host}`, manifest.user, manifest.home, manifest.state, !retired]);
  if (!retired) {
    await fixture.computer.pool.query(
      "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [fixture.tenant, alias]);
    await fixture.computer.pool.query("UPDATE agents SET primary_room_id='office' WHERE tenant_id=$1 AND alias=$2", [fixture.tenant, alias]);
  }
  return manifest;
}
