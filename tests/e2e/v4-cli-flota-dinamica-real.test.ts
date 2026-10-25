import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPUTER_RUNTIME, docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { apiGet } from './v4-console-real-browser.helpers.js';
import { fleetCliReceipts, startFleetCliFixture, type FleetCliFixture, type FleetCliRuntime } from './v4-cli-flota-dinamica.host.js';
import { buildInstalledCli, type InstalledCliResult } from './v4-cli-flota-dinamica.install.js';
import { FLEET_CLI_PROVIDER_FIXTURE } from './v4-cli-flota-dinamica.runtime.js';

interface Operation { id: string; kind: string; status: string; error: { code?: string; step?: string } | null }
interface Inventory {
  revision: number; agents: { alias: string; display_name?: string; model_id?: string; reasoning_effort?: string }[];
  retired_agents: { alias: string }[]; operations: Operation[];
}
interface Observation {
  running: boolean; labels: Record<string, string>; credentials: boolean | null;
  runtime_processes: number;
  native_session_present: boolean | null;
  processes: { model: string | null; effort: string | null; bootstrap: string | null }[];
}

let fixture: FleetCliFixture | undefined;
let installed: Awaited<ReturnType<typeof buildInstalledCli>> | undefined;
let runtime: FleetCliRuntime | undefined;
let installationDirectory: string | undefined;
const alias = `cli${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const runtimeKey = `cli-${alias}`;
const marker = randomBytes(12).toString('hex');
const operations: { command: string; id: string; status: string }[] = [];
let neighbor: { pane: string; pid: number; starttime: string } | undefined;
const active = () => { if (!fixture) throw new Error('dynamic CLI fixture unavailable'); return fixture; };
const cli = () => { if (!installed) throw new Error('installed candidate CLI unavailable'); return installed; };
function cliDiagnostics(result: InstalledCliResult): string[] {
  const allowed = ['Falta el runtime Cauce compilado;', 'Control de terminal inválido.', 'El relay devolvió una sesión distinta.',
    'No se acreditó el control del terminal.', 'El servidor rechazó la entrada;', 'No se pudo abrir el WebSocket;',
    'El relay no acreditó la conexión del terminal.', 'El gateway no acreditó el control de la TUI.',
    'El servidor no autoriza esta terminal;', 'El servidor no autoriza el modo de terminal solicitado.',
    'La terminal del agente no está conectada;', 'La consola rechazó el acceso (HTTP 403);',
    'Hay un conflicto de versión o estado (HTTP 409);'];
  const recognized = allowed.filter(message => result.stderr.includes(message));
  const close = /Terminal cerrado por el servidor \(código (\d{4})\)/u.exec(result.stderr)?.[1];
  if (close) recognized.push(`websocket_close_${close}`);
  return recognized;
}
function successful(result: InstalledCliResult, operation: string): void {
  if (result.code !== 0) throw new Error(`${operation} failed with exit ${String(result.code)}; public diagnostics: ${cliDiagnostics(result).join(' | ') || 'unclassified'}`);
}
function document(result: InstalledCliResult, operation: string): unknown {
  successful(result, operation);
  try { return JSON.parse(result.stdout) as unknown; }
  catch { throw new Error(`${operation} did not return a JSON receipt`); }
}
function connection(session = cli().sessionFile): string[] {
  return ['--gateway', active().baseUrl, '--origin', active().baseUrl, '--ca-file', active().caFile, '--session-file', session];
}
function terminal(session = cli().sessionFile): string[] { return [alias, '--tenant', active().tenantId, ...connection(session)]; }
async function receipt(name: string, value: unknown): Promise<void> {
  await writeFile(join(active().receipts, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
async function inventory(): Promise<Inventory> {
  return document(await cli().run(['spaces', 'list', '--json', '--tenant', active().tenantId, '--alias', alias, ...connection()]), 'spaces list') as Inventory;
}
async function waitOperation(id: string): Promise<Operation> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const row = (await active().computer.pool.query<Operation>('SELECT id,kind,status,error FROM fleet_operations WHERE id=$1', [id])).rows[0];
    if (row && ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(row.status)) {
      if (row.status !== 'succeeded') {
        const journal = await active().computer.onComputer(['journalctl', '--user', '-u', active().unit, '--no-pager', '-o', 'cat',
          '--grep', 'fleet (step failed|host command failed)', '-n', '12']);
        await receipt(`failed-operation-${id}`, { operation: row,
          runtime_diagnostic: await active().runtimeDiagnostic(alias),
          executor_redacted_errors: journal.stdout.split('\n').filter(line => line.startsWith('fleet step failed ')
            || line.startsWith('fleet host command failed component=fleet.executor ')) });
        throw new Error(`fleet ${row.kind} ended ${row.status} (${row.error?.code ?? 'no_code'}, ${row.error?.step ?? 'no_step'})`);
      }
      return row;
    }
    await new Promise<void>(resolve => { setTimeout(resolve, 300); });
  }
  throw new Error('owned fleet operation did not reach its terminal state before the deadline');
}
function parameters() {
  const current = active();
  return { runtime_key: runtimeKey, harness_id: 'codex', display_name: 'Terminal CLI de flota dinámica',
    primary_room_id: current.room, primary_account_id: current.accountId, memberships: [{ room_id: current.room, role: 'agent' }],
    placement: { host_id: current.hostId, mode: 'container', container_name: `${current.prefix}-${runtimeKey}`,
      runtime_user: COMPUTER_RUNTIME.user, systemd_user: COMPUTER_RUNTIME.user, home_directory: COMPUTER_RUNTIME.home,
      state_directory: `${COMPUTER_RUNTIME.stateRoot}/${runtimeKey}` } };
}
async function change(command: 'create' | 'edit' | 'retire', value?: unknown): Promise<Operation> {
  const snapshot = await inventory();
  const input = join(active().directory, `space-${command}.json`);
  if (value !== undefined) await writeFile(input, JSON.stringify(value), { mode: 0o600 });
  const args = ['spaces', command, '--json', '--tenant', active().tenantId, '--alias', alias,
    '--expected-revision', String(snapshot.revision), '--idempotency-key', `${active().prefix}-${command}`,
    ...connection(), ...(value === undefined ? [] : ['--input', input])];
  const preview = document(await cli().run(args), `spaces ${command} preview`) as { state: string; preview: { can_apply: boolean } };
  expect(preview).toMatchObject({ state: 'preview', preview: { can_apply: true } });
  const accepted = document(await cli().run([...args, '--apply']), `spaces ${command}`) as { operation: Operation };
  const done = await waitOperation(accepted.operation.id);
  const repeated = document(await cli().run([...args, '--apply']), `spaces ${command} repeat`) as { operation: Operation };
  expect(repeated.operation.id).toBe(done.id);
  operations.push({ command, id: done.id, status: done.status });
  expect((await inventory()).operations.some(row => row.id === done.id && row.status === 'succeeded')).toBe(true);
  return done;
}
async function startOwnedAgent(): Promise<void> {
  const accepted = await active().page.evaluate(async target => {
    const auth = await (await fetch('/v3/auth/session', { credentials: 'same-origin' })).json() as { csrf_token: string };
    const snapshot = await (await fetch('/v3/console/config', { credentials: 'same-origin', cache: 'no-store' })).json() as { revision: number };
    const body = { kind: 'start', target: { resource: 'agent', tenant_id: target.tenant, alias: target.alias },
      expected_revision: snapshot.revision, idempotency_key: target.key, parameters: {} };
    const post = (path: string) => fetch(path, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': auth.csrf_token }, body: JSON.stringify(body) });
    const preview = await post('/v3/console/fleet/operations/preview');
    if (preview.status !== 200 || !(await preview.json() as { can_apply: boolean }).can_apply) throw new Error('owned agent start preview rejected');
    const response = await post('/v3/console/fleet/operations');
    if (response.status !== 202) throw new Error('owned agent start was not accepted');
    return await response.json() as { operation_id: string };
  }, { tenant: active().tenantId, alias, key: `${active().prefix}-start-after-stop` });
  const done = await waitOperation(accepted.operation_id);
  operations.push({ command: 'start-after-stop', id: done.id, status: done.status });
}
async function observeRuntime(): Promise<Observation> {
  const name = `${active().prefix}-${runtimeKey}`;
  const present = await docker(['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^/${name}$`]);
  if (!present) return { running: false, labels: {}, credentials: null, processes: [], runtime_processes: 0, native_session_present: false };
  const running = await docker(['inspect', '--format', '{{.State.Running}}', name]) === 'true';
  const labels = JSON.parse(await docker(['inspect', '--format', '{{json .Config.Labels}}', name])) as Record<string, string>;
  if (!running) return { running, labels, credentials: null, processes: [], runtime_processes: 0, native_session_present: null };
  const probe = `import json,os,pathlib,stat,subprocess,sys
processes=[];runtime_processes=0
for pid in filter(str.isdigit,os.listdir('/proc')):
 try:
  env=dict(part.decode(errors='replace').split('=',1) for part in pathlib.Path('/proc',pid,'environ').read_bytes().split(bytes([0])) if b'=' in part)
  if env.get('CAUCE_RUNTIME_KEY')!=sys.argv[1]: continue
  runtime_processes+=1
  argv=pathlib.Path('/proc',pid,'cmdline').read_bytes().decode(errors='replace').split(chr(0))
  if env.get('CAUCE_RUNTIME_KEY')==sys.argv[1] and any(arg.endswith('/adapter/src/bin/codex.js') for arg in argv):
   processes.append({'model':env.get('CAUCE_MODEL_ID'),'effort':env.get('CAUCE_REASONING_EFFORT'),'bootstrap':env.get('CAUCE_BOOTSTRAP')})
 except OSError: pass
socket=pathlib.Path(sys.argv[2])/('tmux-'+str(os.getuid()))/'cauce'
target='cauce-'+sys.argv[1]
try: details=socket.lstat()
except FileNotFoundError: native_present=False
else:
 if not stat.S_ISSOCK(details.st_mode) or details.st_uid!=os.getuid(): raise SystemExit('canonical native socket identity failed')
 native=subprocess.run(['/usr/bin/tmux','-S',str(socket),'has-session','-t','='+target],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,timeout=5)
 absent={"can't find session: "+target+'\\n','no server running on '+str(socket)+'\\n'}
 if native.returncode==0: native_present=True
 elif native.returncode==1 and native.stderr in absent: native_present=False
 else: raise SystemExit('canonical native session observation failed')
print(json.dumps({'credentials':(pathlib.Path('/run/cauce-credentials')/sys.argv[1]).exists(),'processes':processes,'runtime_processes':runtime_processes,'native_session_present':native_present}))`;
  const observed = JSON.parse(await docker(['exec', '--user', COMPUTER_RUNTIME.user, name, 'python3', '-B', '-c', probe,
    runtimeKey, `${COMPUTER_RUNTIME.stateRoot}/${runtimeKey}`])) as
    Pick<Observation, 'processes' | 'credentials' | 'runtime_processes' | 'native_session_present'>;
  return { running, labels, ...observed };
}
async function assertTerminalReleased(checkTmux = true): Promise<void> {
  await expect.poll(async () => {
    const result = await active().computer.pool.query<{ sessions: number; holds: number }>(`SELECT
      (SELECT count(*)::int FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 AND closed_at IS NULL AND revoked_at IS NULL) AS sessions,
      (SELECT count(*)::int FROM terminal_control_holds WHERE tenant_id=$1 AND alias=$2 AND released_at IS NULL) AS holds`, [active().tenantId, alias]);
    return result.rows[0];
  }, { timeout: 15_000 }).toEqual({ sessions: 0, holds: 0 });
  if (checkTmux) expect((await active().probeTmux(alias)).clients).toBe(0);
}
async function observeNeighbor(create = false): Promise<{ pane: string; pid: number; starttime: string }> {
  if (!runtime) throw new Error('the neighbor canary needs an observed owned runtime');
  const script = `import json,os,pathlib,subprocess,sys
socket,name,create=sys.argv[1:4]
def tmux(*args): return subprocess.check_output(['/usr/bin/tmux','-S',socket,*args],text=True).strip()
if create=='1': tmux('new-session','-d','-s',name,'-n','canary','/usr/bin/sleep','600')
pane,pid,dead=tmux('display-message','-p','-t',name+':canary','#{pane_id} #{pane_pid} #{pane_dead}').split()
if dead!='0': raise SystemExit('the independent neighbor canary is not alive')
raw=pathlib.Path('/proc',pid,'stat').read_text();fields=raw[raw.rindex(')')+2:].split()
if fields[0] in {'Z','X'}: raise SystemExit('the independent neighbor canary exited')
print(json.dumps({'pane':pane,'pid':int(pid),'starttime':fields[19]}))`;
  return JSON.parse(await docker(['exec', '--user', COMPUTER_RUNTIME.user, runtime.id, 'python3', '-B', '-c', script,
    `${runtime.stateDirectory}/tmux-${String(runtime.uid)}/cauce`, `zz-canary-neighbor-${active().run}`, create ? '1' : '0'])) as
    { pane: string; pid: number; starttime: string };
}
async function waitTerminalPresence(): Promise<boolean> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (active().registry.state(active().tenantId, alias) === 'online') return true;
    await new Promise<void>(resolve => { setTimeout(resolve, 300); });
  }
  return false;
}
async function discardPrivateInstallation(): Promise<void> {
  if (!installationDirectory) return;
  const restoreDirectoryWrite = async (directory: string): Promise<void> => {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) return;
    await chmod(directory, (details.mode & 0o777) | 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await restoreDirectoryWrite(join(directory, entry.name));
    }
  };
  await restoreDirectoryWrite(installationDirectory);
  await rm(installationDirectory, { recursive: true, force: true });
}

beforeAll(async () => {
  installationDirectory = await mkdtemp(join(tmpdir(), 'cauce-cli-candidate-'));
  installed = await buildInstalledCli(installationDirectory);
  await mkdir(fleetCliReceipts, { recursive: true, mode: 0o700 });
  await copyFile(installed.manifestFile, join(fleetCliReceipts, 'installed-candidate-manifest.json'));
  await writeFile(join(fleetCliReceipts, 'provider-limit.json'), JSON.stringify(FLEET_CLI_PROVIDER_FIXTURE, null, 2));
  fixture = await startFleetCliFixture({ candidateSource: installed.source });
  const hostRelease = JSON.parse(await readFile(join(dirname(fixture.computer.installRoot), 'host-release/host-release.json'), 'utf8')) as
    { revision: string; release: { sha256: string } };
  await receipt('00-source-provenance', { source_revision: installed.revision, packaged_revision: hostRelease.revision,
    metadata_matches_source: hostRelease.revision === installed.revision, host_release_sha256: hostRelease.release.sha256,
    archived_candidate: ['installed_cli', 'compiled_cli_runtime', 'agent_sdk', 'executor_ops', 'executor_gateway'],
    working_tree: ['http_gateways', 'database_store', 'console', 'terminal_relay', 'test_infrastructure'] });
}, 1_500_000);
afterAll(async () => {
  try { await fixture?.close(); }
  finally { await discardPrivateInstallation(); }
}, 180_000);

describe.sequential('release instalada, dispositivo y terminal CLI de un ordenador enrolado', () => {
  it('instala desde la release candidata y aprueba el login por dispositivo en Chromium real', async () => {
    expect(relative(process.cwd(), cli().home).startsWith('..')).toBe(true);
    expect((await stat(cli().home)).mode & 0o777).toBe(0o700);
    const login = cli().start(['login', '--dispositivo', ...connection()]);
    try {
      await login.waitFor(/Código: [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/u, 30_000);
      const code = /Código: ([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})/u.exec(login.stderr)?.[1];
      if (!code) throw new Error('installed CLI did not expose a verification code to its private terminal');
      await active().page.goto(`${active().baseUrl}/dispositivo?code=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded' });
      await active().page.getByRole('region', { name: 'Solicitud de acceso', exact: true }).waitFor({ timeout: 30_000 });
      const capture = { path: join(active().receipts, '01-dispositivo-escritorio.png'), fullPage: true,
        mask: [active().page.locator('#device-user-code')] };
      await active().page.screenshot(capture);
      await active().page.setViewportSize({ width: 390, height: 844 });
      await active().page.screenshot({ ...capture, path: join(active().receipts, '01-dispositivo-movil.png') });
      await active().page.setViewportSize({ width: 1440, height: 900 });
      await active().page.getByRole('button', { name: 'Autorizar', exact: true }).click();
      const logged = document(await login.result, 'installed device login') as { subject: string };
      expect(logged.subject).toBe(active().owner.email);
    } finally { await login.stop(); }
    expect((await stat(cli().sessionFile)).mode & 0o777).toBe(0o600);
    const status = document(await cli().run(['login', '--status', ...connection()]), 'installed login status') as
      { authenticated: boolean; subject: string; authority: { acting_company: string } };
    expect(status).toMatchObject({ authenticated: true, subject: active().owner.email,
      authority: { acting_company: active().owner.company.slug } });
    await receipt('01-installed-login', { revision: cli().revision, installed_from_archive: true, runtime_from_same_revision: true,
      outside_checkout: true, private_home: true, private_session: true, nominal_identity: true });
  });

  it('crea y lista un espacio con efecto durable y físico en el ordenador enrolado', async () => {
    await change('create', parameters());
    expect((await inventory()).agents.some(row => row.alias === alias)).toBe(true);
    const observed = await observeRuntime();
    expect(observed.running).toBe(true); expect(observed.credentials).toBe(true);
    expect(observed.processes.length).toBeGreaterThan(0);
    expect(observed.labels).toMatchObject({ 'cauce.fleet.alias': alias, 'cauce.fleet.host': active().hostId,
      'cauce.fleet.tenant': active().tenantId, 'cauce.fleet.runtime_key': runtimeKey });
    const files = JSON.parse(await docker(['exec', '--user', COMPUTER_RUNTIME.user, `${active().prefix}-${runtimeKey}`, 'python3', '-B', '-c',
      'import json,pathlib,sys;p=pathlib.Path(sys.argv[1]);project=p/"space/projects";assert p.is_dir() and (p/"space").is_dir() and project.is_dir(),"fleet did not create the space";(project/"l2-cli-state").write_text(sys.argv[2]);print(json.dumps({"space":(p/"space").is_dir(),"persistent_marker":(project/"l2-cli-state").is_file()}))',
      `${COMPUTER_RUNTIME.stateRoot}/${runtimeKey}`, marker])) as unknown;
    expect(files).toMatchObject({ space: true, persistent_marker: true });
    const state = (await active().computer.pool.query('SELECT enabled,lifecycle_state,host_id FROM agents WHERE tenant_id=$1 AND alias=$2', [active().tenantId, alias])).rows[0] as unknown;
    expect(state).toMatchObject({ enabled: true, lifecycle_state: 'ready', host_id: active().hostId });
    await receipt('02-spaces-create-list', { operations, disk: files, runtime: observed });
  }, 300_000);


  it('cauce alias escribe por relay y se reengancha a la misma TUI sin clientes ni controles huérfanos', async () => {
    runtime = await active().prepareTerminal(alias);
    const present = await waitTerminalPresence();
    const targets = await apiGet(active().page, '/v3/console/terminal/targets');
    expect(targets.status).toBe(200);
    await receipt('04-target', { items: (targets.body.items as { alias: string }[]).filter(item => item.alias === alias) });
    const first = await cli().run(terminal(), { input: `REMEMBER ${marker}\r`, detachWhen: `STORED:${marker}`, timeout: 60_000 });
    await receipt('04-terminal-attempt', { code: first.code, pty_state: active().registry.state(active().tenantId, alias),
      presence_wait_ms: 45_000, presence_observed: present, physical_runtime: runtime,
      diagnostics: cliDiagnostics(first) });
    successful(first, 'first installed terminal attach');
    const before = await active().probeTmux(alias);
    expect(first.stdout.includes(`STORED:${marker}`)).toBe(true);
    await assertTerminalReleased();
    const between = await active().probeTmux(alias);
    const second = await cli().run(terminal(), { input: 'RECALL\r', detachWhen: `RECALLED:${marker}`, timeout: 60_000 });
    successful(second, 'second installed terminal attach');
    expect(second.stdout.includes(`RECALLED:${marker}`)).toBe(true);
    await assertTerminalReleased();
    const after = await active().probeTmux(alias);
    expect(between.panePid).toBe(before.panePid); expect(after.panePid).toBe(before.panePid);
    expect(between.nativeId).toBe(before.nativeId); expect(after.nativeId).toBe(before.nativeId);
    const sessions = (await active().computer.pool.query<{ operator_id: string; mode: string; container: string }>(
      'SELECT operator_id,mode,container FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 ORDER BY issued_at', [active().tenantId, alias])).rows;
    expect(sessions).toHaveLength(2);
    expect(sessions.every(row => row.operator_id === active().owner.email && row.mode === 'harness_rw' && row.container === runtime?.id)).toBe(true);
    await receipt('04-reattach', { same_pane_pid: true, same_native_session: true, remembered_marker: true, clients: after.clients,
      nominal_person: true, control_released: true, runtime, sessions: sessions.length });
  }, 180_000);

  it('explica alias inexistente o ajeno y sesión caducada sin conceder un terminal', async () => {
    const absent = await cli().run([`absent${active().run}`, ...connection()]);
    expect(absent.code).toBe(1); expect(absent.stderr).toMatch(/El alias no figura en el inventario visible/iu);
    const slug = `zz-cli-other-${active().run}`;
    const password = `synthetic-other-${randomBytes(16).toString('hex')}`;
    const registration = await active().gateway.inject({ method: 'POST', url: '/v3/auth/register', headers: { origin: active().baseUrl },
      payload: { email: `${slug}@example.invalid`, name: slug, password, company: { name: slug, slug } } });
    expect(registration.statusCode).toBe(201);
    const foreign = registration.json<{ hub: { id: string }; user: { username: string } }>();
    const hidden = await cli().run([`${foreign.hub.id}/${foreign.user.username}`, ...connection()]);
    expect(hidden.code).toBe(1); expect(hidden.stderr).toMatch(/El alias no figura en el inventario visible/iu);
    active().advanceClock(9 * 60 * 60_000);
    try {
      const expired = await cli().run(terminal());
      expect(expired.code).toBe(1); expect(expired.stderr).toMatch(/sesión|sesion|cauce login/iu);
    } finally { active().resetClock(); }
    await assertTerminalReleased(false);
    await receipt('05-access-errors', { absent_denied: true, foreign_existing_alias_denied: true, expired_denied: true });
  }, 90_000);

  it('explica un ordenador sin conexión partiendo de una terminal funcional', async () => {
    runtime = await active().runtimeFor(alias);
    expect(await waitTerminalPresence(), 'computer outage needs a working terminal before the fault').toBe(true);
    const baseline = await cli().run(terminal(), { input: 'RECALL\r', detachWhen: `RECALLED:${marker}`, timeout: 60_000 });
    successful(baseline, 'terminal before owned computer outage');
    const faultDomain = [active().computer.container, runtime.id];
    try {
      await docker(['pause', ...faultDomain]);
      await expect.poll(() => active().registry.state(active().tenantId, alias), { timeout: 90_000 }).not.toBe('online');
      const offline = await cli().run(terminal());
      expect(offline.code).toBe(1); expect(offline.stderr).toMatch(/terminal.*no está conectada/iu);
      for (const container of faultDomain) expect(await docker(['inspect', '--format', '{{.State.Paused}}', container])).toBe('true');
    } finally {
      for (const container of faultDomain) {
        if (await docker(['inspect', '--format', '{{.State.Paused}}', container]) === 'true') await docker(['unpause', container]);
      }
    }
    await expect.poll(() => active().registry.state(active().tenantId, alias), { timeout: 60_000 }).toBe('online');
    const recovered = await cli().run(terminal(), { input: 'RECALL\r', detachWhen: `RECALLED:${marker}`, timeout: 60_000 });
    successful(recovered, 'terminal after owned computer recovery');
    await assertTerminalReleased();
    await receipt('06-computer-outage', { baseline_online: true, virtual_computer_fault_domain: 'computer_and_its_sibling_runtime',
      heartbeat_lost: true, offline_message: true, reconnected_without_reprovisioning: true });
  }, 300_000);

  it('explica agente detenido y recupera su terminal con el inicio autorizado', async () => {
    const original = await active().probeTmux(alias);
    const previous = await active().runtimeFor(alias);
    await docker(['stop', '--time', '10', previous.id]);
    expect(await docker(['inspect', '--format', '{{.State.Running}}', previous.id])).toBe('false');
    await expect.poll(() => active().registry.state(active().tenantId, alias), { timeout: 15_000 }).not.toBe('online');
    const stoppedCli = await cli().run(terminal());
    expect(stoppedCli.code).toBe(1); expect(stoppedCli.stderr).toMatch(/terminal.*no está conectada/iu);
    await startOwnedAgent();
    runtime = await active().runtimeFor(alias);
    await active().resumeTerminal(alias, marker);
    const restarted = await active().probeTmux(alias);
    expect(restarted.nativeId).toBe(original.nativeId);
    expect(await waitTerminalPresence(), 'the canonical terminal must reconnect after its agent starts').toBe(true);
    const resumed = await cli().run(terminal(), { input: 'RECALL\r', detachWhen: `RECALLED:${marker}`, timeout: 60_000 });
    successful(resumed, 'terminal after owned agent start');
    await assertTerminalReleased();
    await receipt('07-stopped-and-started', { operations, stopped_message: true,
      server_resume_method: 'explicit_real_sdk_delivery_before_cli_attach', same_conversation_recovered: true });
  }, 300_000);

  it('edita el espacio con configuración aplicada al proceso y persistida en la BD', async () => {
    const previous = await active().probeTmux(alias);
    neighbor = await observeNeighbor(true);
    await change('edit', { ...parameters(), model_id: 'gpt-5.5', reasoning_effort: 'high', display_name: 'Terminal CLI editada' });
    const observed = await observeRuntime();
    await receipt('03-runtime-observation', { ...observed, runtime_diagnostic: await active().runtimeDiagnostic(alias) });
    expect(observed.processes.length).toBeGreaterThan(0);
    expect(observed.processes.every(process => process.model === 'gpt-5.5' && process.effort === 'high' && process.bootstrap === '0')).toBe(true);
    const row = (await active().computer.pool.query('SELECT model_id,reasoning_effort,display_name FROM agents WHERE tenant_id=$1 AND alias=$2', [active().tenantId, alias])).rows[0] as unknown;
    expect(row).toMatchObject({ model_id: 'gpt-5.5', reasoning_effort: 'high', display_name: 'Terminal CLI editada' });
    const kept = await docker(['exec', '--user', COMPUTER_RUNTIME.user, `${active().prefix}-${runtimeKey}`, 'python3', '-B', '-c',
      'import pathlib,sys;print((pathlib.Path(sys.argv[1])/"space/projects/l2-cli-state").read_text()==sys.argv[2])',
      `${COMPUTER_RUNTIME.stateRoot}/${runtimeKey}`, marker]);
    expect(kept.trim()).toBe('True');
    await active().resumeTerminal(alias, marker);
    expect((await active().probeTmux(alias)).nativeId).toBe(previous.nativeId);
    const resumed = await cli().run(terminal(), { input: 'RECALL\r', detachWhen: `RECALLED:${marker}`, timeout: 60_000 });
    successful(resumed, 'terminal after owned agent edit');
    await assertTerminalReleased();
    expect(await observeNeighbor()).toEqual(neighbor);
    await receipt('03-spaces-edit', { operations, runtime: observed, database: row,
      persistent_disk_marker_preserved: true, same_native_conversation: true, independent_neighbor_preserved: true });
  }, 300_000);


  it('retira el espacio sin ejecución residual y con efecto durable', async () => {
    await change('retire');
    const state = (await active().computer.pool.query('SELECT enabled,lifecycle_state,retired_at IS NOT NULL AS retired FROM agents WHERE tenant_id=$1 AND alias=$2', [active().tenantId, alias])).rows[0] as unknown;
    expect(state).toEqual({ enabled: false, lifecycle_state: 'retired', retired: true });
    const observed = await observeRuntime();
    await receipt('07-retire', { operations, database: state, runtime: observed });
    expect(observed.processes).toEqual([]);
    expect(observed.runtime_processes).toBe(0);
    if (observed.running) expect(observed.native_session_present).toBe(false);
    if (observed.running) expect(observed.credentials).toBe(false);
    if (neighbor) expect(await observeNeighbor()).toEqual(neighbor);
  }, 360_000);

  it('rechaza la sesión nominal revocada por cambio de contraseña mediante la API del dueño', async () => {
    const people = await apiGet(active().page, '/v3/console/people');
    expect(people.status).toBe(200);
    const rows = people.body.items as { id: string; email: string; revision: string }[];
    const owner = rows.find(row => row.email === active().owner.email);
    if (!owner) throw new Error('nominal owner absent from its company people API');
    const status = await active().page.evaluate(async value => {
      const state = await (await fetch('/v3/auth/session')).json() as { csrf_token: string };
      return (await fetch(`/v3/console/people/${encodeURIComponent(value.id)}`, { method: 'PATCH', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf_token },
        body: JSON.stringify({ expected_revision: value.revision, password: value.password }) })).status;
    }, { id: owner.id, revision: owner.revision, password: `synthetic-revocation-${randomBytes(20).toString('hex')}` });
    expect(status).toBe(200);
    const revoked = await cli().run(terminal());
    expect(revoked.code).toBe(1); expect(revoked.stderr).toMatch(/sesión|sesion|cauce login/iu);
    await receipt('08-revoked-session', { password_change_via_company_api: true, stale_cli_cookie_rejected: true });
  }, 60_000);
});
