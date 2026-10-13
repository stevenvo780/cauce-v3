import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_PROVIDER_IDENTITY, docker, enrollComputer, startComputerHarness, type ComputerHarness,
} from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
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
 *   company is registered through the console. Every Docker resource of the run starts with `zz-canary-cycle-<run>`.
 * - `server2`: the same walkthrough against a deployed gateway. The console served here proxies `/v3` to
 *   CAUCE_FLEET_CYCLE_GATEWAY_URL (Origin rewritten to CAUCE_FLEET_CYCLE_GATEWAY_ORIGIN, trusting CAUCE_FLEET_CYCLE_CA_FILE
 *   when set), signs in with CAUCE_FLEET_CYCLE_EMAIL/CAUCE_FLEET_CYCLE_PASSWORD and uses an already enrolled computer:
 *   CAUCE_FLEET_CYCLE_TENANT, CAUCE_FLEET_CYCLE_HOST_ID, CAUCE_FLEET_CYCLE_ACCOUNT_ID and two rooms in
 *   CAUCE_FLEET_CYCLE_ROOMS ("primary,second"). Docker is read through the caller's DOCKER_HOST (for example ssh://).
 */
const execute = promisify(execFile);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
const run = randomUUID().replaceAll('-', '').slice(0, 8);
const PREFIX = `zz-canary-cycle-${run}`;
const TARGET = process.env.CAUCE_FLEET_CYCLE_TARGET ?? 'local';
const ALIAS = `ciclo${run}`;
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
  id: string; kind: string; status: string; created_at: string; error: unknown;
  steps: { name: string; status: string; evidence?: Record<string, unknown> }[];
}
interface Observation {
  container: boolean; running: boolean; labels: Record<string, string>; volumes: string[];
  processes: { pid: number; start: number; CAUCE_ALIAS: string | null; CAUCE_ROOM: string | null; CAUCE_MODEL_ID: string | null;
    CAUCE_REASONING_EFFORT: string | null; CAUCE_BOOTSTRAP: string | null }[];
  view: { modelId?: string; reasoningEffort?: string; room?: string; memberships?: { room: string; role: string }[] } | null;
  credentials: boolean;
  /** Every AGENTS.md under the runtime home and whether it carries the context marker. */
  documents: Record<string, boolean>;
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
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES]);
const evidence: Record<string, unknown> = { run, target: TARGET };

function view() { if (!page) throw new Error('cycle page absent'); return page; }
function cycle() { if (!target) throw new Error('cycle target absent'); return target; }
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for CAUCE_FLEET_CYCLE_TARGET=${TARGET}`);
  return value;
}

/** Everything Docker holds for this run: the whole computer locally, the agent container and its volumes remotely. */
async function inventory(): Promise<{ containers: string[]; volumes: string[]; totals: { containers: number; volumes: number } }> {
  const prefix = TARGET === 'local' ? PREFIX : containerName;
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
    configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory,
    server: { host: '127.0.0.1', port: frontendPort, strictPort: true, https: { key: await readFile(pki.key), cert: await readFile(pki.cert) },
      proxy: { '/v3': proxy } },
  });
  vite = server;
  await server.listen();
  return `https://localhost:${String(frontendPort)}`;
}

async function prepareLocal(frontendPort: number, pki: { key: string; cert: string }): Promise<CycleTarget> {
  const origin = `https://localhost:${String(frontendPort)}`;
  const computer = await startComputerHarness({ prefix: PREFIX, consoleOrigins: [origin] });
  harness = computer;
  const baseUrl = await startConsole(frontendPort, { target: computer.gatewayUrl, changeOrigin: false, ws: true }, pki);
  trusted = await startTrustedBrowser(join(directory, 'ca.crt'), directory, [frontendPort, Number(new URL(computer.gatewayUrl).port)]);
  const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
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
  await enrollComputer(computer, session, owner.company.slug, hostId);
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
  const known = new Set((await operations()).map(operation => operation.id));
  const preview = scope.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await waitEnabled(preview, `${kind} preview`);
  await preview.click();
  const button = scope.getByRole('button', { name: 'Encolar operación', exact: true });
  await waitEnabled(button, `${kind} enqueue`);
  await button.click();
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
  expect(operation.steps.every(step => step.status === 'succeeded'), JSON.stringify(operation.steps)).toBe(true);
  // Retire and purge take the agent out of the open sheet; their receipt is the durable operation itself.
  if (receipt) await scope.getByText('Completada').first().waitFor({ timeout: 30_000 });
  return operation;
}

async function openOperationTab(): Promise<V4Locator> {
  const current = view(); const { baseUrl, tenantId } = cycle();
  await current.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenantId}/${ALIAS}`)}`, { waitUntil: 'domcontentloaded' });
  const tab = current.getByRole('tab', { name: 'Operación', exact: true });
  await tab.waitFor({ timeout: 30_000 });
  await tab.click();
  const panel = current.getByRole('region', { name: `Operación de ${tenantId}/${ALIAS}`, exact: true });
  await panel.waitFor({ timeout: 30_000 });
  return panel;
}

beforeAll(async () => {
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  directory = await mkdtemp(join(tmpdir(), 'cauce-fleet-cycle-'));
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
  await attempt(async () => trusted?.close());
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
  console.info('FLEET_CYCLE_EVIDENCE', JSON.stringify(evidence));
  if (failures.length) throw new AggregateError(failures, 'fleet cycle cleanup was incomplete');
}, 300_000);

describe(`ciclo físico de flota desde la web (${TARGET})`, () => {
  it('crea, actualiza, detiene, retira y purga un agente con efecto comprobado en Docker', async () => {
    try { await walkthrough(); } catch (error) {
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
  await panel.getByLabel('Acción operativa').selectOption('update');
  await panel.getByLabel('Nombre visible operativo').fill(`Ciclo ${run} actualizado`);
  await panel.getByLabel('Modelo operativo').fill(MODEL);
  await panel.getByLabel('Esfuerzo de razonamiento').selectOption(EFFORT);
  await panel.getByRole('checkbox', { name: new RegExp(`· "${second}"$`, 'u') }).check();
  const updated = await enqueue(panel, 'update');
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
  await panel.getByLabel('Acción operativa').selectOption('stop');
  const stopped = await enqueue(panel, 'stop');
  const afterStop = await observe();
  expect(afterStop).toMatchObject({ container: true, processes: [], volumes: [`${containerName}-provider-profiles`, `${containerName}-state`] });
  evidence.stop = { operation: stopped.id, observed: afterStop };

  // 4. Context: with the agent stopped, the person rewrites its identity and purpose and prepares it for the next start;
  // the start applies it inside the container and only admits the runtime once its ACK measures the same documents.
  await current.goto(`${baseUrl}/messages/${encodeURIComponent(tenantId)}/${encodeURIComponent(ALIAS)}?view=context`, { waitUntil: 'domcontentloaded' });
  const purpose = current.getByLabel('Identidad y propósito');
  await purpose.waitFor({ timeout: 30_000 });
  await purpose.fill(`Agente del ciclo físico ${CONTEXT_MARKER}.`);
  await current.getByLabel('Motivo de este cambio de perfil').fill('Prueba física del ciclo de flota desde la web');
  const prepare = current.getByRole('button', { name: 'Preparar perfil para el inicio', exact: true });
  await waitEnabled(prepare, 'context preparation');
  await prepare.click();
  await current.getByText('Borrador sin guardar.', { exact: false }).waitFor({ state: 'hidden', timeout: 30_000 });
  panel = await openOperationTab();
  await panel.getByLabel('Acción operativa').selectOption('start');
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
  await panel.getByLabel('Acción operativa').selectOption('stop');
  evidence.stop_after_context = (await enqueue(panel, 'stop')).id;

  // 5. Retire: credentials are revoked and the delegated view leaves the container.
  panel = await openOperationTab();
  await panel.getByLabel('Acción operativa').selectOption('retire');
  const retired = await enqueue(panel, 'retire', false);
  expect(retired.steps.find(step => step.name === 'revoke')?.evidence).toMatchObject({ revocation_verified: true });
  const afterRetire = await observe();
  expect(afterRetire).toMatchObject({ container: true, processes: [], credentials: false });
  evidence.retire = { operation: retired.id, observed: afterRetire };

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
  const final = await inventory();
  expect(final.containers.filter(name => name.startsWith(containerName))).toEqual([]);
  expect(final.volumes.filter(name => name.startsWith(containerName))).toEqual([]);
  evidence.purge = { operation: purged.id, removed, observed: afterPurge };
  evidence.docker_after_purge = final;
  console.info('FLEET_CYCLE_DOCKER_AFTER_PURGE', containerName, JSON.stringify(final));
  errors.assertClean();
}
