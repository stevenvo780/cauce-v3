import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { type ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { TMUX_SOCKET } from '../../packages/adapter-sdk/src/shared-session/types.js';
import { createFleetCliRuntimeBundle, FLEET_CLI_PROVIDER_FIXTURE } from './v4-cli-flota-dinamica.runtime.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';
import { apiGet } from './v4-console-real-browser.helpers.js';
import { connection, observeBrowserErrors, released, type PtyFleetCli } from './v4-pty-flota-dinamica.client.js';
import { observePtyFleet, ptyFleetAlias, ptyFleetRuntimeKey } from './v4-pty-flota-dinamica.flow.js';
import { capturePtyFleet, ptyFleetReceipt, type PtyFleetFixture } from './v4-pty-flota-dinamica.helpers.js';

export const ptyFleetTuiRuntime: ComputerRuntimeBundle = { ...cancelDeployRuntime, sharedTui: true,
  providerCli: createFleetCliRuntimeBundle(process.cwd()).providerCli };

export async function capturePtyFleetTuiDiagnostics(fixture: PtyFleetFixture, phase: string): Promise<void> {
  try {
    const row = (await fixture.computer.pool.query<{ state_directory: string; runtime_user: string }>(
      'SELECT state_directory,runtime_user FROM agents WHERE tenant_id=$1 AND alias=$2', [fixture.tenantId, ptyFleetAlias])).rows[0];
    const physical = await observePtyFleet(fixture);
    if (!row || !physical.sdk.container_id) { await ptyFleetReceipt(phase + '-tui-diagnostics', { runtime_absent: true }); return; }
    const script = `import json,os,pathlib,stat,subprocess,sys
key,state,socket_name=sys.argv[1:];stage='socket';result={'uid':os.getuid(),'tmux_binary_exists':os.access('/usr/bin/tmux',os.X_OK)}
sys.excepthook=lambda kind,error,trace: print(json.dumps({'error_stage':stage,'error_type':kind.__name__,'errno':getattr(error,'errno',None)}))
socket=pathlib.Path(state)/('tmux-'+str(os.getuid()))/socket_name
try: info=socket.lstat()
except FileNotFoundError: result['socket_exists']=False
else:
 result.update(socket_exists=True,socket_is_socket=stat.S_ISSOCK(info.st_mode),socket_uid=info.st_uid,socket_mode=stat.S_IMODE(info.st_mode),socket_inode=info.st_ino)
 if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=os.getuid():raise ValueError('invalid scoped tmux socket')
 stage='tmux_windows'
 command=subprocess.run(['/usr/bin/tmux','-S',str(socket),'list-windows','-t','=cauce-'+key,'-F',
  '#{session_name}|#{window_name}|#{window_panes}|#{@cauce_alias}|#{@cauce_harness}|#{pane_id}|#{pane_pid}|#{pane_dead}|#{pane_current_path}'],capture_output=True,text=True,timeout=5)
 result['tmux_exit_code']=command.returncode;result['windows']=[]
 if command.returncode==0:
  if len(command.stdout)>65536:raise ValueError('tmux metadata exceeds its bound')
  for line in command.stdout.splitlines():
   fields=line.split('|')
   if len(fields)!=9:raise ValueError('tmux metadata shape differs')
   session,window,panes,alias,harness,pane,pid,dead,cwd=fields
   observed={'session_matches':session=='cauce-'+key,'window_matches':window=='agente','panes':int(panes),
    'alias_matches':alias==key,'harness_matches':harness=='codex','pane':pane,'pid':int(pid),'dead':dead=='1','cwd_matches':cwd==state+'/space/projects'}
   stage='pane_process';proc=pathlib.Path('/proc')/pid
   try:
    values=(proc/'stat').read_text().rsplit(')',1)[1].split();observed.update(starttime=int(values[19]),process_state=values[0],process_uid=proc.stat().st_uid)
   except FileNotFoundError:observed['process_absent']=True
   result['windows'].append(observed)
print(json.dumps(result))`;
    const logScript = `import json,os,pathlib,re,stat,sys
result={};stage='sdk_log'
sys.excepthook=lambda kind,error,trace: print(json.dumps({'error_stage':stage,'error_type':kind.__name__,'errno':getattr(error,'errno',None)}))
try:fd=os.open(pathlib.Path(sys.argv[1])/'.cauce-adapter.log',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
except FileNotFoundError:result['log_absent']=True
else:
 try:
  info=os.fstat(fd);assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and not info.st_mode&63
  os.lseek(fd,max(0,info.st_size-262144),os.SEEK_SET);raw=os.read(fd,262144).decode(errors='replace')
 finally:os.close(fd)
 result={'log_observed':True,'codes':sorted(set(re.findall(r'(?m)^(AGENT_DISABLED|SHARED_TUI_UNAVAILABLE|ADAPTER_FATAL|LEASE_CONFLICT|BOOTSTRAP_FAILED)(?=:|$)',raw))),
  'disabled_gate_mentioned':'AGENT_DISABLED' in raw or 'agent_disabled' in raw,'shared_degraded_event':'"shared_session_degraded"' in raw}
print(json.dumps(result))`;
    const results = await Promise.all([
      fixture.computer.onComputer(['docker', 'exec', '--user', row.runtime_user, physical.sdk.container_id, 'python3', '-I', '-B', '-c',
        script, ptyFleetRuntimeKey, row.state_directory, TMUX_SOCKET]),
      fixture.computer.onComputer(['docker', 'exec', '--user', '0', physical.sdk.container_id, 'python3', '-I', '-B', '-c', logScript, row.state_directory]),
    ]);
    const [tmux, sdkLog] = results.map(result => ({ exit_code: result.code, observation: result.stdout.trim()
      ? JSON.parse(result.stdout) as unknown : { unavailable: true } }));
    await ptyFleetReceipt(phase + '-tui-diagnostics', { sdk: physical.sdk, tmux, sdk_log: sdkLog });
  } catch {
    await ptyFleetReceipt(phase + '-tui-diagnostics', { observation_unavailable: true });
  }
}

interface PaneObservation {
  container_id: string;
  pane: string; pid: number; starttime: number; native_id: string; clients: number; socket_inode: number;
  markers: string[]; transcript_sha256: string; capture_contains_marker: boolean; memory_matches_marker: boolean;
  shared: { CAUCE_SHARED_SESSION: string; TMUX_TMPDIR: string; CAUCE_SHARED_SESSION_WORKSPACE: string };
}

async function paneObservation(fixture: PtyFleetFixture, marker = ''): Promise<PaneObservation> {
  const row = (await fixture.computer.pool.query<{ state_directory: string; runtime_user: string; container_name: string }>(
    'SELECT state_directory,runtime_user,container_name FROM agents WHERE tenant_id=$1 AND alias=$2',
    [fixture.tenantId, ptyFleetAlias])).rows[0];
  const physical = await observePtyFleet(fixture);
  if (!row || !physical.sdk.container_id || !physical.sdk.metadata) throw new Error('the shared TUI has no observed normal runtime');
  const script = `import hashlib,json,os,pathlib,re,stat,subprocess,sys
key,state,socket_name,pid,starttime,marker=sys.argv[1:]
root=pathlib.Path(state);socket=root/('tmux-'+str(os.getuid()))/socket_name
info=socket.stat()
assert stat.S_ISSOCK(info.st_mode) and info.st_uid==os.getuid()
proc=pathlib.Path('/proc')/pid
def process():
 fields=(proc/'stat').read_text().rsplit(')',1)[1].split()
 assert fields[0] not in ('Z','X') and int(fields[19])==int(starttime) and proc.stat().st_uid==os.getuid()
process()
wanted=('CAUCE_SHARED_SESSION','TMUX_TMPDIR','CAUCE_SHARED_SESSION_WORKSPACE','CODEX_HOME')
parts=[part.split(b'=',1) for part in (proc/'environ').read_bytes().split(bytes([0])) if part]
assert all(len(part)==2 for part in parts)
assert all(sum(part[0]==name.encode() for part in parts)==1 for name in wanted)
env={name:next(value.decode() for field,value in parts if field==name.encode()) for name in wanted}
process()
def tmux(*args):return subprocess.check_output(['/usr/bin/tmux','-S',str(socket),*args],text=True,timeout=5).strip()
target='cauce-'+key+':agente'
markers=tmux('display-message','-p','-t',target,'#{@cauce_alias}|#{@cauce_harness}|#{window_name}|#{pane_dead}|#{pane_current_path}').split('|')
pane,pane_pid=tmux('display-message','-p','-t',target,'#{pane_id}|#{pane_pid}').split('|')
pane_proc=pathlib.Path('/proc')/pane_pid;before=(pane_proc/'stat').read_text().rsplit(')',1)[1].split()
assert before[0] not in ('Z','X') and pane_proc.stat().st_uid==os.getuid()
home=pathlib.Path(env['CODEX_HOME']);files=list((home/'sessions').glob('rollout-cli-*.jsonl'))
assert len(files)==1
with files[0].open() as stream:first=json.loads(stream.readline())
native=first['payload']['id'];assert first['type']=='session_meta' and re.fullmatch(r'[a-f0-9-]{36}',native)
memory=home/('cli-memory-'+native+'.json')
remembered=json.loads(memory.read_text()).get('marker') if memory.exists() else None
capture=tmux('capture-pane','-p','-S','-100','-t',target)
after=(pane_proc/'stat').read_text().rsplit(')',1)[1].split()
assert before[19]==after[19] and after[0] not in ('Z','X')
print(json.dumps({'pane':pane,'pid':int(pane_pid),'starttime':int(after[19]),'native_id':native,
 'clients':int(tmux('display-message','-p','-t',target,'#{session_attached}')),'socket_inode':info.st_ino,
 'markers':markers,'shared':{name:env[name] for name in wanted if name!='CODEX_HOME'},
 'transcript_sha256':hashlib.sha256(files[0].read_bytes()).hexdigest(),
 'capture_contains_marker':bool(marker) and marker in capture,'memory_matches_marker':bool(marker) and remembered==marker}))`;
  const result = await fixture.computer.onComputer(['docker', 'exec', '--user', row.runtime_user, physical.sdk.container_id,
    'python3', '-I', '-B', '-c', script, ptyFleetRuntimeKey, row.state_directory, TMUX_SOCKET,
    String(physical.sdk.metadata.pid), String(physical.sdk.metadata.starttime), marker]);
  expect(result.code, 'the canonical shared TUI could not be observed').toBe(0);
  const observed = JSON.parse(result.stdout) as PaneObservation;
  expect(observed.markers).toEqual([ptyFleetRuntimeKey, 'codex', 'agente', '0', row.state_directory + '/space/projects']);
  expect(observed.shared).toEqual({ CAUCE_SHARED_SESSION: '1', TMUX_TMPDIR: row.state_directory,
    CAUCE_SHARED_SESSION_WORKSPACE: row.state_directory + '/space/projects' });
  return { ...observed, container_id: physical.sdk.container_id };
}

function samePane(actual: PaneObservation, previous: PaneObservation): void {
  expect(actual.container_id).toBe(previous.container_id);
  expect(actual.pane).toBe(previous.pane); expect(actual.pid).toBe(previous.pid); expect(actual.starttime).toBe(previous.starttime);
  expect(actual.native_id).toBe(previous.native_id); expect(actual.socket_inode).toBe(previous.socket_inode);
}

export async function waitPtyFleetTuiModes(fixture: PtyFleetFixture): Promise<{
  tenant_id: string; alias: string; modes: string[]; writable_modes?: string[];
}> {
  let target: { tenant_id: string; alias: string; modes: string[]; writable_modes?: string[] } | undefined;
  await expect.poll(async () => {
    const targets = await apiGet(fixture.page, '/v3/console/terminal/targets');
    expect(targets.status).toBe(200);
    target = (targets.body.items as NonNullable<typeof target>[])
      .find(item => item.tenant_id === fixture.tenantId && item.alias === ptyFleetAlias);
    return ['shell', 'harness', 'harness_rw'].every(mode => target?.modes.includes(mode)) && target?.writable_modes?.includes('harness_rw');
  }, { timeout: 30_000, interval: 300 }).toBe(true);
  expect(target?.modes).toEqual(expect.arrayContaining(['shell', 'harness', 'harness_rw']));
  expect(target?.writable_modes).toContain('harness_rw');
  if (!target) throw new Error('the announced canonical TUI target is unavailable');
  return target;
}

export async function usePtyFleetTui(fixture: PtyFleetFixture, cli: PtyFleetCli, phase: string,
  previous?: { marker: string; nativeId: string }): Promise<{ marker: string; nativeId: string }> {
  const target = await waitPtyFleetTuiModes(fixture);
  const known = new Set((await fixture.computer.pool.query<{ id: string }>(
    "SELECT id FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 AND mode IN ('harness','harness_rw')",
    [fixture.tenantId, ptyFleetAlias])).rows.map(row => row.id));
  const before = await paneObservation(fixture, previous?.marker);
  expect(before.clients).toBe(0);
  if (previous) { expect(before.native_id).toBe(previous.nativeId); expect(before.memory_matches_marker).toBe(true); }
  await fixture.page.goto(fixture.baseUrl + '/terminal/' + encodeURIComponent(fixture.tenantId) + '/' + ptyFleetAlias + '?modo=tui',
    { waitUntil: 'domcontentloaded' });
  await observeBrowserErrors(fixture.page);
  const terminal = fixture.page.locator('[data-pty-shell][data-state="open"]');
  await terminal.waitFor({ timeout: 30_000 });
  const control = fixture.page.getByRole('region', { name: 'Control de la TUI', exact: true });
  await control.getByText('Tienes el teclado de esta TUI.', { exact: true }).waitFor({ timeout: 30_000 });
  await control.getByRole('button', { name: 'Devolver el control', exact: true }).click();
  await expect.poll(() => terminal.evaluate(element => element.getAttribute('data-read-only'))).toBe('true');
  await expect.poll(async () => (await fixture.computer.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM terminal_control_holds WHERE tenant_id=$1 AND alias=$2
     AND released_at IS NULL AND expires_at>clock_timestamp()`, [fixture.tenantId, ptyFleetAlias])).rows[0]?.count).toBe('0');
  const input = fixture.page.locator('.xterm-helper-textarea'), readonlyMarker = 'H12-RO-' + randomUUID();
  await input.type(readonlyMarker); await input.press('Enter');
  const readonly = await paneObservation(fixture, readonlyMarker);
  samePane(readonly, before); expect(readonly.capture_contains_marker).toBe(false);
  expect(readonly.transcript_sha256).toBe(before.transcript_sha256);
  await control.getByRole('button', { name: 'Tomar el control', exact: true }).click();
  await control.getByText('Tienes el teclado de esta TUI.', { exact: true }).waitFor({ timeout: 30_000 });
  await expect.poll(() => terminal.evaluate(element => element.getAttribute('data-read-only'))).toBeNull();
  const webSessionId = await fixture.page.locator('[data-session-id]').evaluate(element => element.getAttribute('data-session-id'));
  const webMarker = 'H12-TUI-WEB-' + randomUUID();
  await input.type('REMEMBER ' + webMarker); await input.press('Enter');
  await expect.poll(async () => (await fixture.page.locator('.xterm-rows').innerText()).includes('STORED:' + webMarker),
    { timeout: 20_000 }).toBe(true);
  const web = await paneObservation(fixture, webMarker);
  samePane(web, before); expect(web.memory_matches_marker).toBe(true); expect(web.capture_contains_marker).toBe(true);
  await capturePtyFleet(fixture.page, phase + '-web-tui');
  await control.getByRole('button', { name: 'Devolver el control', exact: true }).click();
  await fixture.page.getByRole('button', { name: 'Más acciones', exact: true }).click();
  await fixture.page.getByRole('menuitem', { name: 'Cerrar sesión PTY', exact: true }).click();
  await released(fixture);
  const previousReaders = new Set((await fixture.computer.pool.query<{ id: string }>(
    "SELECT id FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 AND mode='harness'",
    [fixture.tenantId, ptyFleetAlias])).rows.map(row => row.id));
  const readOnlyCli = await cli.run([ptyFleetAlias, '--tenant', fixture.tenantId, '--mode', 'harness', ...connection(fixture, cli)],
    { detachWhen: 'STORED:' + webMarker });
  expect(readOnlyCli.code).toBe(0); expect(readOnlyCli.stdout).toContain('STORED:' + webMarker);
  await released(fixture);
  const viewed = await paneObservation(fixture, webMarker);
  samePane(viewed, web); expect(viewed.transcript_sha256).toBe(web.transcript_sha256);
  expect(viewed.clients).toBe(0); expect(viewed.memory_matches_marker).toBe(true);
  const readers = (await fixture.computer.pool.query<{ id: string; mode: string; container: string;
    operator_id: string; consumed: boolean; closed: boolean }>(
    `SELECT id,mode,container,operator_id,consumed_at IS NOT NULL AS consumed,(closed_at IS NOT NULL OR revoked_at IS NOT NULL) AS closed
     FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 AND mode='harness'`, [fixture.tenantId, ptyFleetAlias])).rows
    .filter(row => !previousReaders.has(row.id));
  expect(readers).toHaveLength(1);
  expect(readers[0]).toMatchObject({ mode: 'harness', container: before.container_id,
    operator_id: fixture.owner.email, consumed: true, closed: true });
  const args = [ptyFleetAlias, '--tenant', fixture.tenantId, '--mode', 'harness_rw', ...connection(fixture, cli)];
  const recalled = await cli.run(args, { input: 'RECALL\r', detachWhen: 'RECALLED:' + webMarker });
  expect(recalled.code).toBe(0); expect(recalled.stdout).toContain('RECALLED:' + webMarker);
  await released(fixture);
  const marker = 'H12-TUI-CLI-' + randomUUID();
  const written = await cli.run(args, { input: 'REMEMBER ' + marker + '\r', detachWhen: 'STORED:' + marker });
  expect(written.code).toBe(0); expect(written.stdout).toContain('STORED:' + marker);
  await released(fixture);
  const after = await paneObservation(fixture, marker);
  samePane(after, before); expect(after.clients).toBe(0); expect(after.memory_matches_marker).toBe(true);
  expect(after.capture_contains_marker).toBe(true);
  const sessions = (await fixture.computer.pool.query<{ id: string; mode: string; container: string;
    operator_id: string; consumed: boolean; closed: boolean }>(
    `SELECT id,mode,container,operator_id,consumed_at IS NOT NULL AS consumed,(closed_at IS NOT NULL OR revoked_at IS NOT NULL) AS closed
     FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 AND mode IN ('harness','harness_rw') ORDER BY issued_at`,
    [fixture.tenantId, ptyFleetAlias])).rows.filter(row => !known.has(row.id));
  expect(sessions.length).toBeGreaterThanOrEqual(4);
  expect(sessions.every(row => row.operator_id === fixture.owner.email && row.container === before.container_id && row.closed && row.consumed)).toBe(true);
  expect(sessions.some(row => row.id === webSessionId && row.mode === 'harness_rw')).toBe(true);
  expect(sessions.filter(row => row.id !== webSessionId && row.mode === 'harness_rw').length).toBeGreaterThanOrEqual(2);
  await ptyFleetReceipt(phase + '-tui', { provider: FLEET_CLI_PROVIDER_FIXTURE, target, before, readonly, web, viewed, readers, after,
    sessions, readonly_bytes_absent: true, web_canonical_control: true, installed_cli_harness_rw: true,
    installed_cli_harness: true, readonly_cli_no_input: true, same_pane: true, memory_preserved: true, control_released: true });
  await ptyFleetReceipt(phase + '-tui-browser-events', await fixture.page.evaluate(() =>
    (window as Window & { h12BrowserErrors?: Record<string, unknown>[] }).h12BrowserErrors ?? []));
  return { marker, nativeId: after.native_id };
}
