import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { COMPUTER_RUNTIME, FIXTURE_PROVIDER_IDENTITY, docker, enrollComputer, startComputerHarness,
  type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { redactExecutorStderr } from '../../services/gateway/src/fleet/host-stderr.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { asV4Page, fillRegistration, openRegistration, syntheticPerson, type V4Page } from './v4-console-real-browser.helpers.js';
import { standardRecoveryBundle } from './v4-reiniciar-agente-standard.fixtures.js';

const execute = promisify(execFile);
const root = process.cwd();
export const retiredRoomOwner = 'r8b-membresia-sala-retirada-1025';
export const retiredRoomRun = randomUUID().slice(0, 8);
export const retiredRoomPrefix = `zz-canary-r8b-room-${retiredRoomRun}`;
export const retiredRoomEvidence = join(root, '.delegados/v4/recibos', retiredRoomOwner, retiredRoomRun);

interface SourceExport { types?: string }
async function workspaceAliases() {
  const aliases = ['protocol', 'store', 'adapter-sdk', 'mcp-fleet-monitor'].map(name => ({
    find: new RegExp(`^@cauce/${name}$`, 'u'), replacement: join(root, 'packages', name, 'src/index.ts'),
  }));
  const protocol = JSON.parse(await readFile(join(root, 'packages/protocol/package.json'), 'utf8')) as { exports: Record<string, SourceExport> };
  for (const [subpath, entry] of Object.entries(protocol.exports)) {
    if (subpath === '.') continue;
    if (!entry.types?.startsWith('./src/')) throw new Error('Protocol export has no snapshot source');
    const name = `@cauce/protocol${subpath.slice(1)}`;
    aliases.push({ find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u'),
      replacement: resolve(root, 'packages/protocol', entry.types) });
  }
  aliases.push({ find: /^@cauce\/mcp-fleet-monitor\/gateway-http$/u, replacement: join(root, 'packages/mcp-fleet-monitor/src/gateway-http.ts') });
  for (const name of ['hermes-stdin-bridge.py', 'openclaw-stdin-bridge.mjs']) aliases.push({
    find: new RegExp(`^@cauce/adapter-sdk/bridge/${name.replaceAll('.', '\\.')}$`, 'u'), replacement: join(root, 'packages/adapter-sdk/bridge', name),
  });
  return aliases;
}

export async function retiredRoomReceipt(name: string, value: unknown): Promise<void> {
  await mkdir(retiredRoomEvidence, { recursive: true, mode: 0o700 });
  await writeFile(join(retiredRoomEvidence, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export interface RetiredRoomFixture {
  computer: ComputerHarness; page: V4Page; baseUrl: string; tenant: string; host: string; account: string; primaryRoom: string;
  diagnoseOperation(id: string, alias: string): Promise<void>;
  close(): Promise<void>;
}

export async function startRetiredRoomFixture(): Promise<RetiredRoomFixture> {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DATABASE_URL || process.env.CAUCE_TEST_DATABASE_URL
    || process.env.VITE_USE_MOCKS === 'true') throw new Error('Owned laboratory database and real console are required');
  if (await docker(['info', '--format', '{{.Name}}']) !== 'docker-lab') throw new Error('Laboratory daemon mismatch');
  await mkdir(retiredRoomEvidence, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp('/tmp/zz-canary-r8b-private-');
  const consoleRequire = createRequire(join(root, 'console/package.json'));
  let computer: ComputerHarness | undefined, trusted: TrustedBrowser | undefined;
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const failed: string[] = [];
    let inventory: { containers: string; volumes: string; images: string } | undefined;
    for (const [name, action] of [
      ['browser', async () => trusted?.close()], ['frontend', async () => vite?.close()],
      ['computer', async () => { if (computer) inventory = await computer.close(); }],
      ['private-files', async () => rm(directory, { recursive: true, force: true })],
    ] as const) {
      try { await action(); } catch { failed.push(name); }
    }
    const verified = failed.length === 0 && inventory !== undefined && Object.values(inventory).every(value => value === '');
    await retiredRoomReceipt('cleanup', { owner: retiredRoomOwner, prefix: retiredRoomPrefix, verified, inventory, failed });
    if (!verified) throw new Error('Retired room laboratory cleanup was not verified');
  };
  try {
    const tls = createSelfSignedCert({ directory });
    await chmod(tls.key_path, 0o600); await chmod(tls.cert_path, 0o600);
    const ports = await reserveNamedLoopbackPorts(['frontend', 'spare'] as const);
    await ports.releaseAll();
    const baseUrl = `https://localhost:${String(ports.ports.frontend)}`;
    computer = await startComputerHarness({ prefix: retiredRoomPrefix, consoleOrigins: [baseUrl], workRoot: '/datos',
      resourceOwner: retiredRoomOwner, runtimeBundle: { ...standardRecoveryBundle, sharedTui: false } });
    const aliases = await workspaceAliases();
    vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
      configFile: join(root, 'console/vite.config.ts'), root: join(root, 'console'), envDir: directory,
      cacheDir: join(directory, 'vite-cache'), resolve: { alias: aliases }, server: {
        host: '127.0.0.1', port: ports.ports.frontend, strictPort: true, watch: null, hmr: false,
        fs: { allow: [root, await realpath(join(root, 'node_modules'))] },
        https: { key: await readFile(tls.key_path), cert: await readFile(tls.cert_path) },
        proxy: { '/v3': { target: computer.gatewayUrl, changeOrigin: false, ws: true } },
      },
    });
    await vite.listen();
    trusted = await startTrustedBrowser(tls.cert_path, directory, [ports.ports.frontend, ports.ports.spare]);
    const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    const page = asV4Page(await context.newPage());
    const person = { ...syntheticPerson('r8b', retiredRoomRun), email: `zz-canary-r8b-${retiredRoomRun}@example.invalid`,
      company: { name: retiredRoomPrefix, slug: retiredRoomPrefix } };
    const registration = await openRegistration(page, baseUrl);
    await fillRegistration(registration, person);
    await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const login = await computer.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl },
      payload: { email: person.email, password: person.password } });
    if (login.statusCode !== 200) throw new Error('Nominal laboratory login failed');
    const header = login.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header : header ? [header] : []).map(value => value.split(';', 1)[0]).join('; ');
    const host = `${person.company.slug}-pc`;
    await enrollComputer(computer, { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token }, person.company.slug, host);
    const actor = (await computer.pool.query<{ tenant_id: string; alias: string }>(
      'SELECT tenant_id,alias FROM console_users WHERE email=$1', [person.email])).rows[0];
    if (!actor) throw new Error('Nominal laboratory actor is absent');
    const tenant = actor.tenant_id;
    await computer.pool.query(`UPDATE agents SET container_name=$3,runtime_user=$4,home_directory=$5,state_directory=$6
      WHERE tenant_id=$1 AND alias=$2`, [tenant, actor.alias, computer.container, COMPUTER_RUNTIME.user, COMPUTER_RUNTIME.home,
      join(computer.installRoot, person.company.slug, host, 'roots/state')]);
    const primaryRoom = (await computer.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id;
    if (!primaryRoom) throw new Error('Nominal laboratory room is absent');
    const account = `zz-canary-r8b-${retiredRoomRun}`;
    await computer.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$2,$3,'env_path','CAUCE_E2E_RECOVERY_PROFILE_PATH',true)`, [account, FIXTURE_PROVIDER_IDENTITY, tenant]);
    const sources = Object.fromEntries(await Promise.all(['console/src/features/config/agent-lifecycle-model.ts',
      'packages/store/src/repository/fleet-operation-desired.ts', 'packages/store/src/configuration.ts'].map(async file =>
      [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')] as const)));
    await retiredRoomReceipt('fixture', { owner: retiredRoomOwner, run: retiredRoomRun, prefix: retiredRoomPrefix, daemon: 'docker-lab',
      revision: (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(), source_sha256: sources,
      provider: 'standardRecoveryBundle synthetic provider', shared_tui: false, shared_tui_scope: 'sin TUI compartida',
      aliases: aliases.length, tenant, host, account, primary_room: primaryRoom,
      env_directory_outside_console: true, cache_directory_outside_console: true });
    const runningComputer = computer;
    const diagnoseOperation = async (id: string, alias: string) => {
      if (!/^[a-f0-9-]{36}$/u.test(id) || !alias.startsWith('zz-canary-r8b-')) throw new Error('Diagnostic scope changed');
      const operation = (await runningComputer.pool.query<{ status: string }>(
        "SELECT status FROM fleet_operations WHERE id=$1 AND target->>'tenant_id'=$2 AND target->>'alias'=$3 AND company_id=$4",
        [id, tenant, alias, person.company.slug])).rows[0];
      const placement = (await runningComputer.pool.query<{ alias: string; runtime_key: string; container_name: string }>(
        'SELECT alias,runtime_key,container_name FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows[0];
      const journal = await runningComputer.onComputer(['timeout', '20s', 'journalctl', '--user', '-u',
        `cauce-v3-host-executor-${person.company.slug}-${host}.service`, '--no-pager', '-o', 'cat', '-n', '1000']);
      const stderr = journal.stdout.split('\n').filter(line => line.includes(`operation_id=${id}`)
        && line.includes('fleet host command failed')).slice(-10)
        .map(line => redactExecutorStderr(line.split(' stderr=').at(-1) ?? 'executor failure'));
      await retiredRoomReceipt(`diagnostic-${id}`, { id, status: operation?.status, placement,
        placement_matches_template: placement?.container_name === `${retiredRoomPrefix}-${placement?.runtime_key ?? ''}`,
        journal_exit: journal.code, stderr });
    };
    return { computer, page, baseUrl, tenant, host, account, primaryRoom, diagnoseOperation, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Laboratory setup and cleanup failed'); }
    throw error;
  }
}
