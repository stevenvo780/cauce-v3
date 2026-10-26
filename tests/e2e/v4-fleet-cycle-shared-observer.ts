import { expect } from 'vitest';
import { command, docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';

interface ProviderState { inputBytes: number; submits: number; draftLength: number; pid: number }
export interface SharedCycleObservation {
  available: boolean; reason?: string; phase?: string; runtime?: string; wireAlias?: string;
  mode?: 'no_live_tmux_verified' | 'shared_session'; environment?: Record<string, string | null>;
  tmuxAbsent?: boolean; tmuxProcesses?: { pid: number; comm: string; uid: number; state: string; ppid: number; starttime: number }[];
  adapter?: { pid: number; starttime: number }; session?: string; socket?: string;
  controller?: { pid: number; starttime: number };
  pane?: string; panePid?: number; tmuxDirectory?: string; canonicalRead?: boolean;
  composer?: string; provider?: ProviderState;
  metadataSha256?: string; paneStarttime?: number; tmuxServerPid?: number;
  sourceSha256?: string; socketIdentity?: { uid: number; dev: number; ino: number };
  metadata?: Record<string, unknown>; adapterProcesses?: number[];
  diagnostic?: unknown;
}

const READ = String.raw`import hashlib,json,os,pathlib,pwd,stat,subprocess,sys
sys.path[:0]=['/cauce/lifecycle']
from cauce_container_base import PermanentError,open_control_directory
from cauce_container_proc import matched_fs_credentials,proc_stat,read_metadata,validate_metadata,verify_adapter,verify_controller
from cauce_container_restart import shared_pane,assert_restart_safe,tmux_absent
runtime,wire,idle,tenant,user,diagnostic=sys.argv[1:]
path=pathlib.Path('/run/cauce-fleet')/runtime/'cauce-v3-adapter.json'
def tmux_snapshot():
 processes=[]
 for item in pathlib.Path('/proc').iterdir():
  if not item.name.isdigit():continue
  try:
   name=(item/'comm').read_text().strip()
   if not name.startswith('tmux'):continue
   fields=proc_stat(int(item.name))
   processes.append({'pid':int(item.name),'comm':name,'uid':item.stat().st_uid,'state':fields['state'],
    'ppid':fields['ppid'],'starttime':fields['starttime']})
  except (FileNotFoundError,ProcessLookupError):continue
 return processes
def diagnose(document,pane):
 if pane is None:return {'unavailable':'canonical pane was not constructed'}
 def command(args):
  try:
   result=subprocess.run(['/usr/bin/tmux',*args],capture_output=True,text=True,timeout=4,check=False,
    env=pane.environment,cwd='/',**pane.credentials)
   return {'args':args,'code':result.returncode,'stdout':result.stdout[-8192:],'stderr':result.stderr[-2048:]}
  except (OSError,subprocess.TimeoutExpired) as error:return {'args':args,'error':str(error)}
 sockets=[]
 for root in sorted({document['stateDirectory'],pane.environment.get('TMUX_TMPDIR',document['stateDirectory'])}):
  for candidate in sorted(pathlib.Path(root).glob('tmux-*/*'))[:10]:
   entry=candidate.lstat()
   row={'path':str(candidate),'uid':entry.st_uid,'dev':entry.st_dev,'ino':entry.st_ino,'socket':stat.S_ISSOCK(entry.st_mode)}
   if row['socket']:
    row['sessions']=command(['-N','-S',str(candidate),'list-sessions','-F','#{session_name}|#{@cauce_alias}|#{@cauce_harness}'])
    row['panes']=command(['-N','-S',str(candidate),'list-panes','-a','-F','#{session_name}|#{window_name}|#{pane_id}|#{pane_pid}|#{@cauce_alias}'])
   sockets.append(row)
 physical=[]
 for candidate in (pathlib.Path(document['stateDirectory']),pathlib.Path(document['stateDirectory'])/('tmux-'+str(pane.uid)),
  pathlib.Path(document['stateDirectory'])/('tmux-'+str(pane.uid))/'cauce'):
  try:
   entry=candidate.lstat()
   physical.append({'path':str(candidate),'uid':entry.st_uid,'dev':entry.st_dev,'ino':entry.st_ino,
    'socket':stat.S_ISSOCK(entry.st_mode),'directory':stat.S_ISDIR(entry.st_mode),'symlink':stat.S_ISLNK(entry.st_mode)})
  except OSError as error:physical.append({'path':str(candidate),'error':str(error)})
 processes=tmux_snapshot()
 public={}
 with matched_fs_credentials(pane.uid,pane.gid):
  raw=dict(item.split(b'=',1) for item in pathlib.Path('/proc',str(document['pid']),'environ').read_bytes().split(b'\0') if b'=' in item)
  public={name:raw.get(name.encode(),b'').decode() for name in ('CAUCE_ALIAS','CAUCE_RUNTIME_KEY','CAUCE_BOOTSTRAP',
   'CAUCE_TENANT_ID','CAUCE_STATE_DIR','CAUCE_CONTROL_DIR','TMUX_TMPDIR')}
 calls=[['show-hooks','-g','-t',pane.target],['show-hooks','-t',pane.target],['show-hooks','-w','-t',pane.target],
  ['show-hooks','-p','-t',pane.target],['show-options','-s','command-alias'],
  ['list-panes','-t',pane.target,'-F','#{pane_id}|#{pane_pid}|#{pane_dead}|#{@cauce_input_barrier}|#{pane_input_off}|#{socket_path}'],
  ['capture-pane','-p','-e','-t',pane.target]]
 return {'target':pane.target,'environment':public,'sockets':sockets,'physicalPaths':physical,'tmuxProcesses':processes,
  'metadataSha256':hashlib.sha256(before_bytes).hexdigest(),
  'sourceSha256':hashlib.sha256(pathlib.Path('/cauce/lifecycle/cauce_container_restart.py').read_bytes()).hexdigest(),
  'guardCommands':[command(['-N','-L','cauce',*args]) for args in calls],
  'metadata':{key:document[key] for key in ('alias','wireAlias','tenantId','stateDirectory','controlDirectory','runtimeUid','runtimeGid',
   'pid','starttime','controllerPid','controllerStarttime','containerId','containerGeneration')}}
try:
 if not path.exists():
  account=pwd.getpwnam(user)
  processes=[]
  with matched_fs_credentials(account.pw_uid,account.pw_gid):
   for item in pathlib.Path('/proc').iterdir():
    try:
     if not item.name.isdigit() or item.stat().st_uid!=account.pw_uid:continue
     values=dict(row.split(b'=',1) for row in (item/'environ').read_bytes().split(b'\0') if b'=' in row)
     if values.get(b'CAUCE_RUNTIME_KEY')==runtime.encode():processes.append(int(item.name))
    except (FileNotFoundError,PermissionError,ProcessLookupError):pass
  print(json.dumps({'available':False,'reason':'adapter_absent_verified' if not processes else 'metadata_missing_live_process',
   'adapterProcesses':processes}))
  sys.exit(0)
 control=open_control_directory(str(path.parent))
 before_bytes=path.read_bytes()
 try:document,_=read_metadata(control)
 finally:os.close(control)
 if document is None:raise FileNotFoundError('metadata disappeared')
 if json.loads(before_bytes)!=document:raise FileNotFoundError('metadata changed before canonical read')
 validate_metadata(document)
 if document['phase']!='running':raise FileNotFoundError('adapter is not running')
 assert document['alias']==runtime and document['wireAlias']==wire and document['tenantId']==tenant
 assert document['controlDirectory']==str(path.parent)
 verify_adapter(document,runtime,document['stateDirectory'])
 verify_controller(document)
 process=pathlib.Path('/proc',str(document['pid']))
 with matched_fs_credentials(document['runtimeUid'],document['runtimeGid']):
  adapter=dict(item.split(b'=',1) for item in (process/'environ').read_bytes().split(b'\0') if b'=' in item)
 phase=adapter[b'CAUCE_BOOTSTRAP'].decode()
 assert phase in ('0','1')
 observation={'available':True,'phase':phase,'runtime':runtime,'wireAlias':wire,
  'adapter':{'pid':document['pid'],'starttime':document['starttime']},
  'controller':{'pid':document['controllerPid'],'starttime':document['controllerStarttime']},
  'metadataSha256':hashlib.sha256(before_bytes).hexdigest(),
  'sourceSha256':hashlib.sha256(pathlib.Path('/cauce/lifecycle/cauce_container_restart.py').read_bytes()).hexdigest(),
  'environment':{name:adapter.get(name.encode(),b'').decode() or None for name in
   ('CAUCE_ALIAS','CAUCE_RUNTIME_KEY','CAUCE_BOOTSTRAP','CAUCE_SHARED_SESSION','CAUCE_SHARED_SESSION_WORKSPACE','TMUX_TMPDIR')},
  'metadata':{name:document[name] for name in ('tenantId','alias','wireAlias','containerId','containerGeneration','controlDirectory',
   'stateDirectory','runtimeUid','runtimeGid')}}
 assert observation['environment']['CAUCE_SHARED_SESSION']=='1'
 assert observation['environment']['CAUCE_SHARED_SESSION_WORKSPACE']==document['stateDirectory']+'/space/projects'
 assert observation['environment']['TMUX_TMPDIR']==document['stateDirectory']
 pane=shared_pane(document)
 if pane is None:
  assert tmux_absent()
  tmux_processes=tmux_snapshot()
  assert all(row['state']=='Z' for row in tmux_processes)
  verify_adapter(document,runtime,document['stateDirectory'])
  verify_controller(document)
  if path.read_bytes()!=before_bytes:raise FileNotFoundError('metadata bytes changed during no-live-tmux observation')
  if shared_pane(document) is not None or not tmux_absent():raise FileNotFoundError('live tmux appeared during observation')
  observation.update(mode='no_live_tmux_verified',canonicalRead=False,tmuxAbsent=True,tmuxProcesses=tmux_processes)
  print(json.dumps(observation));sys.exit(0)
 fields=pane.fields()
 composer=pane.run('capture-pane','-p','-e','-t',fields[0])
 if idle=='1':
  pane.read()
  assert_restart_safe(document)
 socket=pane.run('display-message','-p','-t',pane.target,'#{socket_path}').strip()
 temporary=pane.environment.get('TMUX_TMPDIR')
 assert temporary==document['stateDirectory']
 assert socket==str(pathlib.Path(temporary)/('tmux-'+str(pane.uid))/'cauce')
 socket_identity=os.lstat(socket)
 assert stat.S_ISSOCK(socket_identity.st_mode) and socket_identity.st_uid==pane.uid
 with matched_fs_credentials(pane.uid,pane.gid):
  values=dict(item.split(b'=',1) for item in pathlib.Path('/proc',fields[1],'environ').read_bytes().split(b'\0') if b'=' in item)
  profile=pathlib.Path(values[b'CODEX_HOME'].decode())
  provider=json.loads((profile/'s2d-provider-state.json').read_bytes())
 assert provider['pid']==int(fields[1])
 verify_adapter(document,runtime,document['stateDirectory'])
 verify_controller(document)
 if path.read_bytes()!=before_bytes:raise FileNotFoundError('metadata bytes changed during observation')
 observation.update({'mode':'shared_session','session':pane.target,'socket':socket,
  'pane':fields[0],'panePid':int(fields[1]),'tmuxDirectory':temporary,'canonicalRead':idle=='1',
  'composer':composer,'provider':provider,
  'paneStarttime':int(pathlib.Path('/proc',fields[1],'stat').read_text().rsplit(')',1)[1].split()[19]),
  'tmuxServerPid':int(fields[9]),
  'socketIdentity':{'uid':socket_identity.st_uid,'dev':socket_identity.st_dev,'ino':socket_identity.st_ino}})
 print(json.dumps(observation))
except (FileNotFoundError,ProcessLookupError,PermissionError) as error:
 print(json.dumps({'available':False,'reason':type(error).__name__}))
except PermanentError as error:
 detail=None
 if diagnostic=='1':
  try:detail=diagnose(document,locals().get('pane'))
  except Exception as failure:detail={'unavailable':type(failure).__name__,'error':str(failure)}
 print(json.dumps({'available':False,'reason':str(error),'diagnostic':detail}))
`;

const READ_STOPPED_PANE = String.raw`import json,os,pathlib,stat,subprocess,sys
before=json.loads(sys.argv[1])
socket=before['socket']
identity=os.lstat(socket)
assert stat.S_ISSOCK(identity.st_mode)
assert {'uid':identity.st_uid,'dev':identity.st_dev,'ino':identity.st_ino}==before['socketIdentity']
format='#{session_name}|#{pane_id}|#{pane_pid}|#{@cauce_input_barrier}|#{pane_input_off}|#{pid}'
result=subprocess.run(['/usr/bin/tmux','-S',socket,'list-panes','-t',before['session'],'-F',format],
 capture_output=True,text=True,timeout=4,check=True)
rows=result.stdout.splitlines()
assert len(rows)==1
session,pane,pid,barrier,input_off,server=rows[0].split('|')
assert session==before['session'].removeprefix('=').split(':',1)[0]
assert pane==before['pane'] and int(pid)==before['panePid'] and int(server)==before['tmuxServerPid']
assert int(pathlib.Path('/proc',pid,'stat').read_text().rsplit(')',1)[1].split()[19])==before['paneStarttime']
assert barrier=='' and input_off=='0'
print(json.dumps({'session':session,'pane':pane,'panePid':int(pid),'tmuxServerPid':int(server),
 'socket':socket,'socketIdentity':before['socketIdentity'],'inputBarrier':barrier,'paneInputOff':int(input_off)}))
`;

const READ_RESUME_EVIDENCE = String.raw`
import json,os,pathlib
out={'sessions':[],'transcripts':[]}
for root in ('/home','/data','/var/lib'):
  for path in pathlib.Path(root).rglob('*'):
    try:
      if path.name=='sessions.json' and path.is_file():
        out['sessions'].append({'path':str(path),'mode':oct(path.stat().st_mode),'uid':path.stat().st_uid,'body':path.read_text()[:2000]})
      elif path.name.startswith('rollout-') and path.name.endswith('.jsonl'):
        info=path.stat()
        out['transcripts'].append({'path':str(path),'mode':oct(info.st_mode),'uid':info.st_uid,'nlink':info.st_nlink,'head':path.read_text()[:400]})
    except OSError as error:
      out.setdefault('errors',[]).append(str(error))
print(json.dumps(out))
`;

const READ_FAILURE = String.raw`import hashlib,json,os,pathlib,pwd,re,stat,sys
sys.path[:0]=['/cauce/lifecycle']
from cauce_container_proc import matched_fs_credentials
runtime,user=sys.argv[1:]
account=pwd.getpwnam(user)
state=pathlib.Path(account.pw_dir)/'.cauce'/runtime
path=pathlib.Path('/run/cauce-fleet')/runtime/'cauce-v3-adapter.json'
result={'metadataPresent':path.exists(),'processes':[],
 'sourceSha256':hashlib.sha256(pathlib.Path('/cauce/lifecycle/cauce_container_restart.py').read_bytes()).hexdigest()}
if path.exists():
 raw=path.read_bytes();document=json.loads(raw)
 result['metadataSha256']=hashlib.sha256(raw).hexdigest()
 result['metadata']={name:document.get(name) for name in ('phase','alias','wireAlias','tenantId','pid','starttime',
  'controllerPid','controllerStarttime','containerId','containerGeneration','stateDirectory','controlDirectory','runtimeUid','runtimeGid')}
for item in pathlib.Path('/proc').iterdir():
 try:
  if not item.name.isdigit() or item.stat().st_uid!=account.pw_uid:continue
  with matched_fs_credentials(account.pw_uid,account.pw_gid):
   name=(item/'comm').read_text().strip()
   raw=dict(row.split(b'=',1) for row in (item/'environ').read_bytes().split(b'\0') if b'=' in row)
  if raw.get(b'CAUCE_RUNTIME_KEY')!=runtime.encode() and not name.startswith('tmux'):continue
  result['processes'].append({'pid':int(item.name),'comm':name,
   'starttime':int((item/'stat').read_text().rsplit(')',1)[1].split()[19]),
   'environment':{key:raw.get(key.encode(),b'').decode() for key in ('CAUCE_ALIAS','CAUCE_RUNTIME_KEY',
    'CAUCE_BOOTSTRAP','CAUCE_SHARED_SESSION','TMUX_TMPDIR','CODEX_HOME','CAUCE_HARNESS_COMMAND')}})
 except (FileNotFoundError,ProcessLookupError,PermissionError):continue
log=state/'.cauce-adapter.log'
try:
 fd=os.open(log,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  entry=os.fstat(fd)
  if not stat.S_ISREG(entry.st_mode):raise ValueError('runtime log is not regular')
  os.lseek(fd,max(0,entry.st_size-16384),os.SEEK_SET)
  tail=os.read(fd,16384).decode('utf-8','replace')
 finally:os.close(fd)
 result['runtimeLog']={'path':str(log),'size':entry.st_size,'tail':'\n'.join(
  '[redacted diagnostic line]' if re.search(r'token|password|authorization|private.key|client.secret|prompt|messages|content',line,re.I)
  else line for line in tail.splitlines())}
except (OSError,ValueError) as error:result['runtimeLog']={'path':str(log),'error':str(error)}
print(json.dumps(result))
`;

export class SharedCycleObserver {
  readonly traces: { kind: string; samples: SharedCycleObservation[]; succeeded: boolean; guardApplicable: boolean; postStopPane?: unknown }[] = [];
  private latest: SharedCycleObservation | undefined;
  readonly diagnostics: unknown[] = [];
  private diagnosed = false;
  private diagnosticTrace = 'before-trace';

  constructor(private readonly actor: { container: string; runtime: string; alias: string; user: string; tenant: string }) {}

  /** What the resume check reads after a restart: the session pointer and the head of each transcript. */
  async resumeEvidence(): Promise<unknown> {
    return JSON.parse(await docker(['exec', '--user', '0', this.actor.container, 'python3', '-I', '-B', '-c', READ_RESUME_EVIDENCE])) as unknown;
  }

  async failureSnapshot(): Promise<unknown> {
    return JSON.parse(await docker(['exec', '--user', '0', this.actor.container, 'python3', '-I', '-B', '-c',
      READ_FAILURE, this.actor.runtime, this.actor.user])) as unknown;
  }

  async read(idle = true, diagnostic = false): Promise<SharedCycleObservation> {
    const containerId = await docker(['ps', '--no-trunc', '--format', '{{.ID}}', '--filter', `name=^/${this.actor.container}$`]);
    if (!containerId) return { available: false, reason: 'container_absent' };
    if (!/^[a-f0-9]{64}$/u.test(containerId)) throw new Error('shared observation did not resolve one complete container identity');
    const executed = await command('docker', ['exec', '--user', '0', containerId,
      'python3', '-I', '-B', '-c', READ, this.actor.runtime, this.actor.alias, idle ? '1' : '0', this.actor.tenant, this.actor.user,
      diagnostic ? '1' : '0']);
    if (executed.code !== 0) {
      const absent = `Error response from daemon: No such container: ${containerId}`;
      const stopped = `Error response from daemon: container ${containerId} is not running`;
      const failure = new Error(`docker exec failed (${String(executed.code)}): ${executed.stderr.trim()}`);
      if (this.diagnosticTrace !== 'purge' || executed.stdout || ![absent, stopped].includes(executed.stderr.trimEnd())) throw failure;
      const checks: { operation: string; code: number; stdout: string; stderr: string }[] = [];
      const recheck = async () => {
        const result = await command('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}', '--filter', `id=${containerId}`]);
        checks.push({ operation: 'ps-a', ...result });
        if (result.code !== 0) throw new Error(`purge container recheck failed: ${result.stderr}`);
        return result.stdout.trim();
      };
      let remaining = await recheck();
      let reason = 'container_absent';
      if (remaining === containerId) {
        const result = await command('docker', ['inspect', '--format', '{{.Id}} {{.State.Running}}', containerId]);
        checks.push({ operation: 'inspect-running', ...result });
        if (result.code === 0) {
          if (result.stdout.trim() !== `${containerId} false`) throw failure;
          reason = 'container_stopped';
        } else {
          if (result.stdout || result.stderr.trimEnd() !== absent) throw new Error(`purge container inspection failed: ${result.stderr}`);
          remaining = await recheck();
          if (remaining) throw failure;
        }
      } else if (remaining) throw failure;
      const witness = { kind: 'purge-container-race', containerId, rawExecResult: executed, checks, reason };
      this.diagnostics.push(witness);
      return { available: false, reason, diagnostic: witness };
    }
    const observed = JSON.parse(executed.stdout) as SharedCycleObservation;
    if (observed.reason?.startsWith('RESTART_HOLD_') && !this.diagnosed && !diagnostic) {
      const detail = await this.read(idle, true);
      this.diagnostics.push({ kind: this.diagnosticTrace, ...detail });
      this.diagnosed = !detail.available && typeof detail.diagnostic === 'object' && detail.diagnostic !== null
        && 'guardCommands' in detail.diagnostic && Array.isArray(detail.diagnostic.guardCommands);
    }
    if (observed.available) {
      expect(observed.runtime).not.toBe(observed.wireAlias);
      if (observed.mode === 'shared_session') {
        expect(observed.session).toBe(`=cauce-${this.actor.runtime}:agente`);
        expect(observed.socket).toMatch(/\/tmux-[0-9]+\/cauce$/u);
        this.latest = observed;
      }
    }
    return observed;
  }

  async trace<T>(kind: string, operation: () => Promise<T>): Promise<T> {
    this.diagnosed = false;
    this.diagnosticTrace = kind;
    const deadline = Date.now() + 240_000;
    const before = await this.read();
    const receipt: typeof this.traces[number] = { kind, samples: [before], succeeded: false, guardApplicable: before.mode === 'shared_session' };
    this.traces.push(receipt);
    if (['update', 'stop'].includes(kind)) expect(before.available, `${kind}: the adapter must be observed before stopping`).toBe(true);
    if (['retire', 'purge'].includes(kind) && !before.available) expect(before.reason).toBe('adapter_absent_verified');
    const lifetime = { active: true };
    let samplingError: unknown;
    const sampling = (async () => {
      while (lifetime.active) {
        receipt.samples.push(await this.read());
        await new Promise(resolve => { setTimeout(resolve, 100); });
      }
    })().catch((error: unknown) => { samplingError = error; lifetime.active = false; });
    let outcome: { value: T } | undefined;
    let operationError: unknown;
    try {
      outcome = { value: await operation() };
      receipt.succeeded = true;
    } catch (error) {
      operationError = error;
    } finally {
      lifetime.active = false;
      await sampling;
    }
    if (!outcome) throw new Error(`${kind}: fleet operation failed`, { cause: operationError });
    if (samplingError) throw new Error(`${kind}: shared observation failed`, { cause: samplingError });
    receipt.samples.push(await this.read());
    if (kind === 'stop') {
      expect(receipt.samples.at(-1)?.reason).toBe('adapter_absent_verified');
      receipt.postStopPane = JSON.parse(await docker(['exec', '--user', this.actor.user,
        '--env', `TMUX_TMPDIR=${before.tmuxDirectory ?? ''}`, this.actor.container, 'python3', '-I', '-B', '-c',
        READ_STOPPED_PANE, JSON.stringify(before)])) as unknown;
    }
    if (['create', 'restore', 'start', 'update'].includes(kind)) {
      await expect.poll(async () => {
        const observed = await this.read();
        receipt.samples.push(observed);
        return observed;
      }, { timeout: Math.max(1, deadline - Date.now()), interval: 100 }).toMatchObject({
        available: true, phase: '0', mode: 'shared_session', canonicalRead: true,
      });
      if (kind !== 'update') expect(receipt.samples.some(row => row.available && row.phase === '1'
        && (row.mode === 'no_live_tmux_verified' && row.tmuxAbsent === true || row.mode === 'shared_session' && row.canonicalRead === true)),
      `${kind}: canonical bootstrap identity was not observed`).toBe(true);
      if (kind === 'create') expect(receipt.samples.some(row => row.available && row.phase === '1'
        && row.mode === 'no_live_tmux_verified' && row.tmuxAbsent), 'fresh create bootstrap must verify global live tmux absence').toBe(true);
      expect(receipt.samples.some(row => row.available && row.phase === '0' && row.mode === 'shared_session' && row.canonicalRead),
        `${kind}: canonical normal shared session was not observed`).toBe(true);
    }
    if (receipt.guardApplicable && ['update', 'stop', 'retire'].includes(kind)) {
      expect(receipt.samples.some(row => row.available && row.canonicalRead), `${kind}: no canonical shared session observed`).toBe(true);
    }
    return outcome.value;
  }

  async keys(keys: string[], literal = false): Promise<void> {
    const observed = this.latest;
    if (!observed?.socket || !observed.pane || !observed.tmuxDirectory) throw new Error('shared pane has not been observed');
    await docker(['exec', '--user', this.actor.user, '--env', `TMUX_TMPDIR=${observed.tmuxDirectory}`, this.actor.container,
      '/usr/bin/tmux', '-S', observed.socket, 'send-keys', '-t', observed.pane, ...(literal ? ['-l'] : []), ...keys]);
  }

  async draft(marker: string): Promise<SharedCycleObservation> {
    expect((await this.read()).available).toBe(true);
    await this.keys([marker], true);
    let observed: SharedCycleObservation = { available: false };
    await expect.poll(async () => { observed = await this.read(false); return observed.provider?.draftLength; }, { timeout: 30_000 }).toBe(marker.length);
    expect(observed.composer).toContain(marker);
    return observed;
  }

  async preserved(before: SharedCycleObservation): Promise<SharedCycleObservation> {
    const after = await this.read(false);
    expect(after.available).toBe(true);
    for (const key of ['adapter', 'controller', 'metadata', 'metadataSha256', 'tmuxDirectory', 'sourceSha256', 'session', 'socket',
      'socketIdentity', 'pane', 'panePid', 'paneStarttime', 'tmuxServerPid', 'composer', 'provider'] as const) {
      expect(after[key], `held draft changed ${key}`).toEqual(before[key]);
    }
    return after;
  }

  async clear(): Promise<void> {
    await this.keys(['C-u']);
    await expect.poll(async () => (await this.read(false)).provider?.draftLength, { timeout: 30_000 }).toBe(0);
    expect((await this.read()).available).toBe(true);
  }
}
