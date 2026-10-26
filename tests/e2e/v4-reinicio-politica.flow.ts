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
import { policyRecoveryBundle, setCanarySharedTui } from './h6d-reinicio-politica.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, syntheticPerson, type V4Locator, type V4Page } from './v4-console-real-browser.helpers.js';

const OWNER = 'h6d-reinicio-v4-1025';
const RUN = randomUUID().slice(0, 8);
const PREFIX = `zz-canary-${OWNER}-${RUN}`;
const ALIAS = `policy${RUN}`;
const KEY = `physical-${RUN}`;
const DATUM = `MEMORY-${RUN}-${randomUUID().slice(0, 8)}`;
const SECOND = randomUUID();
const EVIDENCE = join(process.cwd(), '.delegados/v4/recibos', OWNER, `e2e-policy-${RUN}`);
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
let policy = '';
const evidence: Record<string, unknown> = { run: RUN, owner: OWNER, provider: 'durable headless and interactive double',
  sdk: 'real bundled SDK', terminal_relay: 'not mounted; physical tmux and durable SDK delivery verified' };
const browserErrors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES,
  { id: 'terminal-targets-unavailable', reason: 'hermetic gateway without the optional terminal relay',
    matches: (text, url) => text.includes('status of 501') && new URL(url).pathname === '/v3/console/terminal/targets' },
  { id: 'terminal-routes-unmounted', reason: 'hermetic gateway omits the optional terminal relay routes',
    matches: (text, url) => text.includes('status of 404')
      && ['/v3/console/terminal/targets', '/v3/console/terminal/sessions'].includes(new URL(url).pathname) }]);

interface Operation { id: string; kind: string; status: string; version?: number; error: unknown; steps: { name: string; status: string; evidence?: Record<string, unknown> }[] }
interface Launch { pid: number; native_id: string; resumed: boolean; mode: 'exec' | 'tui'; cwd: string }
interface ProcessProbe { launches: Launch[]; adapter: Record<string, unknown>; pointer: Record<string, unknown>; home: string; state: string; shared: string | null }
function active() { if (!harness) throw new Error('computer fixture absent'); return harness; }
function view() { if (!page) throw new Error('browser absent'); return page; }
function recovery() { return view().getByRole('region', { name: `Recuperación de ${ALIAS}`, exact: true }); }
function publicDiagnostic(text: string) { return text.replace(/https?:\/\/[^\s"'<>]+/gu, '[URL]').replace(/Bearer\s+[^\s]+/giu, 'Bearer [REDACTED]'); }

async function capture(name: string) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await view().setViewportSize(viewport);
    if (await recovery().count()) await recovery().evaluate(element => { element.scrollIntoView({ block: 'start' }); });
    await view().screenshot({ path: join(EVIDENCE, `${name}-${String(viewport.width)}x${String(viewport.height)}.png`) });
  }
  await view().setViewportSize({ width: 1440, height: 900 });
}

async function operations(): Promise<Operation[]> {
  const result = await apiGet(view(), `/v3/console/fleet/operations?resource=agent&tenant_id=${tenant}&alias=${ALIAS}`);
  expect(result.status).toBe(200);
  return result.body.operations as Operation[];
}

async function waitOperation(kind: string, known = new Set<string>(), status = 'succeeded') {
  let last: Operation | undefined;
  await expect.poll(async () => {
    last = (await operations()).find(row => row.kind === kind && !known.has(row.id));
    evidence.last_operation = last;
    return ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(last?.status ?? '');
  }, { timeout: 240_000, interval: 1_000 }).toBe(true);
  if (!last) throw new Error('operation absent after wait');
  expect(last.status, JSON.stringify(last.error)).toBe(status);
  return last;
}

async function enabled(locator: V4Locator) {
  await expect.poll(() => locator.isDisabled(), { timeout: 30_000 }).toBe(false);
}

async function enqueue(panel: V4Locator, kind: string, status = 'succeeded') {
  const known = new Set((await operations()).map(row => row.id));
  const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await enabled(preview); await preview.click();
  const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
  await enabled(confirm); await capture(`${kind}-preview`); await confirm.click();
  return waitOperation(kind, known, status);
}

async function secondRollout(home: string, cwd: string, present: boolean) {
  const script = `import json,os,pathlib,sys
path=pathlib.Path(sys.argv[1])/'sessions'/('rollout-canary-'+sys.argv[2]+'.jsonl')
if sys.argv[4]=='1':
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as stream: stream.write(json.dumps({'type':'session_meta','payload':{'id':sys.argv[2],'source':'cli','cwd':sys.argv[3]}})+'\\n')
else: path.unlink()
`;
  await docker(['exec', '--user', 'cauce', container, 'python3', '-c', script, home, SECOND, cwd, present ? '1' : '0']);
}

async function processProbe(): Promise<ProcessProbe> {
  const pid = await docker(['exec', '--user', '0', container, 'python3', '-c',
    "import json,pathlib,sys;print(json.loads((pathlib.Path('/run/cauce-fleet')/sys.argv[1]/'cauce-v3-adapter.json').read_text())['pid'])", KEY]);
  const script = `import json,pathlib,sys
pid=int(sys.argv[1]);raw=pathlib.Path('/proc/'+str(pid)+'/environ').read_bytes().split(bytes([0]))
env=dict(row.decode().split('=',1) for row in raw if b'=' in row)
home=pathlib.Path(env['CODEX_HOME']);state=pathlib.Path(env['CAUCE_STATE_DIR']);history=home/'h6d-invocations.jsonl';pointer=state/'sessions.json'
print(json.dumps({'launches':[json.loads(row) for row in history.read_text().splitlines()] if history.exists() else [],'adapter':{'pid':pid,**{key:env[key] for key in ('CAUCE_CONTAINER_GENERATION','CAUCE_CONTAINER_ID','CAUCE_INSTANCE_ID')}},'pointer':json.loads(pointer.read_text()) if pointer.exists() else {},'home':str(home),'state':str(state),'shared':env.get('CAUCE_SHARED_SESSION')}))
`;
  return JSON.parse(await docker(['exec', '--user', 'cauce', container, 'python3', '-c', script, pid])) as ProcessProbe;
}

async function tmux(args: string[]) {
  const observed = await processProbe();
  return docker(['exec', '--user', 'cauce', '--env', `TMUX_TMPDIR=${observed.state}`, container,
    '/usr/bin/tmux', '-u', '-L', TMUX_SOCKET, ...args]);
}

async function ask(text: string, response: string, physical: boolean, initial = false) {
  const published = await new CauceRepository(active().pool).publish(PublishMessageSchema.parse({
    request_id: randomUUID(), trace_id: randomUUID(), tenant_id: tenant, room_id: room, actor_alias: `sender${RUN}`,
    recipients: [{ tenant_id: tenant, alias: ALIAS }], body: { type: 'text', text }, idempotency_key: randomUUID(),
  }));
  let observed: { status: string; reply: string | null; last_error: string | null } | undefined;
  await expect.poll(async () => {
    observed = (await active().pool.query<NonNullable<typeof observed>>(
      "SELECT status,result->'output'->>'reply' AS reply,last_error FROM deliveries WHERE message_id=$1 AND recipient_alias=$2",
      [published.message_id, ALIAS])).rows[0];
    evidence.last_delivery = { message_id: published.message_id, ...observed };
    return observed && ['done', 'dead', 'failed'].includes(observed.status);
  }, { timeout: 90_000, interval: 500 }).toBe(true);
  expect(observed?.status, JSON.stringify(observed)).toBe('done');
  if (initial) expect(observed?.reply).toContain(response);
  else expect(observed?.reply).toBe(response);
  let rendered = '';
  if (physical) {
    await expect.poll(async () => {
      const pane = await tmux(['capture-pane', '-p', '-t', `cauce-${KEY}:agente`, '-S', '-100']);
      rendered = pane.split('\n').filter(line => line.includes(`"reply": "${response}"`)).join('\n');
      return rendered.length > 0;
    }, { timeout: 10_000 }).toBe(true);
  }
  return { message_id: published.message_id, prompt: text, ...observed, physical_tui_reply: rendered };
}

async function openRecovery() {
  await view().goto(`${baseUrl}/terminal/${tenant}/${ALIAS}?modo=tui`, { waitUntil: 'domcontentloaded' });
  await recovery().getByRole('button', { name: 'Reiniciar agente', exact: true }).click();
}

async function cancelFailed(operation: Operation) {
  const current = await apiGet(view(), `/v3/console/fleet/operations/${operation.id}`);
  expect(current.body.status).toBe('failed');
  const result = await view().evaluate(async argument => {
    const auth = await fetch('/v3/auth/session', { credentials: 'include' }).then(response => response.json()) as { csrf_token: string };
    const response = await fetch(`/v3/console/fleet/operations/${argument.id}/cancel`, { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': auth.csrf_token },
      body: JSON.stringify({ expected_version: argument.version }) });
    return response.status;
  }, { id: operation.id, version: current.body.version });
  expect(result).toBe(200);
  await expect.poll(async () => (await apiGet(view(), `/v3/console/fleet/operations/${operation.id}`)).body.status,
    { timeout: 120_000 }).toBe('cancelled');
  const final = await apiGet(view(), `/v3/console/fleet/operations/${operation.id}`);
  expect(final.body.status).toBe('cancelled');
  return final.body;
}

beforeAll(async () => {
  await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
  console.info('H6D_CANARY', JSON.stringify({ run: RUN, prefix: PREFIX, alias: ALIAS, runtime_key: KEY }));
  directory = await mkdtemp(join(tmpdir(), 'zz-canary-h6d-recovery-'));
  const tls = createSelfSignedCert({ directory });
  const ports = await reserveNamedLoopbackPorts(['frontend', 'spare'] as const);
  await ports.releaseAll(); baseUrl = `https://localhost:${String(ports.ports.frontend)}`;
  harness = await startComputerHarness({ prefix: PREFIX, consoleOrigins: [baseUrl], workRoot: '/datos', resourceOwner: OWNER,
    runtimeBundle: policyRecoveryBundle, extraSourceFiles: ['packages/protocol/src/fleet-recovery.ts',
      'services/gateway/src/fleet/agent-recovery-preflight.ts', 'services/gateway/src/fleet/recovery-host-command.ts',
      'packages/store/src/context-version-reevaluation.ts'] });
  vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
    configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory, cacheDir: join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true, watch: null, hmr: false,
      https: { key: await readFile(tls.key_path), cert: await readFile(tls.cert_path) },
      proxy: { '/v3': { target: harness.gatewayUrl, changeOrigin: false, ws: true } } },
  });
  await vite.listen();
  trusted = await startTrustedBrowser(tls.cert_path, directory, [ports.ports.frontend, ports.ports.spare]);
  const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
  page = asV4Page(await context.newPage()); browserErrors.watch(page, 'h6d-owner');
  const person = syntheticPerson('h6d-recovery', RUN);
  person.company = { name: `zz-canary-h6d-${RUN}`, slug: `zz-h6d-${RUN}` };
  const registration = await openRegistration(page, baseUrl);
  await fillRegistration(registration, person);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const login = await harness.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl }, payload: { email: person.email, password: person.password } });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).map(row => row.split(';', 1)[0]).join('; ');
  host = `${person.company.slug}-pc`;
  await enrollComputer(harness, { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token }, person.company.slug, host);
  policy = join(harness.installRoot, person.company.slug, host, 'executor-policy.json');
  evidence.legacy_policy = await setCanarySharedTui(harness, policy, false);
  expect((evidence.legacy_policy as { after: unknown }).after).toEqual({ present: false, value: null });
  tenant = (await harness.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email])).rows[0]?.tenant_id ?? '';
  room = (await harness.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id ?? '';
  await harness.pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES($1,$2,'codex',false)", [tenant, `sender${RUN}`]);
  await harness.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent')", [tenant, room, `sender${RUN}`]);
  account = `zz-h6d-${RUN}`;
  await harness.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES($1,'codex',$2,$3,'env_path','CAUCE_E2E_RECOVERY_PROFILE_PATH',true)`, [account, FIXTURE_PROVIDER_IDENTITY, tenant]);
}, 900_000);

afterAll(async () => {
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { errors.push(error); } };
  evidence.browser_errors = browserErrors.unexpected;
  await attempt(async () => trusted?.close());
  await attempt(async () => vite?.close());
  await attempt(async () => { if (harness) evidence.cleanup = await harness.close(); });
  if (directory) await attempt(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(EVIDENCE, 'durable-receipts.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  if (errors.length) throw new AggregateError(errors, 'h6d recovery cleanup failed');
}, 300_000);

describe('reinicio V4 después de actualizar una política sin TUI compartida', () => {
  it('ofrece actualizar antes de recuperar y conserva el UUID nativo, la huella y el recuerdo', async () => {
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
      await form.getByLabel('Nombre visible operativo').fill(`Policy ${RUN}`);
      await form.getByLabel('Clave física de ejecución').fill(KEY);
      await form.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
      await form.getByLabel('Grupo primario').selectOption(room);
      await form.getByLabel('Host operativo').selectOption(host);
      await form.getByLabel('Plantilla de ejecución').selectOption('0');
      await form.getByLabel('Cuenta principal de ejecución').selectOption(account);
      container = await form.getByLabel('Contenedor operativo').inputValue();
      expect(container).toBe(`${PREFIX}-${KEY}`);
      evidence.create = await enqueue(form, 'create');
      expect((await processProbe()).shared).toBeNull();

      await openRecovery();
      await recovery().getByRole('alert').filter({ hasText: 'TUI compartida' }).waitFor({ timeout: 90_000 });
      expect((await operations()).filter(row => row.kind === 'recover')).toHaveLength(0);
      await capture('01-unsupported');
      const panel = current.getByRole('region', { name: `Operación de ${tenant}/${ALIAS}`, exact: true });
      await recovery().getByRole('button', { name: 'Arrancar', exact: true }).click();
      expect(await panel.getByLabel('¿Qué quieres hacer?').inputValue()).toBe('start');
      const startHref = await current.evaluate(() => window.location.href);
      expect((await operations()).filter(row => row.kind === 'start')).toHaveLength(0);
      await capture('unsupported-start-navigation');
      await openRecovery();
      await recovery().getByRole('button', { name: 'Detener', exact: true }).waitFor({ timeout: 90_000 });
      await recovery().getByRole('button', { name: 'Detener', exact: true }).click();
      expect(await panel.getByLabel('¿Qué quieres hacer?').inputValue()).toBe('stop');
      evidence.stop = await enqueue(panel, 'stop');
      await current.goto(startHref, { waitUntil: 'domcontentloaded' });
      expect(await panel.getByLabel('¿Qué quieres hacer?').inputValue()).toBe('start');
      evidence.start = await enqueue(panel, 'start');

      evidence.legacy_turn = await ask(`REMEMBER ${DATUM}`, `STORED:${DATUM}`, false, true);
      const legacy = await processProbe();
      const native = legacy.launches.at(-1)?.native_id;
      expect(native).toMatch(/^[a-f0-9-]{36}$/u);
      expect(legacy.launches).toHaveLength(1);
      expect(legacy.launches.at(-1)?.mode).toBe('exec');
      expect(legacy.shared).toBeNull(); evidence.legacy = legacy;
      evidence.current_policy = await setCanarySharedTui(active(), policy, true);
      await openRecovery();
      await recovery().getByRole('button', { name: 'Actualizar ejecución', exact: true }).waitFor({ timeout: 90_000 });
      await recovery().getByRole('alert').filter({ hasText: 'Actualiza la ejecución' }).waitFor();
      expect((await operations()).filter(row => row.kind === 'recover')).toHaveLength(0);
      expect((await processProbe()).adapter).toEqual(legacy.adapter);
      await capture('02-update-required-without-operation');
      await recovery().getByRole('button', { name: 'Actualizar ejecución', exact: true }).click();
      expect(await panel.getByLabel('¿Qué quieres hacer?').inputValue()).toBe('update');
      const workspace = legacy.launches.at(-1)?.cwd ?? '';
      await secondRollout(legacy.home, workspace, true);
      let refused = await enqueue(panel, 'update', 'failed');
      await expect.poll(async () => {
        refused = (await operations()).find(row => row.id === refused.id) ?? refused;
        return refused.steps.find(step => step.name === 'stop')?.status;
      }, { timeout: 120_000, interval: 1_000 }).toBe('compensated');
      expect(refused.status).toBe('failed');
      expect(refused.error).toMatchObject({ code: 'STEP_FAILED', step: 'stop', retryable: false, reason: 'shared_conversation_unaccredited' });
      const refusal = panel.getByText(/La TUI compartida no podría reanudar la conversación de Codex/u).first();
      await refusal.waitFor({ timeout: 30_000 });
      const untouched = await processProbe();
      expect(untouched.adapter).toEqual(legacy.adapter);
      expect(untouched.launches).toEqual(legacy.launches);
      expect(untouched.shared).toBeNull();
      evidence.refused_update = { operation: refused, notice: await refusal.innerText(), adapter: untouched.adapter };
      await capture('02b-update-refused-ambiguous-conversation');
      evidence.refused_closed = await cancelFailed(refused);
      expect((await processProbe()).adapter).toEqual(legacy.adapter);
      await secondRollout(legacy.home, workspace, false);
      await openRecovery();
      await recovery().getByRole('button', { name: 'Actualizar ejecución', exact: true }).click();
      expect(await panel.getByLabel('¿Qué quieres hacer?').inputValue()).toBe('update');
      evidence.update = await enqueue(panel, 'update');
      await expect.poll(async () => (await processProbe()).launches.at(-1)?.mode, { timeout: 30_000 }).toBe('tui');
      const updated = await processProbe();
      expect(updated.shared).toBe('1');
      expect(updated.launches.at(-1)).toMatchObject({ native_id: native, mode: 'tui', resumed: true, cwd: legacy.launches.at(-1)?.cwd });
      evidence.updated = updated;
      evidence.updated_recall = await ask('RECALL', `RECALLED:${DATUM}`, true);
      const initialized = await processProbe();
      evidence.initialized = initialized;
      expect(initialized.pointer).toMatchObject({ sessions: { [`codex:${ALIAS}:shared:${ALIAS}`]: { native_id: native, initialized: true } } });

      await openRecovery();
      const confirm = recovery().getByRole('button', { name: 'Confirmar reinicio y reanudar', exact: true });
      await enabled(confirm);
      const before = await apiGet(current, `/v3/console/tenants/${tenant}/agents/${ALIAS}/recovery`);
      expect(before.status).toBe(200); expect(before.body.status).toBe('ready');
      evidence.ready = before.body;
      await recovery().getByRole('button', { name: 'Cancelar', exact: true }).click();
      expect((await operations()).filter(row => row.kind === 'recover')).toHaveLength(0);
      const launches = (await processProbe()).launches;
      const running = launches.at(-1);
      if (!running) throw new Error('updated TUI process absent');
      await docker(['exec', '--user', 'cauce', container, 'python3', '-c',
        'import os,signal,sys;os.kill(int(sys.argv[1]),signal.SIGINT)', String(running.pid)]);
      await expect.poll(async () => {
        const observed = JSON.parse(await docker(['exec', '--user', 'cauce', container, 'python3', '-c',
          "import json,pathlib,sys;p=pathlib.Path('/proc')/sys.argv[1]\ntry:\n s=(p/'stat').read_text().rsplit(') ',1)[1].split()[0];c=bool((p/'cmdline').read_bytes())\nexcept FileNotFoundError:s='absent';c=False\nprint(json.dumps({'state':s,'command_present':c,'stopped':s in ('absent','Z','X') and not c}))", String(running.pid)])) as { stopped: boolean };
        evidence.interrupted_process = observed; return observed.stopped;
      }, { timeout: 15_000 }).toBe(true);
      await openRecovery(); await enabled(confirm);
      await recovery().getByText('Se recreará la TUI ausente reanudando la conversación exacta.', { exact: true }).waitFor();
      const absent = await apiGet(current, `/v3/console/tenants/${tenant}/agents/${ALIAS}/recovery`);
      expect(absent.body.status).toBe('ready');
      const absentSession = (absent.body.recovery as { session: { state: string; fingerprint: string } }).session;
      expect(absentSession.state).toBe('absent');
      expect(absentSession.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      evidence.absent_preview = absent.body;
      await capture('03-restart-confirmation');
      await confirm.click();
      const recovered = await waitOperation('recover'); evidence.recover = recovered;
      for (const name of ['runtime', 'verify']) {
        expect(recovered.steps.find(step => step.name === name)?.evidence?.recovery)
          .toMatchObject({ identity: (before.body.recovery as { identity: unknown }).identity,
            session: { state: 'recreated', fingerprint: absentSession.fingerprint, resumable: true } });
      }
      const confirmed = (await active().pool.query<{ expected: string }>(
        "SELECT request->'parameters'->>'expected_fingerprint' AS expected FROM fleet_operations WHERE id=$1", [recovered.id])).rows[0];
      expect(confirmed?.expected).toBe(absentSession.fingerprint);
      evidence.confirmed_fingerprint = confirmed?.expected;
      evidence.recovered_recall = await ask('RECALL', `RECALLED:${DATUM}`, true);
      const after = await processProbe();
      evidence.after = after;
      expect(after.adapter).toEqual(initialized.adapter);
      expect(after.pointer).toEqual(initialized.pointer);
      expect(after.launches).toHaveLength(launches.length + 1);
      expect(after.launches.at(-1)).toMatchObject({ native_id: native, mode: 'tui', resumed: true });
      const verified = await apiGet(current, `/v3/console/tenants/${tenant}/agents/${ALIAS}/recovery`);
      evidence.verified = verified.body;
      expect(verified.body.status).toBe('ready');
      expect((verified.body.recovery as { identity: unknown }).identity).toEqual((before.body.recovery as { identity: unknown }).identity);
      const verifiedSession = (verified.body.recovery as { session: { state: string; resumable: boolean; fingerprint: string } }).session;
      expect(verifiedSession).toMatchObject({ state: 'present', resumable: true });
      expect(verifiedSession.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      const audit = await active().pool.query<{ event: string; step: string | null; recovery: unknown }>(
        `SELECT event,metadata->>'step' AS step,metadata#>'{host_barrier,receipts,0,evidence,recovery}' AS recovery
          FROM fleet_operation_events WHERE operation_id=$1 ORDER BY id`, [(evidence.recover as Operation).id]);
      expect(audit.rows.some(row => row.event === 'succeeded')).toBe(true);
      expect(audit.rows.some(row => row.event === 'step_completed' && row.step === 'fence')).toBe(true);
      expect(audit.rows.find(row => row.event === 'step_completed' && row.step === 'runtime')?.recovery)
        .toMatchObject({ identity: (before.body.recovery as { identity: unknown }).identity,
          session: { fingerprint: absentSession.fingerprint } });
      evidence.audit = audit.rows;
      await capture('04-same-conversation-recovered');

      await openRecovery(); await enabled(confirm);
      const known = new Set((await operations()).map(row => row.id));
      await docker(['exec', '--user', 'cauce', container, 'touch', `${after.home}/h6d-fail-resume`]);
      await confirm.click();
      const failed = await waitOperation('recover', known, 'failed');
      expect(failed.steps.find(step => step.name === 'runtime')?.status).toBe('failed');
      await recovery().getByRole('alert').filter({ hasText: 'El reinicio falló' }).waitFor({ timeout: 30_000 });
      const notice = await recovery().getByRole('alert').innerText();
      expect(notice).toContain('en «Entorno»');
      expect(notice).toContain('Vuelve a comprobar el estado');
      expect(notice).not.toContain('sigue registrada');
      expect(notice).not.toContain('No se ha confirmado el resultado');
      expect(notice).not.toContain('fleet effect failed');
      evidence.failed_restart = { operation: failed, notice, injection: 'provider double exits 42 on resume only' };
      await capture('05-failed-cause-in-spanish');
      const countBeforeRecheck = (await operations()).filter(row => row.kind === 'recover').length;
      await openRecovery();
      const previous = recovery().getByRole('alert').filter({ hasText: 'Resuelve esta operación antes de reiniciar' });
      await previous.waitFor({ timeout: 30_000 });
      const previousText = await previous.innerText();
      expect(previousText).toContain(failed.id);
      expect(previousText).toContain('Estado: Fallida');
      expect(previousText).toContain('Paso: Entorno');
      expect((await operations()).filter(row => row.kind === 'recover')).toHaveLength(countBeforeRecheck);
      evidence.previous_failed_operation = previousText;
      await capture('05b-previous-failed-without-new-operation');
      await recovery().getByRole('button', { name: 'Ver operación', exact: true }).click();
      await panel.waitFor();
      await capture('05c-previous-failed-operation-detail');
      await docker(['exec', '--user', 'cauce', container, 'rm', `${after.home}/h6d-fail-resume`]);
      evidence.failed_cancellation = await cancelFailed(failed);
      await openRecovery(); await enabled(confirm);
      const beforeRetry = new Set((await operations()).map(row => row.id));
      await confirm.click(); evidence.recovery_after_failure = await waitOperation('recover', beforeRetry);
      evidence.final_recall = await ask('RECALL', `RECALLED:${DATUM}`, true);
      const final = await processProbe();
      expect(final.launches.at(-1)?.native_id).toBe(native);
      expect(final.pointer).toEqual(initialized.pointer);
      expect(final.adapter).toEqual(initialized.adapter);
      evidence.final = final;
      await capture('06-after-failure-same-memory');
      expect(browserErrors.unexpected).toEqual([]);
    } catch (error) {
      evidence.failure_body = await bodySnippet(current);
      evidence.operations = await operations().catch(() => []);
      evidence.failure_journal = publicDiagnostic((await active().onComputer(['journalctl', '--user', '--no-pager', '-n', '60', '-o', 'cat'])).stdout);
      const row = (await active().pool.query<{ state_directory: string }>('SELECT state_directory FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, ALIAS])).rows[0];
      if (row?.state_directory && container) {
        evidence.failure_sdk = await docker(['exec', '--user', '0', container, 'python3', '-c',
          "import pathlib,sys;p=pathlib.Path(sys.argv[1])/'.cauce-adapter.log';print(p.read_text()[-16000:] if p.exists() else 'adapter_log_absent')", row.state_directory])
          .then(publicDiagnostic).catch((failure: unknown) => failure instanceof Error ? publicDiagnostic(failure.message) : 'runtime log unavailable');
      }
      await capture('failure');
      throw error;
    }
  }, 900_000);
});
