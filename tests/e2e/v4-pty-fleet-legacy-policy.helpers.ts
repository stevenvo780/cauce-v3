import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CauceRepository } from '@cauce/store';
import { expect } from 'vitest';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { SignedFleetAuthorityClient } from '../../services/gateway/src/fleet/authority/signed-client.js';
import { FIXTURE_PROVIDER_IDENTITY, enrollComputer, startComputerHarness, type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { terminalCapabilityAnnouncement, type TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration,
  PATTERN_DEFECT_RULE, syntheticPerson, type V4Page } from './v4-console-real-browser.helpers.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';

export const LEGACY_PTY_OWNER = 'h12b-politica-vieja-y-config-1025';
export const legacyPtyRun = randomUUID().replaceAll('-', '').slice(0, 8);
export const legacyPtyPrefix = 'zz-canary-h12b-' + legacyPtyRun;
export const legacyPtyAlias = 'oldpty' + legacyPtyRun;
export const legacyPtyKey = 'oldpty-' + legacyPtyRun;
export const legacyPtyReceipts = join(process.cwd(), '.delegados/v4/recibos', LEGACY_PTY_OWNER, legacyPtyRun);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
const legacyRuntime = { ...cancelDeployRuntime, providerCli: cancelDeployRuntime.providerCli + `
if not nonce:
 import os,pathlib
 directory=pathlib.Path(os.environ['CODEX_HOME'])/'sessions'
 directory.mkdir(parents=True,exist_ok=True,mode=0o700)
 transcript=directory/('rollout-headless-'+native+'.jsonl')
 entries=[]
 if not transcript.exists():entries.append({'type':'session_meta','payload':{'id':native,'source':'exec','cwd':os.getcwd()}})
 turn=str(uuid.uuid4())
 entries.extend([
  {'type':'event_msg','payload':{'type':'task_started','turn_id':turn}},
  {'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':prompt}],
   'internal_chat_message_metadata_passthrough':{'turn_id':turn}}},
  {'type':'event_msg','payload':{'type':'task_complete','turn_id':turn,'last_agent_message':answer}}])
 with transcript.open('a') as stream:
  os.chmod(transcript,0o600)
  for entry in entries:stream.write(json.dumps(entry)+'\\n')
  stream.flush();os.fsync(stream.fileno())
` };

export interface LegacyPtyFixture {
  computer: ComputerHarness; page: V4Page; errors: BrowserErrorLog; baseUrl: string; tenantId: string;
  hostId: string; room: string; accountId: string; runtimeState: string; registryFile: string;
  close(): Promise<void>;
}

export async function legacyPtyReceipt(name: string, value: unknown): Promise<void> {
  await mkdir(legacyPtyReceipts, { recursive: true, mode: 0o700 });
  await writeFile(join(legacyPtyReceipts, name + '.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export async function legacyPtyCapture(page: V4Page, name: string): Promise<void> {
  const previous = page.viewportSize();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: join(legacyPtyReceipts, name + '-' + String(viewport.width) + '.png'), fullPage: true });
    }
  } finally { if (previous) await page.setViewportSize(previous); }
}

export async function startLegacyPtyFixture(): Promise<LegacyPtyFixture> {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || !process.env.HOME?.startsWith('/tmp/cauce-e2e-home-' + LEGACY_PTY_OWNER + '-')) {
    throw new Error('the legacy PTY policy requires the canonical isolated lab launcher');
  }
  const directory = await mkdtemp(join(tmpdir(), 'cauce-h12b-'));
  const pki = createSelfSignedCert({ directory });
  const ports = await reserveNamedLoopbackPorts(['frontend'] as const);
  const baseUrl = 'https://localhost:' + String(ports.ports.frontend);
  const owner = { ...syntheticPerson('legacy-pty', legacyPtyRun), email: legacyPtyPrefix + '@example.test',
    company: { name: 'zz-canary-legacy-pty-' + legacyPtyRun, slug: 'zz-h12b-' + legacyPtyRun } };
  let computer: ComputerHarness | undefined, trusted: TrustedBrowser | undefined, page: V4Page | undefined;
  let gateway: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
  const close = async () => {
    const failures: unknown[] = [];
    for (const action of [async () => trusted?.close(), async () => vite?.close(), async () => gateway?.close(), async () => {
      if (computer) {
        const inventory = await computer.close();
        await legacyPtyReceipt('cleanup', inventory);
        expect(inventory).toEqual({ containers: '', volumes: '', images: '' });
      }
    }, async () => ports.releaseAll(), async () => rm(directory, { recursive: true, force: true })]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'legacy PTY policy cleanup failed');
  };
  try {
    computer = await startComputerHarness({ prefix: legacyPtyPrefix, consoleOrigins: [baseUrl], workRoot: '/datos',
      resourceOwner: LEGACY_PTY_OWNER, runtimeBundle: legacyRuntime });
    const active = computer, authority = join(dirname(active.installRoot), 'authority');
    const issuerBytes = await readFile(join(authority, 'issuer-policy.json'));
    const issuer = JSON.parse(issuerBytes.toString()) as Record<string, unknown>;
    expect(Object.hasOwn(issuer, 'terminal')).toBe(false);
    const grantsFile = join(directory, 'terminal-grants.json');
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }), { mode: 0o600 });
    const config: TerminalConfig = { wsPath: '/v3/console/terminal/ws', ticketKey: randomBytes(32), relayToken: randomBytes(32).toString('base64url'),
      relayInstanceIds: new Set<string>(), grantsFile, ticketTtlSeconds: 60, sessionTtlSeconds: 900, claimLeaseSeconds: 150,
      maxSessionsPerOperator: 2, operatorHeader: 'x-cauce-operator', operators: new Set([owner.email]), writableTuiEnabled: true };
    const uid = process.geteuid?.() ?? 0;
    await active.app.close();
    const authProvider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(active.pool), signingKey: Buffer.alloc(32, 61) });
    gateway = await buildGateway({ pool: active.pool, repository: new CauceRepository(active.pool), logger: false,
      consoleOrigins: [baseUrl], hostSetup: active.packager,
      signedFleetAuthorityClient: new SignedFleetAuthorityClient(join(authority, 'signed.sock'), { ownerUid: uid, peerUid: uid }),
      authProvider,
      terminalCapability: terminalCapabilityAnnouncement(config) });
    await gateway.register(registerTerminalControlPlane, { pool: active.pool, authProvider, config, registry: new AgentRegistry() });
    await gateway.listen({ host: '127.0.0.1', port: Number(new URL(active.gatewayUrl).port) });
    vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
      configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory, cacheDir: join(directory, 'vite-cache'),
      server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true, watch: null, hmr: false,
        https: { key: pki.key, cert: pki.cert }, proxy: { '/v3': { target: active.gatewayUrl, changeOrigin: false, ws: false } } } });
    await ports.release('frontend'); await vite.listen();
    trusted = await startTrustedBrowser(pki.cert_path, directory, [ports.ports.frontend, Number(new URL(active.gatewayUrl).port)]);
    await legacyPtyReceipt('infrastructure', { prefix: legacyPtyPrefix, computer: active.container,
      browser: { name: trusted.container, id: trusted.containerId, image_id: trusted.runtime.imageId },
      issuer_terminal_present: false, issuer_policy_sha256: createHash('sha256').update(issuerBytes).digest('hex'),
      runtime: { shared_tui: legacyRuntime.sharedTui, provider_cli_sha256: createHash('sha256').update(legacyRuntime.providerCli).digest('hex') } });
    const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    page = asV4Page(await context.newPage()); errors.watch(page, 'legacy-pty-owner');
    const form = await openRegistration(page, baseUrl);
    await fillRegistration(form, owner);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const login = await gateway.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl }, payload: { email: owner.email, password: owner.password } });
    expect(login.statusCode).toBe(200);
    const header = login.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
    const hostId = owner.company.slug + '-pc';
    await enrollComputer({ ...active, app: gateway }, { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token }, owner.company.slug, hostId);
    const policy = await active.onComputer(['python3', '-I', '-B', '-c',
      'import hashlib,json,sys;raw=open(sys.argv[1],"rb").read();p=json.loads(raw);print(json.dumps({"terminal_present":"terminal" in p,"state":p["roots"]["state"],"shared_tui":p["bundles"]["codex"]["shared_tui"],"sha256":hashlib.sha256(raw).hexdigest()}))',
      join(active.installRoot, owner.company.slug, hostId, 'executor-policy.json')]);
    expect(policy.code).toBe(0);
    const approved = JSON.parse(policy.stdout) as { terminal_present: boolean; state: string; shared_tui: boolean; sha256: string };
    expect(approved.terminal_present).toBe(false); expect(approved.shared_tui).toBe(false);
    if (!approved.state.startsWith('/')) throw new Error('the legacy policy has no canonical runtime state');
    await legacyPtyReceipt('legacy-policy', approved);
    const tenantId = (await active.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0]?.tenant_id;
    if (!tenantId) throw new Error('the legacy owner has no workspace');
    const room = (await active.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenantId])).rows[0]?.id;
    if (!room) throw new Error('the legacy workspace has no room');
    const accountId = 'zz-h12b-' + legacyPtyRun;
    await active.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$2,$3,'env_path','CAUCE_H12B_FIXTURE_PROFILE_PATH',true)`, [accountId, FIXTURE_PROVIDER_IDENTITY, tenantId]);
    expect((await apiGet(page, '/v3/console/fleet/capability')).status).toBe(200);
    return { computer: active, page, errors, baseUrl, tenantId, hostId, room, accountId, runtimeState: approved.state,
      registryFile: join(authority, 'pty/pty_agent_identities.json'), close };
  } catch (error) {
    try { await legacyPtyReceipt('bootstrap-failure', { error_type: error instanceof Error ? error.name : typeof error,
      page: page ? await bodySnippet(page) : null, browser_errors: errors.unexpected, browser_trace: errors.trace }); }
    finally { await close(); }
    throw error;
  }
}
