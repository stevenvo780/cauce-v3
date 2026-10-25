import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { command, docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import type { CopyRestorationFixture } from './v4-copias-restauracion.runtime.js';

const TASK = 'c171c-copias-grandes-rendimiento-1025';
const INPUT_LIMIT = 16_384;
const LOG_LIMIT = 8 * 1024 * 1024;
type Verb = 'ps' | 'inspect' | 'exec' | 'other';
type Distribution = Record<Verb, number>;
interface NodeEvent {
  kind: 'preload' | 'helper' | 'fetch' | 'instrumentation_error';
  pid: number; action?: string; id?: string | null; offset?: number | null; bytes?: number;
  helper?: 'runtime' | 'stream_session'; start_ms?: number; end_ms?: number; status?: number | null;
  exit_code?: number | null; stage?: string;
}
interface Installation {
  directory: string; container_id: string; unit: string; worker_pid: number;
  wrapper_sha256: string; preload_sha256: string; real_binary_sha256: string;
  node_options_preserved: boolean; input_limit: number; log_limit: number;
}
interface Snapshot { events: NodeEvent[]; docker: { ppid: number; verb: Verb }[]; node_sha256: string; docker_sha256: string }
export interface BackupHelperMeasurement {
  pid: number; action: string; mode: 'runtime' | 'stream_session'; offset: number | null;
  start_ms: number; end_ms: number; helper_ms: number; docker_count: number; docker_distribution: Distribution;
}
export interface BackupBlockMeasurement {
  offset: number; bytes: number; interval_ms: number; request_ms: number; helper_ms: number | null;
  helper_pids: number[]; docker_count: number; docker_distribution: Distribution;
  attribution: 'per_block_helper' | 'stream_session'; stream_session_docker_amortized: number;
}
export interface BackupMeasurement {
  backup_id: string; instrumentation: Installation; upload_ms: number; worker_ms: number;
  export_ms: number | null; finish_ms: number; blocks: BackupBlockMeasurement[];
  helpers: BackupHelperMeasurement[]; docker_total: number; docker_distribution: Distribution;
  stream_sessions: { pid: number; docker_count: number; blocks: number; docker_per_block_amortized: number }[];
  observations: { helpers: NodeEvent[]; requests: NodeEvent[]; docker: Snapshot['docker'] };
  log_hashes: { node: string; docker: string }; classification: string[];
}
const installed = new WeakMap<CopyRestorationFixture, Installation>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const preload = String.raw`
'use strict';
const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const clock = () => Number(process.hrtime.bigint()) / 1e6;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const offset = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const record = value => fs.appendFileSync(config.log, JSON.stringify(value) + '\n', { mode: 0o600 });
const issue = stage => record({ kind: 'instrumentation_error', pid: process.pid, stage });
const originalSpawn = cp.spawn;
cp.spawn = function(...args) {
  const argv = Array.isArray(args[1]) ? args[1] : [];
  const runtime = argv.some(value => typeof value === 'string' && /(?:^|\/)space_backup_runtime\.py$/.test(value));
  const stream = argv.includes('--host-stream') && argv.some(value => typeof value === 'string' && /(?:^|\/)space_backup_local\.py$/.test(value));
  const start = clock();
  const child = Reflect.apply(originalSpawn, this, args);
  if (!runtime && !stream) return child;
  let initial = Buffer.alloc(0); let metadata; let ended = false; let insideEnd = false; let invalid = false;
  const parse = () => {
    if (metadata || invalid) return;
    try {
      const body = JSON.parse(initial.toString('utf8').split('\n', 1)[0]);
      const id = body.claim && body.claim.id;
      if (!uuid(id) || !['export', 'read', 'remove'].includes(body.action)) throw new Error('shape');
      metadata = { action: body.action, id, offset: offset(body.offset) };
    } catch { invalid = true; }
    initial.fill(0); initial = Buffer.alloc(0);
  };
  const capture = (chunk, encoding) => {
    if (metadata || invalid || chunk === undefined || typeof chunk === 'function') return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk);
    if (initial.length + bytes.length > config.inputLimit) { invalid = true; initial.fill(0); initial = Buffer.alloc(0); return; }
    initial = Buffer.concat([initial, bytes]);
    if (initial.includes(10)) parse();
  };
  if (child.stdin) {
    const write = child.stdin.write; const end = child.stdin.end;
    child.stdin.write = function(...values) {
      if (!insideEnd) capture(values[0], values[1]);
      return Reflect.apply(write, this, values);
    };
    child.stdin.end = function(...values) {
      capture(values[0], values[1]); ended = true; parse(); insideEnd = true;
      try { return Reflect.apply(end, this, values); } finally { insideEnd = false; }
    };
  }
  child.once('close', code => {
    if (!metadata && !ended) parse();
    if (!metadata || !Number.isSafeInteger(child.pid)) { issue('helper-initial-input'); return; }
    record({ kind: 'helper', pid: child.pid, ...metadata, helper: stream ? 'stream_session' : 'runtime',
      start_ms: start, end_ms: clock(), exit_code: code });
  });
  return child;
};
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = function(...args) {
  let metadata;
  try {
    const target = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0].url);
    const init = args[1];
    if (target.origin === config.origin && target.pathname === config.route && !target.search && init && init.method === 'POST') {
      if (typeof init.body !== 'string' || Buffer.byteLength(init.body) > config.logLimit) throw new Error('body');
      const packet = JSON.parse(init.body); const body = packet.payload;
      if (!body || !['claim', 'renew', 'begin', 'append', 'finish', 'fail'].includes(body.action)) throw new Error('action');
      const id = body.claim && body.claim.id;
      if (body.action !== 'claim' && !uuid(id)) throw new Error('id');
      metadata = { action: body.action, id: uuid(id) ? id : null, offset: offset(body.offset),
        bytes: body.action === 'append' && typeof body.data === 'string' ? Buffer.byteLength(body.data, 'base64') : 0 };
    }
  } catch { issue('fetch-metadata'); }
  if (!metadata) return Reflect.apply(originalFetch, this, args);
  const start = clock();
  return Reflect.apply(originalFetch, this, args).then(response => {
    record({ kind: 'fetch', pid: process.pid, ...metadata, start_ms: start, end_ms: clock(), status: response.status });
    return response;
  }, error => {
    record({ kind: 'fetch', pid: process.pid, ...metadata, start_ms: start, end_ms: clock(), status: null });
    throw error;
  });
};
record({ kind: 'preload', pid: process.pid });
`;

const installer = String.raw`
import hashlib,json,os,pathlib,pwd,stat,subprocess,sys,time
plan=json.load(sys.stdin)
account=pwd.getpwnam('cauce')
directory=pathlib.Path(plan['directory'])
unit=plan['unit']
user=['runuser','-u','cauce','--','env','HOME=/home/cauce','XDG_RUNTIME_DIR=/run/user/1500','systemctl','--user']
def control(*args):
 result=subprocess.run(user+list(args),capture_output=True,timeout=65)
 if result.returncode: raise RuntimeError('owned executor systemctl operation failed')
 return result.stdout.decode().strip()
pid=int(control('show',unit,'--property=MainPID','--value'))
if pid<=1: raise RuntimeError('owned executor is not running')
environment=pathlib.Path('/proc/'+str(pid)+'/environ').read_bytes().split(b'\0')
previous=next((value.split(b'=',1)[1].decode() for value in environment if value.startswith(b'NODE_OPTIONS=')),'')
binary=pathlib.Path('/usr/bin/docker')
info=binary.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022: raise RuntimeError('Docker binary identity is unsafe')
real=pathlib.Path(plan['real_binary'])
if real.exists() or directory.exists(): raise RuntimeError('measurement paths already exist')
def digest(path):
 value=hashlib.sha256()
 with path.open('rb') as stream:
  while chunk:=stream.read(1024*1024): value.update(chunk)
 return value.hexdigest()
binary_hash=digest(binary)
directory.mkdir(mode=0o700)
os.chown(directory,account.pw_uid,account.pw_gid)
def private(path,body,mode=0o600):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'w') as stream: stream.write(body)
 os.chown(path,account.pw_uid,account.pw_gid)
for filename in ['docker.log','node.jsonl']: private(directory/filename,'')
source=directory/'preload.cjs'
private(source,plan['preload'])
candidate=directory/'docker-wrapper.sh'
private(candidate,plan['wrapper'],0o700)
if subprocess.run(['/bin/sh','-n',str(candidate)],capture_output=True).returncode: raise RuntimeError('wrapper syntax is invalid')
if subprocess.run(['/usr/local/bin/node','--check',str(source)],capture_output=True).returncode: raise RuntimeError('preload syntax is invalid')
dropin=pathlib.Path('/home/cauce/.config/systemd/user')/(unit+'.d')
dropin.mkdir(mode=0o700,parents=True,exist_ok=True)
os.chown(dropin,account.pw_uid,account.pw_gid)
options=(previous+' --require='+str(source)).strip()
if any(character in options for character in '\n\r\0'): raise RuntimeError('NODE_OPTIONS cannot be preserved safely')
escaped=options.replace('\\','\\\\').replace('"','\\"').replace('%','%%')
private(dropin/'90-c171c-measurement.conf','[Service]\nEnvironment="NODE_OPTIONS='+escaped+'"\n')
os.rename(binary,real)
fd=os.open(binary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o755)
with os.fdopen(fd,'w') as stream: stream.write(plan['wrapper'])
os.chmod(binary,0o755)
if digest(real)!=binary_hash: raise RuntimeError('renamed Docker binary fingerprint differs')
control('daemon-reload')
control('restart',unit)
if control('is-active',unit)!='active': raise RuntimeError('instrumented executor is inactive')
new_pid=int(control('show',unit,'--property=MainPID','--value'))
deadline=time.monotonic()+15
while time.monotonic()<deadline:
 events=[json.loads(line) for line in (directory/'node.jsonl').read_text().splitlines()]
 if any(event.get('kind')=='preload' and event.get('pid')==new_pid for event in events): break
 time.sleep(.1)
else: raise RuntimeError('preload did not confirm installation')
print(json.dumps({'directory':str(directory),'unit':unit,'worker_pid':new_pid,'wrapper_sha256':digest(binary),
 'preload_sha256':digest(source),'real_binary_sha256':binary_hash,'node_options_preserved':bool(previous),
 'input_limit':plan['input_limit'],'log_limit':plan['log_limit']}))
`;

const snapshot = String.raw`
import hashlib,json,os,pathlib,stat,sys
directory=pathlib.Path(sys.argv[1]);limit=int(sys.argv[2])
info=directory.lstat()
if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o700:
 raise RuntimeError('measurement directory identity differs')
def read(name):
 path=directory/name
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600 or info.st_size>limit:
   raise RuntimeError('measurement log identity or size differs')
  with os.fdopen(fd,'rb',closefd=False) as stream: raw=stream.read(limit+1)
  if len(raw)>limit: raise RuntimeError('measurement log exceeded its limit')
  lines=raw.splitlines(keepends=True)
  if lines and not lines[-1].endswith(b'\n'): lines.pop()
  return raw,[line.decode() for line in lines]
 finally: os.close(fd)
node,node_lines=read('node.jsonl');docker,docker_lines=read('docker.log')
calls=[]
for line in docker_lines:
 fields=line.split()
 if len(fields)!=2 or not fields[0].isdecimal() or fields[1] not in ['ps','inspect','exec','other']:
  raise RuntimeError('Docker measurement record is invalid')
 calls.append({'ppid':int(fields[0]),'verb':fields[1]})
print(json.dumps({'events':[json.loads(line) for line in node_lines],'docker':calls,
 'node_sha256':hashlib.sha256(node).hexdigest(),'docker_sha256':hashlib.sha256(docker).hexdigest()}))
`;

export async function installBackupMeasurement(f: CopyRestorationFixture): Promise<void> {
  if (installed.has(f)) return;
  const run = /-([a-f0-9]{6,8})-(?:large|many)$/u.exec(f.alias)?.[1];
  if (!run || !f.computer.prefix.startsWith('zz-canary-') || f.computer.container !== f.computer.prefix
    || !/^[a-z0-9_-]+$/u.test(f.company) || !/^[a-z0-9_-]+$/u.test(f.host)) throw new Error('measurement requires an owned copy fixture');
  const view = JSON.parse(await docker(['inspect', '--format',
    '{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Config.Labels "cauce.e2e.owner")}}}', f.computer.container])) as {
      id: string; name: string; owner: string;
    };
  if (!/^[a-f0-9]{64}$/u.test(view.id) || view.name !== `/${f.computer.container}`
    || ![TASK, 'c171b-copias-grandes-1025'].includes(view.owner)) throw new Error('measurement computer ownership differs');
  const directory = `/home/cauce/.c171c-${run}-${f.scenario}`;
  const realBinary = `/usr/bin/docker.c171c-${run}-${f.scenario}`;
  const wrapper = `#!/bin/sh\ncase "$1" in ps|inspect|exec) verb="$1";; *) verb=other;; esac\nprintf '%s %s\\n' "$PPID" "$verb" >> '${directory}/docker.log'\nexec '${realBinary}' "$@"\n`;
  const source = `const config = ${JSON.stringify({ log: `${directory}/node.jsonl`, inputLimit: INPUT_LIMIT, logLimit: LOG_LIMIT,
    origin: new URL(f.computer.gatewayUrl).origin, route: `/v3/fleet/hosts/${f.host}/space-backups` })};\n${preload}`;
  const unit = `cauce-v3-host-executor-${f.company}-${f.host}.service`;
  const result = await command('docker', ['exec', '-i', '--user', 'root', view.id, 'python3', '-I', '-B', '-c', installer],
    JSON.stringify({ directory, real_binary: realBinary, unit, wrapper, preload: source, input_limit: INPUT_LIMIT, log_limit: LOG_LIMIT }));
  if (result.code !== 0) throw new Error(`backup measurement installation failed (exit ${String(result.code)}); private fixture retained for normal cleanup`);
  const installation = JSON.parse(result.stdout) as Installation;
  if (installation.wrapper_sha256 !== hash(wrapper) || installation.preload_sha256 !== hash(source)
    || !/^[a-f0-9]{64}$/u.test(installation.real_binary_sha256)) throw new Error('measurement installation hashes differ');
  installed.set(f, { ...installation, container_id: view.id });
}

function distribution(calls: Snapshot['docker'], pid: number): Distribution {
  const result: Distribution = { ps: 0, inspect: 0, exec: 0, other: 0 };
  for (const call of calls) if (call.ppid === pid) result[call.verb] += 1;
  return result;
}
const total = (counts: Distribution) => Object.values(counts).reduce((sum, value) => sum + value, 0);
const start = (event: NodeEvent) => {
  if (event.start_ms === undefined || !Number.isFinite(event.start_ms)) throw new Error('measurement start is absent');
  return event.start_ms;
};
const end = (event: NodeEvent) => {
  if (event.end_ms === undefined || !Number.isFinite(event.end_ms)) throw new Error('measurement end is absent');
  return event.end_ms;
};

export async function collectBackupMeasurement(f: CopyRestorationFixture, backupId: string): Promise<BackupMeasurement> {
  const installation = installed.get(f);
  if (!installation || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(backupId)) throw new Error('measurement was not installed for this backup');
  let measured: Snapshot | undefined;
  const deadline = Date.now() + 15_000;
  do {
    const result = await command('docker', ['exec', '--user', 'cauce', installation.container_id, 'python3', '-I', '-B', '-c',
      snapshot, installation.directory, String(LOG_LIMIT)]);
    if (result.code !== 0) throw new Error('backup measurement logs could not be read safely');
    measured = JSON.parse(result.stdout) as Snapshot;
    if (measured.events.some(event => event.kind === 'instrumentation_error')) throw new Error('backup instrumentation recorded an unsupported input');
    const matching = measured.events.filter(event => event.id === backupId);
    if (matching.some(event => event.kind === 'fetch' && event.action === 'finish')
      && matching.some(event => event.kind === 'helper' && event.action === 'read')) break;
    await sleep(100);
  } while (Date.now() < deadline);
  const events = measured.events.filter(event => event.id === backupId);
  const requests = events.filter(event => event.kind === 'fetch');
  if (requests.some(event => event.status === null || event.status === undefined || event.status < 200 || event.status >= 300)) {
    throw new Error('measured backup has an unsuccessful request');
  }
  const begin = requests.find(event => event.action === 'begin');
  const finish = requests.find(event => event.action === 'finish');
  const appends = requests.filter(event => event.action === 'append').sort((left, right) => start(left) - start(right));
  if (!begin || !finish || !appends.length) throw new Error('measured backup begin/append/finish chain is incomplete');
  const helpers = events.filter(event => event.kind === 'helper' && event.action !== 'remove').map(event => {
    if (!event.helper || !event.action || event.exit_code !== 0) throw new Error('measured backup helper did not exit successfully');
    const counts = distribution(measured.docker, event.pid);
    if (total(counts) === 0) throw new Error('measured backup helper has no observed Docker invocations');
    return { pid: event.pid, action: event.action, mode: event.helper, offset: event.offset ?? null,
      start_ms: start(event), end_ms: end(event), helper_ms: end(event) - start(event), docker_count: total(counts), docker_distribution: counts };
  });
  if (new Set(helpers.map(helper => helper.pid)).size !== helpers.length) throw new Error('reused helper PIDs make Docker attribution ambiguous');
  const sessions = helpers.filter(helper => helper.mode === 'stream_session');
  if (sessions.length > 1) throw new Error('measured backup has multiple ambiguous stream sessions');
  let previous = end(begin);
  const blocks = appends.map(event => {
    if (event.offset === null || event.offset === undefined || !event.bytes) throw new Error('measured block metadata is incomplete');
    const reads = helpers.filter(helper => helper.mode === 'runtime' && helper.action === 'read' && helper.offset === event.offset
      && helper.end_ms <= start(event));
    if (sessions.length ? reads.length !== 0 : reads.length !== 1) throw new Error('measured block has no unambiguous read helper or stream session');
    const direct: Distribution = { ps: 0, inspect: 0, exec: 0, other: 0 };
    for (const helper of reads) for (const verb of Object.keys(direct) as Verb[]) direct[verb] += helper.docker_distribution[verb];
    const block: BackupBlockMeasurement = { offset: event.offset, bytes: event.bytes, interval_ms: end(event) - previous,
      request_ms: end(event) - start(event), helper_ms: reads[0]?.helper_ms ?? null,
      helper_pids: reads.length ? reads.map(helper => helper.pid) : sessions.map(helper => helper.pid),
      docker_count: total(direct), docker_distribution: direct, attribution: reads.length ? 'per_block_helper' : 'stream_session',
      stream_session_docker_amortized: sessions.reduce((sum, helper) => sum + helper.docker_count, 0) / appends.length };
    previous = end(event);
    return block;
  });
  const counts: Distribution = { ps: 0, inspect: 0, exec: 0, other: 0 };
  for (const helper of helpers) for (const verb of Object.keys(counts) as Verb[]) counts[verb] += helper.docker_distribution[verb];
  const exports = helpers.filter(helper => helper.action === 'export');
  return { backup_id: backupId, instrumentation: installation, upload_ms: end(appends.at(-1) ?? begin) - end(begin),
    worker_ms: end(finish) - Math.min(...helpers.map(helper => helper.start_ms)), export_ms: exports[0]?.helper_ms ?? null,
    finish_ms: end(finish) - start(finish), blocks, helpers, docker_total: total(counts), docker_distribution: counts,
    stream_sessions: sessions.map(helper => ({ pid: helper.pid, docker_count: helper.docker_count, blocks: appends.length,
      docker_per_block_amortized: helper.docker_count / appends.length })),
    observations: { helpers: events.filter(event => event.kind === 'helper' && event.action !== 'remove'), requests,
      docker: measured.docker.filter(call => helpers.some(helper => helper.pid === call.ppid)) },
    log_hashes: { node: measured.node_sha256, docker: measured.docker_sha256 }, classification: [
      'Docker counts are observed wrapper invocations, joined only by the real helper PID/PPID.',
      'Block interval runs from the previous append response (or begin response) to this append response.',
      'Fetch end measures response headers becoming available; response bodies and transport are not intercepted.',
      'A stream session is counted once; its total divided by blocks is an amortized value, not a per-block observation.',
      'Docker totals include export and read helpers; cleanup/remove and unrelated capability probes are excluded.',
      'Worker interval starts at the first measured helper spawn and ends at the finish response; claim polling is excluded.',
    ] };
}
