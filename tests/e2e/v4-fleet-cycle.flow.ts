import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_PROVIDER_IDENTITY, docker, enrollComputer, startComputerHarness, type ComputerHarness, type ComputerRuntimeBundle,
} from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { SharedCycleObserver } from './v4-fleet-cycle-shared-observer.js';
import {
  apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration, syntheticPerson,
  type V4Locator, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

/**
 * The physical fleet cycle driven from the web: Chromium creates an agent on an enrolled computer, updates its
 * configuration and assignments, stops, retires and purges it, and Docker is read before and after every step.
 *
 * CAUCE_FLEET_CYCLE_TARGET selects where the computer lives:
 * - `local` (default): a clean computer is built here (systemd container, enrolled executor, signed authority) and the
 *   company is registered through the console. The computer and its agent resources carry the task's canary prefix.
 * - `deployed`: the same walkthrough against a deployed gateway. The console served here proxies `/v3` to
 *   CAUCE_FLEET_CYCLE_GATEWAY_URL (Origin rewritten to CAUCE_FLEET_CYCLE_GATEWAY_ORIGIN, trusting CAUCE_FLEET_CYCLE_CA_FILE
 *   when set), signs in with CAUCE_FLEET_CYCLE_EMAIL/CAUCE_FLEET_CYCLE_PASSWORD and uses an already enrolled computer:
 *   CAUCE_FLEET_CYCLE_TENANT, CAUCE_FLEET_CYCLE_HOST_ID, CAUCE_FLEET_CYCLE_ACCOUNT_ID and two rooms in
 *   CAUCE_FLEET_CYCLE_ROOMS ("primary,second"). Docker is read through the caller's DOCKER_HOST (for example ssh://).
 */
export function defineFleetCycle(options: { runtimeBundle: ComputerRuntimeBundle; owner?: string; sharedTui?: boolean }): void {
const execute = promisify(execFile);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
const run = randomUUID().replaceAll('-', '').slice(0, 8);
const OWNER = options.owner ?? 'x-admision-efecto-1025';
const PREFIX = `zz-canary-${options.sharedTui ? 'a21b-tui' : OWNER}-${run}`;
const EVIDENCE_DIRECTORY = join(process.cwd(), '.delegados/v4/recibos', OWNER, 'cycle', run);
const TARGET = process.env.CAUCE_FLEET_CYCLE_TARGET ?? 'local';
if (options.sharedTui && TARGET !== 'local') throw new Error('shared cycle requires its owned local harness');
const ALIAS = `${PREFIX}-cycle`;
const RUNTIME_KEY = `ciclo-${run}`;
const MODEL = 'gpt-5.5';
const EFFORT = 'high';
const CONTEXT_MARKER = `CICLO-CONTEXTO-${run.toUpperCase()}`;
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'awaiting_auth'];

interface CycleTarget {
  label: string; baseUrl: string; tenantId: string; hostId: string; accountId: string; rooms: [string, string];
  /** Local runs also read the durable probes; a remote run relies on the operation evidence served by the API. */
  probes?: (operationId: string) => Promise<{ phase: string; action: string; state: string; reply: string | null; nonce: string; documents: number }[]>;
}
interface Operation {
  id: string; version: number; kind: string; status: string; created_at: string; error: unknown;
  steps: { name: string; status: string; evidence?: Record<string, unknown> }[];
}
type BackupPhase = 'operations' | 'context' | 'purging' | 'purged' | 'purged-context';
interface BackupRequestReceipt {
  phase: BackupPhase; method: string; path: string; status: number | null; response_phase?: BackupPhase;
}
interface ObservedBrowserRequest { url(): string; method(): string }
interface Observation {
  container: boolean; running: boolean; labels: Record<string, string>; volumes: string[];
  processes: { pid: number; start: number; CAUCE_ALIAS: string | null; CAUCE_ROOM: string | null; CAUCE_MODEL_ID: string | null;
    CAUCE_REASONING_EFFORT: string | null; CAUCE_BOOTSTRAP: string | null }[];
  view: { modelId?: string; reasoningEffort?: string; room?: string; memberships?: { room: string; role: string }[] } | null;
  credentials: boolean;
  /** Every AGENTS.md under the runtime home and whether it carries the context marker. */
  documents: Record<string, boolean>;
}

async function capture(name: string): Promise<void> {
  const current = view();
  const original = current.viewportSize();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await current.setViewportSize(viewport);
      await current.screenshot({ path: join(EVIDENCE_DIRECTORY, `${name}-${String(viewport.width)}x${String(viewport.height)}.png`) });
    }
  } finally { if (original) await current.setViewportSize(original); }
}

/**
 * Runs inside the agent container as the runtime user (container root lacks CAP_SYS_PTRACE and cannot read another
 * user's /proc/<pid>/environ): the agent processes of this runtime and the fleet view they were given.
 */
const PROBE = `import json,os,pathlib,sys
key=sys.argv[1];fields=('CAUCE_ALIAS','CAUCE_ROOM','CAUCE_MODEL_ID','CAUCE_REASONING_EFFORT','CAUCE_BOOTSTRAP')
processes=[]
for pid in filter(str.isdigit,os.listdir('/proc')):
  try:
    raw=open('/proc/'+pid+'/environ','rb').read().split(b'\\0')
    env=dict(item.decode(errors='replace').split('=',1) for item in raw if b'=' in item)
    if env.get('CAUCE_RUNTIME_KEY')!=key: continue
    start=int(open('/proc/'+pid+'/stat').read().rsplit(')',1)[1].split()[19])
    processes.append({'pid':int(pid),'start':start,**{name:env.get(name) for name in fields}})
  except OSError: pass
base=pathlib.Path('/run/cauce-credentials')/key;view=None
try:
  inventory=base/'normal'/'inventory';generation=json.loads((inventory/'desired-fleet.json').read_text())['generation']
  row=json.loads((inventory/'generations'/generation/'flota.json').read_text()).get('fleet',{}).get(key)
  view={name:row.get(name) for name in ('modelId','reasoningEffort','room','memberships')} if row else None
except (OSError,ValueError,KeyError): pass
documents={}
home=pathlib.Path.home()
for directory,children,files in os.walk(home):
  if len(pathlib.Path(directory).relative_to(home).parts)>=4: children[:]=[]
  for name in files:
    if name=='AGENTS.md':
      text=(pathlib.Path(directory)/name).read_text(errors='replace')
      documents[str(pathlib.Path(directory)/name)]=sys.argv[2] in text
print(json.dumps({'processes':processes,'view':view,'credentials':base.exists(),'documents':documents}))
`;

let harness: ComputerHarness | undefined;
let trusted: TrustedBrowser | undefined;
let vite: { close(): Promise<void>; httpServer: import('node:http').Server | null; listen(): Promise<void> } | undefined;
let directory = '';
let page: V4Page | undefined;
let target: CycleTarget | undefined;
let containerName = '';
let runtimeUser = '';
let operationSequence = 0;
let shared: SharedCycleObserver | undefined;
let backupPhase: BackupPhase = 'operations';
let verifiedBackupPanels: number | undefined;
const backupRequests: BackupRequestReceipt[] = [];
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES]);
const evidence: Record<string, unknown> = { run, target: TARGET, evidence_directory: EVIDENCE_DIRECTORY };

function view() { if (!page) throw new Error('cycle page absent'); return page; }
function cycle() { if (!target) throw new Error('cycle target absent'); return target; }
function watchBackupRequests(current: V4Page, tenantId: string): void {
  const path = `/v3/console/spaces/${encodeURIComponent(tenantId)}/${encodeURIComponent(ALIAS)}/backups`;
  const observed = new Map<object, BackupRequestReceipt>();
  evidence.backup_requests = { path, requests: backupRequests };
  current.on('request', (value: unknown) => {
    const request = value as ObservedBrowserRequest;
    if (new URL(request.url()).pathname !== path) return;
    const receipt: BackupRequestReceipt = { phase: backupPhase, method: request.method(), path, status: null };
    observed.set(request, receipt);
    backupRequests.push(receipt);
  });
  current.on('response', (response) => {
    const receipt = observed.get(response.request());
    if (receipt) { receipt.status = response.status(); receipt.response_phase = backupPhase; }
  });
}
function assertBackupContract(backupPanels: number): void {
  const duringPurge = backupRequests.filter(request => request.phase === 'purging');
  const afterPurge = backupRequests.filter(request => request.phase === 'purged' || request.phase === 'purged-context');
  evidence.backup_contract = { context_reads: backupRequests.filter(request => request.phase === 'context').length, during_purge_requests: duringPurge.length,
    after_purge_requests: afterPurge.length, purged_context_missing: true, purged_context_backup_panels: backupPanels };
  expect(duringPurge, JSON.stringify(duringPurge)).toEqual([]);
  expect(afterPurge, JSON.stringify(afterPurge)).toEqual([]);
  expect(backupRequests.every(request => request.method === 'GET' && request.status === 200), JSON.stringify(backupRequests)).toBe(true);
  errors.assertClean();
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for CAUCE_FLEET_CYCLE_TARGET=${TARGET}`);
  return value;
}

/** Everything Docker holds for this run: the whole computer locally, the agent container and its volumes remotely. */
async function inventory(prefix = TARGET === 'local' ? PREFIX : containerName): Promise<{ containers: string[]; volumes: string[]; totals: { containers: number; volumes: number } }> {
  const lines = (text: string) => text.split('\n').filter(Boolean).sort();
  return {
    containers: lines(await docker(['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^/${prefix}`])),
    volumes: lines(await docker(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${prefix}`])),
    totals: { containers: lines(await docker(['ps', '-aq'])).length, volumes: lines(await docker(['volume', 'ls', '-q'])).length },
  };
}

async function observe(): Promise<Observation> {
  const exists = await docker(['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^/${containerName}$`]);
  const volumes = (await docker(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${containerName}-`])).split('\n').filter(Boolean).sort();
  if (!exists) return { container: false, running: false, labels: {}, volumes, processes: [], view: null, credentials: false, documents: {} };
  const labels = JSON.parse(await docker(['inspect', '--format', '{{json .Config.Labels}}', containerName])) as Record<string, string>;
  const running = await docker(['inspect', '--format', '{{.State.Running}}', containerName]) === 'true';
  const probe = running ? JSON.parse(await docker(['exec', '--user', runtimeUser, containerName, 'python3', '-c', PROBE, RUNTIME_KEY, CONTEXT_MARKER])) as
    Pick<Observation, 'processes' | 'view' | 'credentials' | 'documents'> : { processes: [], view: null, credentials: false, documents: {} };
  return { container: true, running, labels, volumes, ...probe };
}

async function certificateAuthority(): Promise<{ ca: string; key: string; cert: string }> {
  const ca = join(directory, 'ca.crt'), caKey = join(directory, 'ca.key'), key = join(directory, 'vite.key'), cert = join(directory, 'vite.crt');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-keyout', caKey, '-out', ca,
    '-subj', '/CN=Cauce fleet cycle E2E CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  const config = join(directory, 'vite.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:FALSE\n'
    + 'keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', join(directory, 'vite.csr'), '-config', config]);
  await execute('openssl', ['x509', '-req', '-in', join(directory, 'vite.csr'), '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert,
    '-days', '2', '-sha256', '-extfile', config, '-extensions', 'ext']);
  await chmod(caKey, 0o600); await chmod(key, 0o600);
  return { ca, key, cert };
}

async function startConsole(frontendPort: number, proxy: Record<string, unknown>, pki: { key: string; cert: string }): Promise<string> {
  const server = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
    configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory, cacheDir: join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: frontendPort, strictPort: true, watch: null, hmr: false, https: { key: await readFile(pki.key), cert: await readFile(pki.cert) },
      proxy: { '/v3': proxy } },
  });
  vite = server;
  await server.listen();
  return `https://localhost:${String(frontendPort)}`;
}

async function prepareLocal(frontendPort: number, pki: { key: string; cert: string }): Promise<CycleTarget> {
  const origin = `https://localhost:${String(frontendPort)}`;
  const previousBackupDirectory = process.env.CAUCE_SPACE_BACKUP_DIRECTORY;
  process.env.CAUCE_SPACE_BACKUP_DIRECTORY = join(directory, 'space-backups');
  let computer: ComputerHarness;
  try {
    computer = await startComputerHarness({ prefix: PREFIX, consoleOrigins: [origin], workRoot: '/datos', resourceOwner: OWNER,
      runtimeBundle: options.runtimeBundle });
  } finally {
    if (previousBackupDirectory === undefined) delete process.env.CAUCE_SPACE_BACKUP_DIRECTORY;
    else process.env.CAUCE_SPACE_BACKUP_DIRECTORY = previousBackupDirectory;
  }
  harness = computer;
  const baseUrl = await startConsole(frontendPort, { target: computer.gatewayUrl, changeOrigin: false, ws: true }, pki);
  trusted = await startTrustedBrowser(join(directory, 'ca.crt'), directory, [frontendPort, Number(new URL(computer.gatewayUrl).port)]);
  const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
  page = asV4Page(await context.newPage());
  errors.watch(page, 'cycle-owner');
  const owner: V4Person = { ...syntheticPerson('ciclo', run), email: `${PREFIX}@example.test`,
    company: { name: `zz-canary-empresa-ciclo-${run}`, slug: `zz-ciclo-${run}` } };
  const form = await openRegistration(page, baseUrl);
  await fillRegistration(form, owner);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const login = await computer.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin },
    payload: { email: owner.email, password: owner.password } });
  if (login.statusCode !== 200) throw new Error(`owner API login failed (${String(login.statusCode)})`);
  const header = login.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
  const session = { cookie, origin, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token };
  const hostId = `${owner.company.slug}-pc`;
  try { await enrollComputer(computer, session, owner.company.slug, hostId); }
  catch (error) {
    try {
      const root = join(computer.installRoot, owner.company.slug, hostId);
      const discovery = await computer.onComputer(['python3', '-B', '-c',
        'import pathlib,json,sys; print(json.dumps(sorted(str(item.parent) for item in pathlib.Path(sys.argv[1]).glob("release/*/.verified"))))', root]);
      const releases = JSON.parse(discovery.stdout) as string[];
      if (discovery.code !== 0 || releases.length !== 1) throw new Error('verified release was not unique');
      const report = await computer.onComputer(['python3', '-B', join(releases[0] ?? '', 'ops/cli/fleet-executor.py'),
        '--policy', join(root, 'executor-policy.json'), '--capabilities']);
      let capabilities: { available?: boolean; reason?: string } = {};
      try { capabilities = JSON.parse(report.stdout) as typeof capabilities; } catch { /* The exit code and stderr identify malformed output. */ }
      const stderr = report.stderr.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://redacted')
        .replace(/Bearer\s+\S+/gi, 'Bearer redacted').replace(/\bsk-[A-Za-z0-9_-]+/g, 'redacted').slice(-2_000);
      evidence.setup_diagnostic = { code: report.code, available: capabilities.available, reason: capabilities.reason, stderr };
    } catch { evidence.setup_diagnostic = { unavailable: true }; }
    console.info('FLEET_CYCLE_SETUP_DIAGNOSTIC', JSON.stringify(evidence.setup_diagnostic));
    throw error;
  }
  const tenantId = (await computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0]?.tenant_id;
  if (!tenantId) throw new Error('registered company has no tenant');
  const primary = (await computer.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenantId])).rows[0]?.id;
  if (!primary) throw new Error('registered company has no room');
  // Fixture rows the walkthrough assigns: a second room and the account whose identity the pinned provider CLI reports.
  const second = `${primary}-ciclo`;
  await computer.pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [second, tenantId]);
  const accountId = `zz-ciclo-${run}`;
  await computer.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES($1,'codex',$2,$3,'env_path','CAUCE_FLEET_CYCLE_PROFILE_PATH',true)`, [accountId, FIXTURE_PROVIDER_IDENTITY, tenantId]);
  return { label: 'local', baseUrl, tenantId, hostId, accountId, rooms: [primary, second],
    probes: async (operationId) => (await computer.pool.query<{ phase: string; action: string; state: string; reply: string | null; nonce: string; documents: number }>(
      `SELECT DISTINCT ON (metadata->'bootstrap_probe'->'probe'->>'probe_id')
        metadata->'bootstrap_probe'->'probe'->>'phase' AS phase, metadata->'bootstrap_probe'->'probe'->>'action' AS action,
        metadata->'bootstrap_probe'->>'state' AS state,
        jsonb_array_length(COALESCE(metadata->'bootstrap_probe'->'proof'->'documents','[]'::jsonb))::int AS documents,
        metadata->'bootstrap_probe'->'proof'->>'reply' AS reply, metadata->'bootstrap_probe'->'probe'->>'nonce' AS nonce
        FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'bootstrap_probe'
        ORDER BY metadata->'bootstrap_probe'->'probe'->>'probe_id', created_at DESC`, [operationId])).rows };
}

async function prepareRemote(frontendPort: number, sparePort: number, pki: { key: string; cert: string }): Promise<CycleTarget> {
  const gateway = required('CAUCE_FLEET_CYCLE_GATEWAY_URL');
  const caFile = process.env.CAUCE_FLEET_CYCLE_CA_FILE;
  const agent = caFile ? new (await import('node:https')).Agent({ ca: await readFile(caFile), rejectUnauthorized: true }) : undefined;
  const baseUrl = await startConsole(frontendPort, { target: gateway, changeOrigin: true, secure: true, ws: true,
    headers: { origin: required('CAUCE_FLEET_CYCLE_GATEWAY_ORIGIN') }, ...(agent === undefined ? {} : { agent }) }, pki);
  // The isolated browser network forwards exactly two loopback ports; the remote run only needs the console's.
  trusted = await startTrustedBrowser(join(directory, 'ca.crt'), directory, [frontendPort, sparePort]);
  const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
  page = asV4Page(await context.newPage());
  errors.watch(page, 'cycle-owner');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo').fill(required('CAUCE_FLEET_CYCLE_EMAIL'));
  await page.getByLabel('Contraseña').fill(required('CAUCE_FLEET_CYCLE_PASSWORD'));
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const rooms = required('CAUCE_FLEET_CYCLE_ROOMS').split(',');
  if (rooms.length !== 2 || rooms.some(room => !room)) throw new Error('CAUCE_FLEET_CYCLE_ROOMS must name two rooms');
  return { label: TARGET, baseUrl, tenantId: required('CAUCE_FLEET_CYCLE_TENANT'), hostId: required('CAUCE_FLEET_CYCLE_HOST_ID'),
    accountId: required('CAUCE_FLEET_CYCLE_ACCOUNT_ID'), rooms: [rooms[0] ?? '', rooms[1] ?? ''] };
}

async function waitEnabled(locator: V4Locator, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (await locator.isDisabled()) {
    if (Date.now() > deadline) throw new Error(`${what} stayed disabled: ${await bodySnippet(view())}`);
    await view().waitForTimeout(200);
  }
}

async function operations(): Promise<Operation[]> {
  const { tenantId } = cycle();
  const response = await apiGet(view(), `/v3/console/fleet/operations?resource=agent&tenant_id=${encodeURIComponent(tenantId)}&alias=${ALIAS}`);
  if (response.status !== 200) throw new Error(`operation history answered ${String(response.status)}`);
  return response.body.operations as Operation[];
}

/** Previews and enqueues what the panel holds, then follows that exact operation to a terminal state. */
async function enqueue(scope: V4Locator, kind: string, receipt = true): Promise<Operation> {
  try {
    return shared ? await shared.trace(kind, () => enqueueOperation(scope, kind, receipt)) : await enqueueOperation(scope, kind, receipt);
  } catch (error) {
    if (shared) {
      evidence.shared_operation_failure = { kind, operations: await operations(), traces: shared.traces };
      evidence.shared_failure_diagnostics = await Promise.allSettled([
        shared.failureSnapshot(),
        (async () => {
          const journal = await harness?.onComputer(['journalctl', '--user', '--no-pager', '-n', '80']);
          return journal && { code: journal.code, stdout: journal.stdout.slice(-16_384), stderr: journal.stderr.slice(-2_048) };
        })(),
      ]);
      if (kind === 'update') evidence.shared_update_compensation = { status: 'inspect_failed_operation_steps', operations: await operations() };
    }
    throw error;
  }
}

async function enqueueOperation(scope: V4Locator, kind: string, receipt = true): Promise<Operation> {
  const captureName = `${String(++operationSequence).padStart(2, '0')}-${kind}`;
  const known = new Set((await operations()).map(operation => operation.id));
  const preview = scope.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await waitEnabled(preview, `${kind} preview`);
  await preview.click();
  const button = scope.getByRole('button', { name: 'Confirmar operación', exact: true });
  await waitEnabled(button, `${kind} enqueue`);
  if (kind === 'purge') for (const name of [containerName, `${containerName}-state`, `${containerName}-provider-profiles`]) {
    expect(await scope.innerText()).toContain(name);
  }
  await capture(`${captureName}-preview`);
  if (kind === 'purge') backupPhase = 'purging';
  await button.click();
  const operation = await waitForOperation(known, kind);
  if (kind === 'purge') backupPhase = 'purged';
  if (receipt) await renderOperationReceipt(operation);
  await capture(`${captureName}-completed`);
  return operation;
}

async function renderOperationReceipt(operation: Operation): Promise<void> {
    const rendered = view().getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: operation.id });
    await rendered.getByText('Terminada', { exact: true }).waitFor({ timeout: 30_000 });
    await rendered.getByRole('status').filter({ hasText: 'terminó bien.' }).waitFor({ timeout: 30_000 });
    await rendered.getByRole('progressbar', { name: `Progreso: ${String(operation.steps.length)} de ${String(operation.steps.length)} pasos`, exact: true })
      .waitFor({ timeout: 30_000 });
    await rendered.evaluate(element => { element.scrollIntoView({ block: 'start' }); });
}

async function waitForOperation(known: ReadonlySet<string>, kind: string): Promise<Operation> {
  const deadline = Date.now() + 240_000;
  let operation: Operation | undefined;
  while (Date.now() < deadline) {
    operation = (await operations()).find(row => !known.has(row.id) && row.kind === kind);
    if (operation && TERMINAL.includes(operation.status)) break;
    await view().waitForTimeout(1_000);
  }
  if (!operation) throw new Error(`${kind} was never enqueued: ${await bodySnippet(view())}`);
  const journal = operation.status === 'succeeded' || !harness ? ''
    : (await harness.onComputer(['journalctl', '--user', '--no-pager', '-n', '40'])).stdout;
  expect(operation.status, `${kind}: ${JSON.stringify(operation.error)}\n${journal}`).toBe('succeeded');
  if (kind === 'create' || kind === 'restore') expect(operation.steps).toHaveLength(8);
  expect(operation.steps.every(step => step.status === 'succeeded'), JSON.stringify(operation.steps)).toBe(true);
  return operation;
}

async function holdAndResumeStop(panel: V4Locator, observer: SharedCycleObserver): Promise<Operation> {
  const before = await observer.draft('A21B_OWNED_UNSENT_DRAFT');
  const known = new Set((await operations()).map(row => row.id));
  let held: Operation | undefined;
  try {
    await panel.getByRole('button', { name: 'Previsualizar operación', exact: true }).click();
    const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
    await waitEnabled(confirm, 'held stop confirmation');
    await confirm.click();
    await expect.poll(async () => {
      held = (await operations()).find(row => !known.has(row.id) && row.kind === 'stop');
      return held?.status;
    }, { timeout: 240_000 }).toBe('failed');
    expect(held?.error).toMatchObject({ code: 'STEP_FAILED', step: 'stop', retryable: true });
    expect(held?.status).not.toBe('succeeded');
    expect(held?.steps.find(step => step.name === 'stop')?.status).toBe('failed');
    expect(held?.steps.find(step => step.name === 'stop')?.evidence?.stopped_verified).not.toBe(true);
    const failedCard = view().getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: held?.id ?? 'missing-operation' });
    await failedCard.getByText('Falló', { exact: true }).waitFor({ timeout: 30_000 });
    const journal = await harness?.onComputer(['journalctl', '--user', '--no-pager', '-n', '80']);
    const lines = (journal?.stdout ?? '').split('\n').filter(line => line.includes(held?.id ?? 'missing-operation'));
    const reason = /RESTART_HOLD_[A-Z_]+/u.exec(lines.join('\n'))?.[0];
    expect(reason, 'the exact held stop must report its canonical reason').toMatch(/^RESTART_HOLD_/u);
    const after = await observer.preserved(before);
    evidence.shared_draft_hold = { operation: held, status: held?.status, terminal_failure: true, stop_effect_applied: false, reason, before, after };
    await capture('shared-draft-held');
  } finally {
    await observer.clear();
  }
  if (!held) throw new Error('held stop operation is absent');
  const failed = held;
  return observer.trace('stop', async () => {
    const current = await openOperationTab();
    const reread = current.getByRole('button', { name: 'Releer operación', exact: true });
    await waitEnabled(reread, 'held stop reread'); await reread.click();
    const card = view().getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: failed.id });
    const replies: { status: number; request: unknown; body: Operation }[] = [];
    const resumePath = `/v3/console/fleet/operations/${failed.id}/resume`;
    view().on('response', (raw: unknown) => {
      const response = raw as { url(): string; status(): number; json(): Promise<Operation>; request(): { postDataJSON(): unknown } };
      if (new URL(response.url()).pathname === resumePath) {
        void response.json().then(body => replies.push({ status: response.status(), request: response.request().postDataJSON(), body }));
      }
    });
    const retry = card.getByRole('button', { name: 'Reintentar', exact: true });
    await waitEnabled(retry, 'held stop retry'); await retry.click();
    await expect.poll(() => replies.length, { timeout: 30_000 }).toBe(1);
    expect(replies[0]).toMatchObject({ status: 200, request: { expected_version: failed.version }, body: { id: failed.id, error: null } });
    expect(replies[0]?.body.version).toBeGreaterThan(failed.version);
    await expect.poll(async () => (await operations()).find(row => row.id === failed.id)?.status, { timeout: 30_000 }).not.toBe('failed');
    const completed = await waitForOperation(known, 'stop');
    expect(completed.id).toBe(failed.id);
    expect(completed.steps.find(step => step.name === 'stop')?.evidence?.stopped_verified).toBe(true);
    await renderOperationReceipt(completed);
    evidence.shared_stop_resumed = { operation: completed.id, status: completed.status, replies };
    await capture('shared-stop-resumed');
    return completed;
  });
}

async function openOperationTab(): Promise<V4Locator> {
  const current = view(); const { baseUrl, tenantId } = cycle();
  backupPhase = 'operations';
  await current.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenantId}/${ALIAS}`)}`, { waitUntil: 'domcontentloaded' });
  const tab = current.getByRole('tab', { name: 'Ejecución', exact: true });
  await tab.waitFor({ timeout: 30_000 });
  await tab.click();
  const panel = current.getByRole('region', { name: `Operación de ${tenantId}/${ALIAS}`, exact: true });
  await panel.waitFor({ timeout: 30_000 });
  return panel;
}

beforeAll(async () => {
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true, mode: 0o700 });
  console.info('FLEET_CYCLE_RECEIPTS', JSON.stringify({ run, directory: EVIDENCE_DIRECTORY }));
  directory = await mkdtemp(join(tmpdir(), 'cauce-fleet-cycle-'));
  if (TARGET === 'local') await mkdir(join(directory, 'space-backups'), { mode: 0o700 });
  const pki = await certificateAuthority();
  const ports = await reserveNamedLoopbackPorts(['frontend', 'spare'] as const);
  await ports.releaseAll();
  if (TARGET === 'local') {
    const before = await inventory();
    expect(before.containers).toEqual([]); expect(before.volumes).toEqual([]);
    evidence.docker_before = before;
    console.info('FLEET_CYCLE_DOCKER_BEFORE', PREFIX, JSON.stringify(before));
  }
  target = TARGET === 'local' ? await prepareLocal(ports.ports.frontend, pki) : await prepareRemote(ports.ports.frontend, ports.ports.spare, pki);
}, 900_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { failures.push(error); } };
  await attempt(async () => {
    await trusted?.close();
    if (verifiedBackupPanels !== undefined) {
      assertBackupContract(verifiedBackupPanels);
      evidence.backup_contract_verified_after_browser_close = true;
    }
  });
  await attempt(async () => vite?.close());
  if (harness) {
    const computer = harness;
    await attempt(async () => {
      const after = await computer.close();
      evidence.harness_after = after;
      expect(after).toEqual({ containers: '', volumes: '', images: '' });
    });
  }
  if (directory) await attempt(() => rm(directory, { recursive: true, force: true }));
  if (shared) evidence.shared_tui = { runtime_key: RUNTIME_KEY, alias: ALIAS, traces: shared.traces, diagnostics: shared.diagnostics };
  await attempt(() => writeFile(join(EVIDENCE_DIRECTORY, 'durable-receipts.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }));
  console.info('FLEET_CYCLE_EVIDENCE', JSON.stringify(evidence));
  if (failures.length) throw new AggregateError(failures, 'fleet cycle cleanup was incomplete');
}, 300_000);

describe(`ciclo físico de flota desde la web (${TARGET}${options.sharedTui ? ', TUI compartida' : ''})`, () => {
  it('crea, actualiza, detiene, retira, restaura y purga un agente con efecto comprobado en Docker', async () => {
    try { await walkthrough(); } catch (error) {
      await capture('failure').catch(() => undefined);
      console.info('FLEET_CYCLE_PAGE', await bodySnippet(view()));
      throw error;
    }
  }, 1_200_000);
});

/**
 * Labels are matched as substrings: a control embedded in its label adds its current value to the accessible name.
 */
async function walkthrough(): Promise<void> {
  const current = view(); const { baseUrl, tenantId, hostId, accountId, rooms } = cycle();
  const [primary, second] = rooms;
  watchBackupRequests(current, tenantId);
  const contextUrl = `${baseUrl}/messages/${encodeURIComponent(tenantId)}/${encodeURIComponent(ALIAS)}?view=context`;

  // 1. Create: «Añadir agente» → «Solo preparar, sin desplegar», a template approved by the enrolled computer.
  await current.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await current.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = current.getByRole('dialog', { name: 'Añadir agente' });
  // The radio is visually hidden inside its card; a person clicks the card's title.
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const create = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await create.waitFor({ timeout: 30_000 });
  await create.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
  await create.getByLabel('Alias operativo').fill(ALIAS);
  await create.getByLabel('Nombre visible operativo').fill(`Ciclo ${run}`);
  await create.getByLabel('Clave física de ejecución').fill(RUNTIME_KEY);
  await create.getByRole('checkbox', { name: new RegExp(`· "${primary}"$`, 'u') }).check();
  await create.getByLabel('Grupo primario').selectOption(primary);
  const host = create.getByLabel('Host operativo');
  await host.locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await host.selectOption(hostId);
  await create.getByLabel('Plantilla de ejecución').selectOption('0');
  await create.getByLabel('Cuenta principal de ejecución').selectOption(accountId);
  containerName = await create.getByLabel('Contenedor operativo').inputValue();
  runtimeUser = await create.getByLabel('Usuario operativo').inputValue();
  expect(runtimeUser).not.toBe('');
  expect(containerName.endsWith(RUNTIME_KEY)).toBe(true);
  if (TARGET === 'local') expect(containerName).toBe(`${PREFIX}-${RUNTIME_KEY}`);
  if (TARGET !== 'local') {
    // Remotely the run owns only what the template derives for this runtime key: it must not exist yet.
    const before = await inventory();
    expect(before.containers).toEqual([]); expect(before.volumes).toEqual([]);
    evidence.docker_before = before;
  }
  if (options.sharedTui) shared = new SharedCycleObserver({ container: containerName, runtime: RUNTIME_KEY, alias: ALIAS, user: runtimeUser, tenant: tenantId });
  const created = await enqueue(create, 'create');
  const afterCreate = await observe();
  expect(afterCreate).toMatchObject({ container: true, running: true,
    labels: { 'cauce.fleet.alias': ALIAS, 'cauce.fleet.runtime_key': RUNTIME_KEY, 'cauce.fleet.tenant': tenantId, 'cauce.fleet.host': hostId },
    volumes: [`${containerName}-provider-profiles`, `${containerName}-state`], credentials: true });
  expect(afterCreate.processes.length, JSON.stringify(afterCreate)).toBeGreaterThan(0);
  expect(afterCreate.processes.every(process => process.CAUCE_ALIAS === ALIAS && process.CAUCE_ROOM === primary
    && process.CAUCE_MODEL_ID === null && process.CAUCE_BOOTSTRAP === '0')).toBe(true);
  const verify = created.steps.find(step => step.name === 'verify')?.evidence;
  expect(verify).toMatchObject({ provider_verified: true, bootstrap_verified: true, profile_verified: true, roundtrip_verified: true });
  expect(created.steps.find(step => step.name === 'admission')?.evidence).toMatchObject({ authority_verified: true });
  if (cycle().probes) {
    const probes = await cycle().probes?.(created.id) ?? [];
    for (const phase of ['bootstrap', 'normal']) expect(probes.some(probe => probe.phase === phase && probe.state === 'succeeded'
      && probe.reply === `CAUCE_BOOTSTRAP_${probe.nonce}`), JSON.stringify(probes)).toBe(true);
  }
  evidence.create = { operation: created.id, steps: created.steps.map(step => step.name), observed: afterCreate };

  expect(Object.values(afterCreate.documents).some(Boolean)).toBe(false);

  // 2. Update: configuration (name, model, effort) and assignments (a second room) restart the runtime with them.
  let panel = await openOperationTab();
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('update');
  await panel.getByLabel('Nombre visible operativo').fill(`Ciclo ${run} actualizado`);
  await panel.getByLabel('Modelo operativo').fill(MODEL);
  await panel.getByLabel('Esfuerzo de razonamiento').selectOption(EFFORT);
  await panel.getByRole('checkbox', { name: new RegExp(`· "${second}"$`, 'u') }).check();
  const updated = await enqueue(panel, 'update');
  if (shared) evidence.shared_update_compensation = { status: 'not_exercised_update_succeeded', operation: updated.id };
  const afterUpdate = await observe();
  expect(afterUpdate).toMatchObject({ container: true, running: true, credentials: true });
  expect(afterUpdate.processes.length, JSON.stringify(afterUpdate)).toBeGreaterThan(0);
  expect(afterUpdate.processes.every(process => process.CAUCE_MODEL_ID === MODEL && process.CAUCE_REASONING_EFFORT === EFFORT
    && process.CAUCE_ROOM === primary && process.CAUCE_BOOTSTRAP === '0')).toBe(true);
  expect(Math.min(...afterUpdate.processes.map(process => process.start)))
    .toBeGreaterThan(Math.max(...afterCreate.processes.map(process => process.start)));
  expect(afterUpdate.view).toMatchObject({ modelId: MODEL, reasoningEffort: EFFORT, room: primary });
  expect(afterUpdate.view?.memberships?.map(row => row.room).sort()).toEqual([primary, second].sort());
  evidence.update = { operation: updated.id, observed: afterUpdate };

  // 3. Stop: the runtime processes end; the container and its state stay.
  panel = await openOperationTab();
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('stop');
  const stopped = shared ? await holdAndResumeStop(panel, shared) : await enqueue(panel, 'stop');
  const afterStop = await observe();
  expect(afterStop).toMatchObject({ container: true, processes: [], volumes: [`${containerName}-provider-profiles`, `${containerName}-state`] });
  evidence.stop = { operation: stopped.id, observed: afterStop };

  // 4. Context: with the agent stopped, the person rewrites its identity and purpose and prepares it for the next start;
  // the start applies it inside the container and only admits the runtime once its ACK measures the same documents.
  backupPhase = 'context';
  await current.goto(contextUrl, { waitUntil: 'domcontentloaded' });
  await current.getByText('No hay copias guardadas de este espacio.', { exact: true }).waitFor({ timeout: 30_000 });
  const contextReads = backupRequests.filter(request => request.phase === 'context');
  expect(contextReads.length).toBeGreaterThan(0);
  expect(contextReads.every(request => request.method === 'GET' && request.status === 200), JSON.stringify(contextReads)).toBe(true);
  const purpose = current.getByLabel('Identidad y propósito');
  await purpose.waitFor({ timeout: 30_000 });
  await purpose.fill(`Agente del ciclo físico ${CONTEXT_MARKER}.`);
  await current.getByLabel('Motivo de este cambio de perfil').fill('Prueba física del ciclo de flota desde la web');
  const prepare = current.getByRole('button', { name: 'Preparar perfil para el inicio', exact: true });
  await waitEnabled(prepare, 'context preparation');
  await prepare.click();
  await current.getByText('Borrador sin guardar.', { exact: false }).waitFor({ state: 'hidden', timeout: 30_000 });
  await capture('context-prepared');
  panel = await openOperationTab();
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('start');
  const started = await enqueue(panel, 'start');
  expect(started.steps.find(step => step.name === 'profile')?.evidence).toMatchObject({ profile_verified: true });
  const afterStart = await observe();
  expect(afterStart.processes.length, JSON.stringify(afterStart)).toBeGreaterThan(0);
  expect(afterStart.processes.every(process => process.CAUCE_MODEL_ID === MODEL && process.CAUCE_BOOTSTRAP === '0')).toBe(true);
  expect(Object.values(afterStart.documents), JSON.stringify(afterStart.documents)).toContain(true);
  if (cycle().probes) {
    const acknowledged = await cycle().probes?.(started.id) ?? [];
    expect(acknowledged.some(probe => probe.phase === 'bootstrap' && probe.action === 'profile' && probe.state === 'succeeded'
      && probe.documents > 0), JSON.stringify(acknowledged)).toBe(true);
  }
  evidence.context = { operation: started.id, marker: CONTEXT_MARKER, observed: afterStart };
  panel = await openOperationTab();
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('stop');
  evidence.stop_after_context = (await enqueue(panel, 'stop')).id;

  // 5. Retire: credentials are revoked and the delegated view leaves the container.
  panel = await openOperationTab();
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('retire');
  const retired = await enqueue(panel, 'retire', false);
  expect(retired.steps.find(step => step.name === 'revoke')?.evidence).toMatchObject({ revocation_verified: true });
  const afterRetire = await observe();
  expect(afterRetire).toMatchObject({ container: true, processes: [], credentials: false });
  evidence.retire = { operation: retired.id, observed: afterRetire };

  await current.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await current.getByRole('button', { name: `Restaurar o revisar ${tenantId}/${ALIAS}`, exact: true }).click();
  panel = current.getByRole('region', { name: `Operación de ${tenantId}/${ALIAS}`, exact: true });
  await panel.waitFor({ timeout: 30_000 });
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('restore');
  const restored = await enqueue(panel, 'restore', false);
  const afterRestore = await observe();
  expect(afterRestore).toMatchObject({ container: true, running: true, credentials: true, volumes: afterRetire.volumes });
  expect(afterRestore.processes.length, JSON.stringify(afterRestore)).toBeGreaterThan(0);
  const restoredConfig = await apiGet(current, '/v3/console/config');
  const restoredAgents = restoredConfig.body.agents as { tenant_id: string; alias: string; lifecycle_state: string; retired_at: string | null }[];
  expect(restoredAgents.find(row => row.tenant_id === tenantId && row.alias === ALIAS)).toMatchObject({ lifecycle_state: 'ready', retired_at: null });
  if (harness) expect((await harness.pool.query('SELECT lifecycle_state,retired_at FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, ALIAS])).rows)
    .toEqual([{ lifecycle_state: 'ready', retired_at: null }]);
  evidence.restore = { operation: restored.id, observed: afterRestore };
  panel = await openOperationTab();
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('retire');
  evidence.retire_after_restore = (await enqueue(panel, 'retire', false)).id;
  expect(await observe()).toMatchObject({ container: true, processes: [], credentials: false });

  // 6. Purge: the retired agent asks for its alias, names what it deletes and leaves nothing behind.
  await current.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  const purge = current.getByRole('button', { name: `Eliminar definitivamente ${tenantId}/${ALIAS}`, exact: true });
  await purge.waitFor({ timeout: 30_000 });
  await waitEnabled(purge, 'purge control');
  await purge.click();
  const removal = current.getByRole('region', { name: `Operación de ${tenantId}/${ALIAS}`, exact: true });
  await removal.waitFor({ timeout: 30_000 });
  const preview = removal.getByRole('button', { name: 'Previsualizar operación', exact: true });
  expect(await preview.isDisabled()).toBe(true);
  await removal.getByLabel('Escribe el alias', { exact: false }).fill(ALIAS);
  const purged = await enqueue(removal, 'purge', false);
  const removed = (purged.steps.find(step => step.name === 'purge')?.evidence?.removed ?? []) as { type: string; name: string }[];
  expect(removed.map(item => `${item.type}:${item.name}`).sort()).toEqual([`container:${containerName}`,
    `volume:${containerName}-provider-profiles`, `volume:${containerName}-state`].sort());
  const afterPurge = await observe();
  expect(afterPurge).toMatchObject({ container: false, volumes: [] });
  const final = await inventory(containerName);
  expect(final.containers).toEqual([]);
  expect(final.volumes).toEqual([]);
  evidence.purge = { operation: purged.id, removed, observed: afterPurge };
  evidence.docker_after_purge = final;
  console.info('FLEET_CYCLE_DOCKER_AFTER_PURGE', containerName, JSON.stringify(final));
  backupPhase = 'purged-context';
  await current.goto(contextUrl, { waitUntil: 'domcontentloaded' });
  const missing = current.getByRole('region', { name: 'Sin conversación abierta', exact: true });
  await missing.getByRole('heading', { name: 'No encontramos esa conversación', exact: true }).waitFor({ timeout: 30_000 });
  const absence = missing.getByText('El servidor no observa a', { exact: false });
  await absence.waitFor({ timeout: 30_000 });
  expect(await absence.innerText()).toContain(`${tenantId}:${ALIAS}`);
  const backupPanels = await current.getByRole('region', { name: 'Backup del espacio', exact: true }).count();
  expect(backupPanels).toBe(0);
  await capture('purged-context-missing');
  assertBackupContract(backupPanels);
  verifiedBackupPanels = backupPanels;
}

}
