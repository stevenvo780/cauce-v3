import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Agent } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { CauceRepository, FleetOperationsRepository } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { SignedFleetAuthorityClient } from '../../services/gateway/src/fleet/authority/signed-client.js';
import { FIXTURE_PROVIDER_IDENTITY, enrollComputer, startComputerHarness, type ComputerHarness, type ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { terminalCapabilityAnnouncement, type TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';
import { apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration,
  PATTERN_DEFECT_RULE, syntheticPerson, type V4Page, type V4Person } from './v4-console-real-browser.helpers.js';
import { createPtyFleetPki, startPtyFleetRelay, type PtyFleetRelayIdentity } from './v4-pty-flota-dinamica.infra.js';

export const PTY_FLEET_OWNER = 'h12-pty-flota-dinamica-1025';
export const ptyFleetRun = randomUUID().replaceAll('-', '').slice(0, 8);
export const ptyFleetPrefix = 'zz-canary-' + PTY_FLEET_OWNER + '-' + ptyFleetRun;
export const ptyFleetReceipts = join(process.cwd(), '.delegados/v4/recibos', PTY_FLEET_OWNER, ptyFleetRun);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
export interface PtyFleetFixture {
  computer: ComputerHarness; page: V4Page; errors: BrowserErrorLog; baseUrl: string; directory: string; caFile: string;
  owner: V4Person; tenantId: string; hostId: string; room: string; accountId: string; registryFile: string; runtimeState: string;
  retryDiagnostic?: { operation_id: string; since: string | null };
  registry: AgentRegistry; pauseRelay(): Promise<PtyFleetRelayIdentity>; resumeRelay(): Promise<PtyFleetRelayIdentity>; close(): Promise<void>;
}

export async function ptyFleetReceipt(name: string, value: unknown): Promise<void> {
  await mkdir(ptyFleetReceipts, { recursive: true, mode: 0o700 });
  await writeFile(join(ptyFleetReceipts, name + '.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export async function capturePtyFleet(page: V4Page, name: string): Promise<void> {
  const previous = page.viewportSize();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: join(ptyFleetReceipts, name + '-' + String(viewport.width) + '.png'), fullPage: true });
    }
  } finally { if (previous) await page.setViewportSize(previous); }
}

export async function startPtyFleetFixture(options: { runtimeBundle?: ComputerRuntimeBundle } = {}): Promise<PtyFleetFixture> {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock'
      || !process.env.HOME?.startsWith('/tmp/cauce-e2e-home-' + PTY_FLEET_OWNER + '-')) {
    throw new Error('dynamic fleet PTY requires the canonical isolated lab launcher');
  }
  const directory = await mkdtemp(join(tmpdir(), 'cauce-h12-pty-'));
  const ports = await reserveNamedLoopbackPorts(['frontend', 'gateway', 'browser', 'agent', 'health'] as const);
  const baseUrl = 'https://localhost:' + String(ports.ports.frontend);
  const ticketKey = randomBytes(32), masterFile = join(directory, 'terminal-master.key');
  const master = ticketKey.toString('hex');
  await writeFile(masterFile, master, { mode: 0o600 });
  const owner = { ...syntheticPerson('pty-flota', ptyFleetRun), email: ptyFleetPrefix + '@example.test',
    company: { name: 'zz-canary-pty-' + ptyFleetRun, slug: 'zz-pty-' + ptyFleetRun } };
  const registry = new AgentRegistry();
  let computer: ComputerHarness | undefined, trusted: TrustedBrowser | undefined;
  let gateway: Awaited<ReturnType<typeof buildGateway>> | undefined, transport: Agent | undefined;
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  let relay: Awaited<ReturnType<typeof startPtyFleetRelay>> | undefined, page: V4Page | undefined;
  const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
  const close = async () => {
    const failures: unknown[] = [];
    for (const action of [async () => trusted?.close(), async () => vite?.close(), async () => relay?.close(),
      async () => gateway?.close(), async () => transport?.destroy(), async () => {
        if (computer) {
          const inventory = await computer.close();
          await ptyFleetReceipt('cleanup', inventory);
          expect(inventory).toEqual({ containers: '', volumes: '', images: '' });
        }
      }, async () => ports.releaseAll(), async () => rm(directory, { recursive: true, force: true })]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'dynamic fleet PTY cleanup failed');
  };
  try {
    computer = await startComputerHarness({ prefix: ptyFleetPrefix, consoleOrigins: [baseUrl], workRoot: '/datos',
      resourceOwner: PTY_FLEET_OWNER, runtimeBundle: options.runtimeBundle ?? cancelDeployRuntime,
      terminal: { masterFile, masterSha256: createHash('sha256').update(master).digest('hex'),
        relayHost: '127.0.0.1', relayPort: ports.ports.agent, serverName: 'localhost' } });
    const active = computer, authority = join(dirname(active.installRoot), 'authority');
    const registryFile = join(authority, 'pty/pty_agent_identities.json');
    const pki = await createPtyFleetPki(directory, authority);
    const relayToken = randomBytes(32).toString('base64url'), tokenFile = join(directory, 'relay-token');
    const identities = join(directory, 'relay-identities.json'), grantsFile = join(directory, 'grants.json');
    await writeFile(tokenFile, relayToken, { mode: 0o600 });
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }), { mode: 0o600 });
    await writeFile(join(directory, 'close-spool.json'), '', { mode: 0o600 });
    await mkdir(join(directory, 'recordings'), { mode: 0o700 });
    await writeFile(identities, JSON.stringify({ version: 1, identities: [{ certificate_sha256: pki.relayId,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), principal: { tenant_id: owner.company.slug,
        alias: 'relay' + ptyFleetRun, session_id: randomUUID(), channel: 'agent', roles: ['adapter'], permissions: ['read'] } }] }), { mode: 0o600 });
    const auth = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(active.pool), signingKey: Buffer.alloc(32, 61),
      fallback: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(identities)) });
    const config: TerminalConfig = { wsPath: '/v3/console/terminal/ws', ticketKey, relayToken,
      relayInstanceIds: new Set([pki.relayId]), grantsFile, ticketTtlSeconds: 60, sessionTtlSeconds: 900,
      claimLeaseSeconds: 150, maxSessionsPerOperator: 2, operatorHeader: 'x-cauce-operator', operators: new Set([owner.email]),
      writableTuiEnabled: true, controlHoldSeconds: 300 };
    const uid = process.geteuid?.() ?? 0;
    gateway = await buildGateway({ pool: active.pool, repository: new CauceRepository(active.pool), logger: false,
      consoleOrigins: [baseUrl], authProvider: auth, hostSetup: active.packager,
      fleetOperationsRepository: new FleetOperationsRepository(active.pool),
      signedFleetAuthorityClient: new SignedFleetAuthorityClient(join(authority, 'signed.sock'), { ownerUid: uid, peerUid: uid }),
      https: { key: await readFile(pki.server.key), cert: await readFile(pki.server.cert), ca: await readFile(pki.ca),
        requestCert: true, rejectUnauthorized: true }, terminalCapability: terminalCapabilityAnnouncement(config) });
    await gateway.register(registerTerminalControlPlane, { pool: active.pool, authProvider: auth, config, registry });
    await ports.release('gateway');
    const gatewayUrl = await gateway.listen({ host: '127.0.0.1', port: ports.ports.gateway });
    transport = new Agent({ cert: await readFile(pki.console.cert), key: await readFile(pki.console.key),
      ca: await readFile(pki.ca), rejectUnauthorized: true });
    vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
      configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory,
      cacheDir: join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: ports.ports.frontend,
        strictPort: true, watch: null, hmr: false, https: { key: await readFile(pki.server.key), cert: await readFile(pki.server.cert) },
        proxy: { ['/v3/console/terminal/relays/' + pki.relayId + '/ws']: {
          target: 'https://127.0.0.1:' + String(ports.ports.browser), agent: transport, secure: true, changeOrigin: false, ws: true },
        '/v3': { target: gatewayUrl, agent: transport, secure: true, changeOrigin: false, ws: false } } } });
    await ports.release('frontend'); await vite.listen();
    for (const name of ['browser', 'agent', 'health'] as const) await ports.release(name);
    relay = await startPtyFleetRelay({ directory, gatewayUrl, registry: registryFile, pki, ports: ports.ports, tokenFile });
    const relayDeadline = Date.now() + 30_000;
    while (!registry.available() && Date.now() < relayDeadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 100); });
    }
    if (!registry.available()) throw new Error('the owned PTY relay did not publish its initial presence before the deadline');
    trusted = await startTrustedBrowser(pki.ca, directory, [ports.ports.frontend, ports.ports.gateway]);
    await ptyFleetReceipt('infrastructure', { prefix: ptyFleetPrefix, computer: active.container,
      browser: { name: trusted.container, id: trusted.containerId, image: trusted.runtime.image, image_id: trusted.runtime.imageId,
        image_owned: trusted.runtime.owned }, relay_id: pki.relayId,
      issuer_ca_sha256: createHash('sha256').update(await readFile(pki.ca)).digest('hex') });
    const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    page = asV4Page(await context.newPage()); errors.watch(page, 'h12-owner');
    const form = await openRegistration(page, baseUrl);
    await fillRegistration(form, owner);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const login = await active.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl },
      payload: { email: owner.email, password: owner.password } });
    expect(login.statusCode).toBe(200);
    const header = login.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
    const hostId = owner.company.slug + '-pc';
    await enrollComputer(active, { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token }, owner.company.slug, hostId);
    const approved = await active.onComputer(['python3', '-I', '-B', '-c',
      'import json,sys;p=json.load(open(sys.argv[1]));print(json.dumps({"terminal":p.get("terminal"),"state":p["roots"]["state"],"shared_tui":p["bundles"]["codex"].get("shared_tui",True)}))',
      join(active.installRoot, owner.company.slug, hostId, 'executor-policy.json')]);
    expect(approved.code).toBe(0);
    const applied = JSON.parse(approved.stdout) as { terminal: unknown; state: string; shared_tui: boolean };
    expect(applied.terminal).toEqual({ required: true });
    expect(applied.shared_tui).toBe(options.runtimeBundle?.sharedTui ?? false);
    if (!applied.state.startsWith('/')) throw new Error('the enrolled executor has no canonical runtime state');
    await ptyFleetReceipt('approved-terminal-policy', { terminal: { required: true }, shared_tui: applied.shared_tui, issuer_ca_is_relay_ca: true });
    const tenantId = (await active.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0]?.tenant_id;
    if (!tenantId) throw new Error('the dynamic PTY owner has no workspace');
    const room = (await active.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenantId])).rows[0]?.id;
    if (!room) throw new Error('the dynamic PTY workspace has no room');
    const accountId = 'zz-pty-' + ptyFleetRun;
    await active.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$2,$3,'env_path','CAUCE_H12_FIXTURE_PROFILE_PATH',true)`, [accountId, FIXTURE_PROVIDER_IDENTITY, tenantId]);
    expect((await apiGet(page, '/v3/console/fleet/capability')).status).toBe(200);
    const ownedRelay = relay;
    return { computer: active, page, errors, baseUrl, directory, caFile: pki.ca, owner, tenantId, hostId, room, accountId, registryFile,
      runtimeState: applied.state, registry,
      pauseRelay: () => ownedRelay.pause(), resumeRelay: () => ownedRelay.resume(), close };
  } catch (error) {
    try { await ptyFleetReceipt('bootstrap-failure', { error: error instanceof Error ? error.message : String(error),
      page: page ? await bodySnippet(page) : null, browserErrors: errors.unexpected, browserTrace: errors.trace, relay: relay?.log() }); }
    finally { await close(); }
    throw error;
  }
}
