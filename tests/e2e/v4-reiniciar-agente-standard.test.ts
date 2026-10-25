import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublishMessageSchema } from '@cauce/protocol';
import { CauceRepository } from '@cauce/store';
import { TMUX_SOCKET } from '../../packages/adapter-sdk/src/shared-session/types.js';
import { docker, enrollComputer, FIXTURE_PROVIDER_IDENTITY, startComputerHarness,
  type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration, syntheticPerson,
  type V4Page } from './v4-console-real-browser.helpers.js';
import { standardRecoveryBundle } from './v4-reiniciar-agente-standard.fixtures.js';

const OWNER = 'h6c-reiniciar-1025';
const RUN = randomUUID().slice(0, 8);
const PREFIX = `zz-canary-${OWNER}-${RUN}`;
const ALIAS = `recover${RUN}`;
const KEY = `physical-${RUN}`;
const MARKER = `CANARY-MEMORY-${RUN}`;
const EVIDENCE = join(process.cwd(), '.delegados/v4/recibos', OWNER, 'standard', RUN);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
let harness: ComputerHarness | undefined;
let trusted: TrustedBrowser | undefined;
let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
let page: V4Page | undefined;
let directory = '';
let baseUrl = '';
let tenant = '';
let host = '';
let room = '';
let account = '';
let container = '';
const evidence: Record<string, unknown> = { run: RUN, owner: OWNER, provider: 'durable interactive double', sdk: 'real bundled SDK' };
const browserErrors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES,
  { id: 'terminal-targets-unavailable', reason: 'hermetic fleet gateway without a terminal relay',
    matches: (text, url) => text.includes('status of 501') && new URL(url).pathname === '/v3/console/terminal/targets' },
  { id: 'terminal-routes-unmounted', reason: 'hermetic fleet gateway omits the optional terminal relay routes',
    matches: (text, url) => text.includes('status of 404')
      && ['/v3/console/terminal/targets', '/v3/console/terminal/sessions'].includes(new URL(url).pathname) }]);

interface Operation { id: string; kind: string; status: string; error: unknown; steps: { name: string; status: string; evidence?: Record<string, unknown> }[] }
interface Launch { pid: number; native_id: string; argv: string[] }
function active() { if (!harness) throw new Error('computer fixture absent'); return harness; }
function view() { if (!page) throw new Error('browser absent'); return page; }

async function capture(name: string, current = view()) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await current.setViewportSize(viewport);
    const recovery = current.getByRole('region', { name: `Recuperación de ${ALIAS}`, exact: true });
    if (await recovery.count()) await recovery.evaluate(element => { element.scrollIntoView({ block: 'start' }); });
    await current.screenshot({ path: join(EVIDENCE, `${name}-${String(viewport.width)}x${String(viewport.height)}.png`) });
  }
  await current.setViewportSize({ width: 1440, height: 900 });
}

async function operations(): Promise<Operation[]> {
  const result = await apiGet(view(), `/v3/console/fleet/operations?resource=agent&tenant_id=${tenant}&alias=${ALIAS}`);
  expect(result.status).toBe(200);
  return result.body.operations as Operation[];
}

async function waitOperation(kind: string): Promise<Operation> {
  let last: Operation | undefined;
  await expect.poll(async () => {
    last = (await operations()).find(row => row.kind === kind);
    evidence.last_operation = last;
    return ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(last?.status ?? '');
  }, { timeout: 240_000, interval: 1_000 }).toBe(true);
  if (!last) throw new Error('operation absent after success');
  expect(last.status, JSON.stringify(last.error)).toBe('succeeded');
  return last;
}

async function processProbe(): Promise<{ launches: Launch[]; adapter: Record<string, unknown>; pointer: Record<string, unknown>; home: string; state: string }> {
  const pid = await docker(['exec', '--user', '0', container, 'python3', '-c',
    "import json,pathlib,sys;print(json.loads((pathlib.Path('/run/cauce-fleet')/sys.argv[1]/'cauce-v3-adapter.json').read_text())['pid'])", KEY]);
  const script = `import json,os,pathlib,sys
key=sys.argv[1];adapter={'pid':int(sys.argv[2])}
raw=pathlib.Path('/proc/'+str(adapter['pid'])+'/environ').read_bytes().split(bytes([0]))
env=dict(row.decode().split('=',1) for row in raw if b'=' in row)
home=pathlib.Path(env['CODEX_HOME']);state=pathlib.Path(env['CAUCE_STATE_DIR'])
launches=[json.loads(row) for row in (home/'recovery-invocations.jsonl').read_text().splitlines()]
pointer=json.loads((state/'sessions.json').read_text())
print(json.dumps({'launches':launches,'adapter':{'pid':adapter['pid'],**{key:env[key] for key in ('CAUCE_CONTAINER_GENERATION','CAUCE_CONTAINER_ID','CAUCE_INSTANCE_ID')}},'pointer':pointer,'home':str(home),'state':str(state)}))
`;
  return JSON.parse(await docker(['exec', '--user', 'cauce', container, 'python3', '-c', script, KEY, pid])) as Awaited<ReturnType<typeof processProbe>>;
}

async function tmux(args: string[]): Promise<string> {
  const pid = await docker(['exec', '--user', '0', container, 'python3', '-c',
    "import json,pathlib,sys;print(json.loads((pathlib.Path('/run/cauce-fleet')/sys.argv[1]/'cauce-v3-adapter.json').read_text())['pid'])", KEY]);
  const environment = JSON.parse(await docker(['exec', '--user', 'cauce', container, 'python3', '-c',
    "import json,pathlib,sys;e=dict(v.decode().split('=',1) for v in pathlib.Path('/proc/'+sys.argv[1]+'/environ').read_bytes().split(bytes([0])) if b'=' in v);print(json.dumps({k:e[k] for k in ['HOME','TMPDIR','TMUX_TMPDIR'] if k in e}))", pid])) as Record<string, string>;
  return docker(['exec', '--user', 'cauce', ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    container, '/usr/bin/tmux', '-L', TMUX_SOCKET, ...args]);
}

async function send(text: string) {
  return new CauceRepository(active().pool).publish(PublishMessageSchema.parse({
    request_id: randomUUID(), trace_id: randomUUID(), tenant_id: tenant, room_id: room, actor_alias: `sender${RUN}`,
    recipients: [{ tenant_id: tenant, alias: ALIAS }], body: { type: 'text', text }, idempotency_key: randomUUID(),
  }));
}

async function answer(message: string, response: string, initial = false) {
  let observed: { status: string; reply: string | null; last_error: string | null; error_code: string | null } | undefined;
  await expect.poll(async () => {
    const row = (await active().pool.query<NonNullable<typeof observed>>(
      "SELECT status,result->'output'->>'reply' AS reply,last_error,result->>'error_code' AS error_code FROM deliveries WHERE message_id=$1 AND recipient_alias=$2", [message, ALIAS])).rows[0];
    observed = row;
    evidence.last_delivery = { message_id: message, ...row };
    return row && ['done', 'dead', 'failed'].includes(row.status);
  }, { timeout: 90_000, interval: 500 }).toBe(true);
  expect(observed?.status, JSON.stringify(observed)).toBe('done');
  if (initial) expect(observed?.reply).toContain(response);
  else expect(observed?.reply).toBe(response);
  const pane = await tmux(['capture-pane', '-p', '-t', `cauce-${KEY}:agente`, '-S', '-100']);
  const rendered = pane.split('\n').filter(line => line.includes(`"reply": "${response}"`));
  expect(rendered.length).toBeGreaterThan(0);
  return { message_id: message, delivery: observed, physical_tui_reply: rendered };
}

async function ask(text: string, response: string, initial = false) {
  return answer((await send(text)).message_id, response, initial);
}

async function post(current: V4Page, path: string, payload: Record<string, unknown>) {
  return current.evaluate(async argument => {
    const auth = await fetch('/v3/auth/session', { credentials: 'include' }).then(response => response.json()) as { csrf_token: string };
    const response = await fetch(argument.path, { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': auth.csrf_token }, body: JSON.stringify(argument.payload) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, { path, payload });
}

async function cancelFailed(id: string) {
  const failed = await apiGet(view(), `/v3/console/fleet/operations/${id}`);
  expect(failed.body.status).toBe('failed');
  const cancelled = await post(view(), `/v3/console/fleet/operations/${id}/cancel`, { expected_version: failed.body.version });
  expect(cancelled.status).toBe(200);
  await expect.poll(async () => (await apiGet(view(), `/v3/console/fleet/operations/${id}`)).body.status,
    { timeout: 120_000 }).toBe('cancelled');
}

beforeAll(async () => {
  await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
  directory = await mkdtemp(join(tmpdir(), 'zz-canary-standard-recovery-'));
  const tls = createSelfSignedCert({ directory });
  const ports = await reserveNamedLoopbackPorts(['frontend', 'spare'] as const);
  await ports.releaseAll();
  baseUrl = `https://localhost:${String(ports.ports.frontend)}`;
  harness = await startComputerHarness({ prefix: PREFIX, consoleOrigins: [baseUrl], workRoot: '/datos', resourceOwner: OWNER,
    runtimeBundle: standardRecoveryBundle });
  vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
    configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory, cacheDir: join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true, watch: null, hmr: false,
      https: { key: await readFile(tls.key_path), cert: await readFile(tls.cert_path) },
      proxy: { '/v3': { target: harness.gatewayUrl, changeOrigin: false, ws: true } } },
  });
  await vite.listen();
  trusted = await startTrustedBrowser(tls.cert_path, directory, [ports.ports.frontend, ports.ports.spare]);
  const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
  page = asV4Page(await context.newPage());
  browserErrors.watch(page, 'standard-owner');
  const person = syntheticPerson('recovery', RUN);
  person.company = { name: `zz-canary-recovery-${RUN}`, slug: `zz-recovery-${RUN}` };
  const registration = await openRegistration(page, baseUrl).catch(async (error: unknown) => {
    await capture('setup-failure');
    evidence.setup_body = await bodySnippet(view());
    evidence.browser_errors = browserErrors.unexpected;
    console.info('STANDARD_BROWSER_SETUP_FAILURE', JSON.stringify({ body: evidence.setup_body, errors: browserErrors.unexpected }));
    throw error;
  });
  await fillRegistration(registration, person);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const login = await harness.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl }, payload: { email: person.email, password: person.password } });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).map(row => row.split(';', 1)[0]).join('; ');
  host = `${person.company.slug}-pc`;
  try {
    await enrollComputer(harness, { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token }, person.company.slug, host);
  } catch (error) {
    const script = `import json,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1]);releases=list(root.glob('release/*/.verified'))
if len(releases)!=1: print(json.dumps({'release_count':len(releases)}));sys.exit(0)
result=subprocess.run(['python3','-B',str(releases[0].parent/'ops/cli/fleet-executor.py'),'--policy',str(root/'executor-policy.json'),'--capabilities'],capture_output=True,text=True)
print(json.dumps({'code':result.returncode,'stdout':result.stdout[-3000:],'stderr':result.stderr[-3000:]}))
`;
    evidence.setup_diagnostic = (await harness.onComputer(['python3', '-B', '-c', script, join(harness.installRoot, person.company.slug, host)])).stdout;
    console.info('STANDARD_SETUP_DIAGNOSTIC', evidence.setup_diagnostic);
    throw error;
  }
  const provision = await harness.onComputer(['python3', '-c',
    "import json,sys;print(json.dumps({'shared_tui':json.load(open(sys.argv[1]))['bundles']['codex'].get('shared_tui')}))",
    join(harness.installRoot, person.company.slug, host, 'executor-policy.json')]);
  expect(provision.code).toBe(0);
  evidence.provision = JSON.parse(provision.stdout) as unknown;
  expect(evidence.provision).toEqual({ shared_tui: true });
  tenant = (await harness.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email])).rows[0]?.tenant_id ?? '';
  room = (await harness.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id ?? '';
  await harness.pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES($1,$2,'codex',false)", [tenant, `sender${RUN}`]);
  await harness.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent')", [tenant, room, `sender${RUN}`]);
  account = `zz-recovery-${RUN}`;
  await harness.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES($1,'codex',$2,$3,'env_path','CAUCE_E2E_RECOVERY_PROFILE_PATH',true)`, [account, FIXTURE_PROVIDER_IDENTITY, tenant]);
}, 900_000);

afterAll(async () => {
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { errors.push(error); } };
  await attempt(async () => trusted?.close());
  await attempt(async () => vite?.close());
  await attempt(async () => { if (harness) evidence.cleanup = await harness.close(); });
  if (directory) await attempt(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(EVIDENCE, 'durable-receipts.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  if (errors.length) throw new AggregateError(errors, 'standard recovery cleanup failed');
}, 300_000);

describe('recuperación estándar con ejecutor, SDK, Chromium, PostgreSQL y Docker reales', () => {
  it('crea, interrumpe y recupera la conversación exacta con auditoría y aislamiento', async () => {
    const current = view();
    try {
      expect(ALIAS).not.toBe(KEY);
      await current.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
      await current.getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = current.getByRole('dialog', { name: 'Añadir agente' });
      await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
      const form = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
      await form.getByLabel('Espacio de trabajo operativo').selectOption(tenant);
      await form.getByLabel('Alias operativo').fill(ALIAS);
      await form.getByLabel('Nombre visible operativo').fill(`Recovery ${RUN}`);
      await form.getByLabel('Clave física de ejecución').fill(KEY);
      await form.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
      await form.getByLabel('Grupo primario').selectOption(room);
      await form.getByLabel('Host operativo').selectOption(host);
      await form.getByLabel('Plantilla de ejecución').selectOption('0');
      await form.getByLabel('Cuenta principal de ejecución').selectOption(account);
      container = await form.getByLabel('Contenedor operativo').inputValue();
      expect(container).toBe(`${PREFIX}-${KEY}`);
      await form.getByRole('button', { name: 'Previsualizar operación', exact: true }).click();
      const confirm = form.getByRole('button', { name: 'Confirmar operación', exact: true });
      await expect.poll(() => confirm.isDisabled(), { timeout: 30_000 }).toBe(false);
      await capture('01-create-preview');
      await confirm.click();
      evidence.create = await waitOperation('create');
      await current.goto(`${baseUrl}/terminal/${tenant}/${ALIAS}?modo=tui`, { waitUntil: 'domcontentloaded' });
      const recovery = current.getByRole('region', { name: `Recuperación de ${ALIAS}`, exact: true });
      const inspect = recovery.getByRole('button', { name: 'Reiniciar agente', exact: true });
      const apply = recovery.getByRole('button', { name: 'Confirmar reinicio y reanudar', exact: true });
      const cancel = recovery.getByRole('button', { name: 'Cancelar', exact: true });
      await inspect.click();
      await recovery.getByRole('alert').filter({ hasText: 'No hay una conversación reanudable verificada' }).waitFor({ timeout: 120_000 });
      expect(await apply.isDisabled()).toBe(true);
      await capture('02-uninitialized-blocked');
      await cancel.click();
      evidence.initial_conversation = await ask(`REMEMBER ${MARKER}`, `STORED:${MARKER}`, true);
      expect(await tmux(['list-panes', '-t', `cauce-${KEY}:agente`, '-F', '#{pane_dead}'])).toBe('0');
      const before = await processProbe();
      evidence.before_recovery = before;
      expect(before.launches).toHaveLength(1);
      const native = before.launches[0]?.native_id;
      expect(native).toBeTruthy();
      expect(before.pointer).toMatchObject({ sessions: { [`codex:${ALIAS}:shared:${ALIAS}`]: { native_id: native, initialized: true } } });
      await inspect.click();
      await expect.poll(() => apply.isDisabled(), { timeout: 120_000 }).toBe(false);
      await recovery.getByText('Se cerrará la TUI actual y se reanudará la conversación exacta. Confirma solo si necesitas recuperarla.', { exact: true }).waitFor();
      await cancel.click();
      expect((await processProbe()).launches).toHaveLength(1);
      evidence.cancel = { unchanged_launches: 1 };

      const held = await send('HOLD-CANARY');
      await expect.poll(async () => (await active().pool.query<{ status: string }>(
        'SELECT status FROM deliveries WHERE message_id=$1 AND recipient_alias=$2', [held.message_id, ALIAS])).rows[0]?.status,
      { timeout: 30_000 }).toBe('started');
      await inspect.click();
      await recovery.getByRole('alert').filter({ hasText: 'entrega en vuelo' }).waitFor({ timeout: 120_000 });
      expect(await apply.isDisabled()).toBe(true);
      await capture('03-in-flight-blocked');
      await cancel.click();
      await docker(['exec', '--user', 'cauce', container, 'touch', `${before.home}/hold-release`]);
      evidence.in_flight = await answer(held.message_id, 'HELD-CANARY');

      await inspect.click();
      await expect.poll(() => apply.isDisabled(), { timeout: 120_000 }).toBe(false);
      await capture('04-present-force-preview');
      const successes = (await operations()).filter(row => row.kind === 'recover' && row.status === 'succeeded').length;
      await apply.click();
      await expect.poll(async () => (await operations()).filter(row => row.kind === 'recover' && row.status === 'succeeded').length,
        { timeout: 120_000 }).toBe(successes + 1);
      evidence.forced_delivery = await ask('RECALL', `RECALLED:${MARKER}`);
      const preInterrupt = await processProbe();
      expect(preInterrupt.launches).toHaveLength(2);
      expect(preInterrupt.launches[1]?.native_id).toBe(native);
      await docker(['exec', '--user', 'cauce', container, 'python3', '-c',
        'import os,signal,sys;os.kill(int(sys.argv[1]),signal.SIGINT)', String(preInterrupt.launches[1]?.pid)]);
      await expect.poll(async () => {
        const script = `import json,pathlib,sys
base=pathlib.Path('/proc')/sys.argv[1]
try:
 state=(base/'stat').read_text().rsplit(') ',1)[1].split()[0];command=bool((base/'cmdline').read_bytes())
except FileNotFoundError: state='absent';command=False
print(json.dumps({'state':state,'command_present':command,'stopped':state in ('absent','Z','X') and not command}))
`;
        const observed = JSON.parse(await docker(['exec', '--user', 'cauce', container, 'python3', '-c', script,
          String(preInterrupt.launches[1]?.pid)])) as { state: string; command_present: boolean; stopped: boolean };
        evidence.interrupted_process = observed;
        return observed.stopped;
      }, { timeout: 15_000 }).toBe(true);
      await current.goto(`${baseUrl}/terminal/${tenant}/${ALIAS}?modo=tui`, { waitUntil: 'domcontentloaded' });
      await inspect.click();
      await expect.poll(() => apply.isDisabled(), { timeout: 120_000 }).toBe(false);
      await recovery.getByText('Se recreará la TUI ausente reanudando la conversación exacta.', { exact: true }).waitFor();
      await capture('05-absent-conversation-preview');
      const absentSuccesses = (await operations()).filter(row => row.kind === 'recover' && row.status === 'succeeded').length;
      await apply.click();
      await expect.poll(async () => (await operations()).filter(row => row.kind === 'recover' && row.status === 'succeeded').length,
        { timeout: 120_000 }).toBe(absentSuccesses + 1);
      evidence.recovered_delivery = await ask('RECALL', `RECALLED:${MARKER}`);
      const after = await processProbe();
      expect(after.adapter).toEqual(before.adapter);
      expect(after.pointer).toEqual(before.pointer);
      expect(after.launches).toHaveLength(3);
      expect(after.launches[2]?.native_id).toBe(native);
      expect(after.launches[2]?.pid).not.toBe(preInterrupt.launches[1]?.pid);
      expect(after.launches[2]?.argv).toEqual(expect.arrayContaining(['resume', native]));
      const audits = (await active().pool.query<Record<string, unknown>>(`SELECT e.operation_id,e.event,
        jsonb_build_object('step',e.metadata->>'step','epoch',e.metadata#>'{host_barrier,epoch}',
          'recovery',e.metadata#>'{host_barrier,receipts,0,evidence,recovery}') AS metadata FROM fleet_operation_events e
        JOIN fleet_operations o ON o.id=e.operation_id WHERE o.kind='recover' AND o.target->>'alias'=$1 ORDER BY e.id`, [ALIAS])).rows;
      const identity = { generation: after.adapter.CAUCE_CONTAINER_GENERATION, container_id: after.adapter.CAUCE_CONTAINER_ID,
        writer_instance_id: after.adapter.CAUCE_INSTANCE_ID };
      const sealed = (await active().pool.query<{ id: string; fenced: boolean; succeeded: boolean; exact_runtime: boolean }>(`
        SELECT o.id,bool_or(e.event='succeeded') AS succeeded,
          bool_or(e.event='step_completed' AND e.metadata->>'step'='fence') AS fenced,
          bool_or(e.event='step_completed' AND e.metadata->>'step'='runtime'
            AND e.metadata#>>'{host_barrier,receipts,0,evidence,recovery,session,state}' IN ('resumed','recreated')
            AND e.metadata#>'{host_barrier,receipts,0,evidence,recovery,identity}'=$2::jsonb) AS exact_runtime
        FROM fleet_operations o JOIN fleet_operation_events e ON e.operation_id=o.id
        WHERE o.kind='recover' AND o.target->>'alias'=$1 AND o.request->'parameters'->>'action'='apply' AND o.status='succeeded'
        GROUP BY o.id`, [ALIAS, JSON.stringify(identity)])).rows;
      expect(sealed).toHaveLength(2);
      expect(sealed.every(row => row.fenced && row.succeeded && row.exact_runtime)).toBe(true);
      evidence.recovery = { before, after, audits, sealed, operations: await operations(), response: `RECALLED:${MARKER}` };
      await capture('06-recovered');
      if (!trusted) throw new Error('trusted browser absent');
      const foreignContext = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
      const foreign = asV4Page(await foreignContext.newPage());
      const person = syntheticPerson('foreign', RUN);
      person.company = { name: `zz-canary-foreign-${RUN}`, slug: `zz-foreign-${RUN}` };
      const registration = await openRegistration(foreign, baseUrl);
      await fillRegistration(registration, person);
      await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await foreign.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
      const denied = await apiGet(foreign, `/v3/console/tenants/${tenant}/agents/${ALIAS}/recovery`);
      expect(denied.status).toBe(403);
      evidence.foreign = { get: denied.status, unchanged_launches: (await processProbe()).launches.length };
      const recoveryOperation = (await operations()).find(row => row.kind === 'recover');
      if (!recoveryOperation) throw new Error('recovery operation absent');
      const foreignOperation = await apiGet(foreign, `/v3/console/fleet/operations/${recoveryOperation.id}`);
      expect(foreignOperation.status).toBe(404);
      const directive = await apiGet(current, `/v3/console/tenants/${tenant}/agents/${ALIAS}/recovery`);
      const request = { kind: 'recover', target: { resource: 'agent', tenant_id: tenant, alias: ALIAS },
        expected_revision: directive.body.expected_revision, idempotency_key: randomUUID(), parameters: { action: 'probe' } };
      const foreignProbe = await post(foreign, '/v3/console/fleet/operations', request);
      expect(foreignProbe.status).toBe(403);
      const foreignApply = await post(foreign, '/v3/console/fleet/operations', { ...request, idempotency_key: randomUUID(),
        parameters: { action: 'apply', identity, expected_fingerprint: '0'.repeat(64), force: true } });
      expect(foreignApply.status).toBe(403);
      evidence.foreign = { get: denied.status, operation: foreignOperation.status, probe: foreignProbe.status,
        apply: foreignApply.status, unchanged_launches: (await processProbe()).launches.length };
      await capture('07-foreign-denied', foreign);
      await foreignContext.close();

      const staleIdentity = await post(current, '/v3/console/fleet/operations', { ...request, idempotency_key: randomUUID(),
        parameters: { action: 'apply', identity: { ...identity, writer_instance_id: randomUUID() }, expected_fingerprint: '0'.repeat(64), force: true } });
      expect(staleIdentity.status).toBe(202);
      const staleIdentityId = String(staleIdentity.body.operation_id);
      await expect.poll(async () => (await apiGet(current, `/v3/console/fleet/operations/${staleIdentityId}`)).body.status,
        { timeout: 120_000 }).toBe('failed');
      expect((await processProbe()).launches).toHaveLength(3);
      await cancelFailed(staleIdentityId);
      const latestDirective = await apiGet(current, `/v3/console/tenants/${tenant}/agents/${ALIAS}/recovery`);
      const staleFingerprint = await post(current, '/v3/console/fleet/operations', { ...request, idempotency_key: randomUUID(),
        expected_revision: latestDirective.body.expected_revision,
        parameters: { action: 'apply', identity, expected_fingerprint: '0'.repeat(64), force: true } });
      expect(staleFingerprint.status).toBe(202);
      const staleId = staleFingerprint.body.operation_id;
      await expect.poll(async () => (await apiGet(current, `/v3/console/fleet/operations/${String(staleId)}`)).body.status,
        { timeout: 120_000 }).toBe('failed');
      expect((await processProbe()).launches).toHaveLength(3);
      const fenced = await send('RECALL');
      await current.waitForTimeout(750);
      const blockedDelivery = (await active().pool.query<{ status: string }>(
        'SELECT status FROM deliveries WHERE message_id=$1 AND recipient_alias=$2', [fenced.message_id, ALIAS])).rows[0];
      expect(blockedDelivery?.status).toBe('pending');
      await cancelFailed(String(staleId));
      evidence.unfenced_delivery = await answer(fenced.message_id, `RECALLED:${MARKER}`);
      evidence.cas = { stale_identity: 'failed', stale_fingerprint: 'failed', unchanged_launches: 3,
        claims_fenced: blockedDelivery?.status, compensation: 'cancelled' };
      evidence.browser_errors = browserErrors.unexpected;
      evidence.hermetic_omissions = Object.fromEntries(browserErrors.ignored);
      browserErrors.assertClean();
    } catch (error) {
      evidence.operations_at_failure = await operations().catch(() => []);
      await capture('failure').catch(() => undefined);
      evidence.failure_body = await bodySnippet(current).catch(() => 'unavailable');
      evidence.failure_journal = (await active().onComputer(['journalctl', '--user', '--no-pager', '-n', '60'])).stdout
        .replace(/postgres(?:ql)?:\/\/\S+/giu, 'postgresql://redacted').replace(/Bearer\s+\S+/giu, 'Bearer redacted');
      console.info('STANDARD_RECOVERY_FAILURE', JSON.stringify(evidence));
      throw error;
    }
  }, 600_000);
});
