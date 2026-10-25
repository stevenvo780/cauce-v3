import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import type { XDockerIsolation } from './v4-agentes-x-docker-isolation.js';

const execute = promisify(execFile);
export const X2_PACKAGE = 'pip:cauce-x2-probe==1.0.0';
export const X2_BROWSER_IMAGE = 'chromedp/headless-shell@sha256:53cc0f33c0598ff244f6e45458f6dfaf0ae4206d388ae7364903afd1d9d14f0a';
export const X2_PROXY_IMAGE = 'tecnativa/docker-socket-proxy@sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459';
export interface X2Docker {
  docker(args: string[], input?: string): Promise<string>;
  command(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }>;
  dockerSocket: string;
}

export interface X2GuardObservation {
  adapter: { pid: number; start: number; uid: number };
  controller: { pid: number; start: number; uid: number };
  sharedSession: true;
  stopAuthority: string;
  pane: { id: string; pid: number; inputOff: string; barrierPresent: boolean; socket: string; socketUid: number; socketInode: number };
}

export async function observeX2RestartGuard(client: X2Docker, container: string, runtime: string): Promise<X2GuardObservation> {
  const script = String.raw`import hashlib,json,pathlib,stat,sys
sys.path.insert(0,'/cauce/lifecycle')
from cauce_container_base import STOP_AUTHORITY,open_control_directory
from cauce_container_proc import read_metadata,verify_adapter,verify_controller
from cauce_container_restart import assert_restart_safe,process_identity,shared_pane
control=open_control_directory('/run/cauce-fleet/'+sys.argv[1])
document,_=read_metadata(control)
assert document is not None and document['phase']=='running'
assert document.get('stopAuthority')==STOP_AUTHORITY
verify_adapter(document,document['alias'],document['stateDirectory'])
verify_controller(document)
pane=shared_pane(document)
assert pane is not None
assert_restart_safe(document)
_,snapshot=pane.read()
fields=pane.fields()
socket=pathlib.Path(pane.environment.get('TMUX_TMPDIR','/tmp'))/('tmux-'+str(pane.uid))/'cauce'
socket_stat=socket.lstat()
assert stat.S_ISSOCK(socket_stat.st_mode) and socket_stat.st_uid==pane.uid
def identity(pid,start,runtime=False):
 observed=process_identity(pid)
 assert observed[0]==start and (not runtime or observed[1]==document['runtimeUid'])
 return {'pid':pid,'start':start,'uid':observed[1]}
assert fields[6]=='' and fields[7]=='0'
print(json.dumps({'sharedSession':True,'stopAuthority':document['stopAuthority'],
 'adapter':identity(document['pid'],document['starttime'],True),
 'controller':identity(document['controllerPid'],document['controllerStarttime']),
 'pane':{'id':fields[0],'pid':int(fields[1]),'inputOff':fields[7],'barrierPresent':bool(fields[6]),
         'socket':str(socket),'socketUid':socket_stat.st_uid,'socketInode':socket_stat.st_ino},
 'snapshotSha256':hashlib.sha256(snapshot.encode()).hexdigest(),
 'sourceSha256':{name:hashlib.sha256(pathlib.Path('/cauce/lifecycle',name+'.py').read_bytes()).hexdigest()
                 for name in ['cauce_container_base','cauce_container_proc','cauce_container_restart']}}))`;
  return JSON.parse(await client.docker(['exec', '--user', '0', container, 'python3', '-I', '-B', '-c', script, runtime])) as X2GuardObservation;
}

export async function observeX2Stopped(client: X2Docker, container: string, runtime: string, before: X2GuardObservation): Promise<{ metadataAbsent: boolean; processes: { role: string; activeIdentity: boolean }[] }> {
  const script = String.raw`import json,pathlib,sys
before=json.loads(sys.argv[2]);processes=[]
for role in ['adapter','controller']:
 expected=before[role];path=pathlib.Path('/proc')/str(expected['pid'])
 try:
  fields=(path/'stat').read_text().rsplit(') ',1)[1].split()
  active=int(fields[19])==expected['start'] and path.stat().st_uid==expected['uid'] and fields[0]!='Z'
 except FileNotFoundError:active=False
 processes.append({'role':role,'activeIdentity':active})
print(json.dumps({'metadataAbsent':not pathlib.Path('/run/cauce-fleet',sys.argv[1],'cauce-v3-adapter.json').exists(),'processes':processes}))`;
  return JSON.parse(await client.docker(['exec', '--user', '0', container, 'python3', '-I', '-B', '-c', script, runtime,
    JSON.stringify(before)])) as { metadataAbsent: boolean; processes: { role: string; activeIdentity: boolean }[] };
}

export async function attachX2Transport(isolation: XDockerIsolation, network: string, owner: string,
  outer: (args: string[]) => Promise<string>): Promise<Record<string, unknown>> {
  const before = await isolation.assertDedicated();
  const container = JSON.parse(await outer(['inspect', '--format', '{"Id":{{json .Id}},"Labels":{{json .Config.Labels}}}', String(isolation.receipt.containerId)])) as { Id: string; Labels: Record<string, string> };
  const target = JSON.parse(await outer(['network', 'inspect', '--format', '{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Labels}}}', network])) as { Id: string; Name: string; Labels: Record<string, string> };
  if (container.Id !== isolation.receipt.containerId || container.Labels['cauce.e2e.owner'] !== owner
    || container.Labels['cauce.e2e.isolation'] !== isolation.receipt.isolation || target.Name !== `${String(isolation.receipt.prefix)}-base`
    || target.Labels['cauce.e2e.owner'] !== owner) throw new Error('the owned transport attachment fence failed');
  await outer(['network', 'connect', target.Id, container.Id]);
  const networks = JSON.parse(await outer(['inspect', '--format', '{{json .NetworkSettings.Networks}}', container.Id])) as Record<string, { NetworkID: string; IPAddress: string }>;
  if (networks[network]?.NetworkID !== target.Id || !networks[network].IPAddress || 'host' in networks) throw new Error('the dedicated daemon did not attach its owned transport network');
  const after = await isolation.assertDedicated();
  return { containerId: container.Id, networkId: target.Id, network, networks, daemonIdBefore: before.daemonId, daemonIdAfter: after.daemonId };
}

export async function diagnoseX2ProfileTransport(computer: ComputerHarness, client: X2Docker, container: string): Promise<unknown> {
  const target = await computer.onComputer(['python3', '-I', '-B', '-c',
    'import json,pathlib,sys;paths=list(pathlib.Path(sys.argv[1]).rglob("executor-policy.json"));assert len(paths)==1;print(json.loads(paths[0].read_bytes())["transport"]["bootstrap_url"])', computer.installRoot]);
  if (target.code !== 0) return { target };
  const script = String.raw`import net from 'node:net';
const endpoint=new URL(process.argv[1]);
const socket=net.createConnection({host:endpoint.hostname,port:Number(endpoint.port||443)});
const result=await new Promise(resolve=>{socket.setTimeout(5000);socket.once('connect',()=>resolve({connected:true,remoteAddress:socket.remoteAddress,remotePort:socket.remotePort}));socket.once('error',error=>resolve({connected:false,errorCode:error.code}));socket.once('timeout',()=>resolve({connected:false,errorCode:'TCP_TIMEOUT'}));});
socket.destroy();console.log(JSON.stringify({origin:endpoint.origin,...result}));
`;
  return client.command(['exec', '--user', 'cauce', container, 'node', '--input-type=module', '-e', script, target.stdout.trim()]);
}

export async function preloadX2Image(client: X2Docker, image: string): Promise<Record<string, unknown>> {
  const existing = await client.command(['image', 'inspect', '--format', '{{.Id}}', image]);
  if (existing.code === 0) return { image, available: true, cached: true, id: existing.stdout.trim() };
  const started = Date.now();
  try {
    const result = await execute('docker', ['--host', `unix://${client.dockerSocket}`, 'pull', image], { timeout: 120_000, maxBuffer: 1_048_576 });
    const id = await client.docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    return { image, available: true, cached: false, id, durationMs: Date.now() - started, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string };
    return { image, available: false, durationMs: Date.now() - started, code: failure.code,
      error: failure.message, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const WHEEL = String.raw`import base64,hashlib,json,pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])/'wheels'
root.mkdir(mode=0o755,parents=True,exist_ok=True)
info='cauce_x2_probe-1.0.0.dist-info'
files={
 'cauce_x2_probe.py':b"__version__ = '1.0.0'\ndef proof():\n    return 'X2-PIP-INSTALLED'\n",
 info+'/METADATA':b'Metadata-Version: 2.1\nName: cauce-x2-probe\nVersion: 1.0.0\n',
 info+'/WHEEL':b'Wheel-Version: 1.0\nGenerator: cauce-x2\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
}
record=''.join(name+',sha256='+base64.urlsafe_b64encode(hashlib.sha256(body).digest()).decode().rstrip('=')+','+str(len(body))+'\n' for name,body in files.items())
files[info+'/RECORD']=(record+info+'/RECORD,,\n').encode()
wheel=root/'cauce_x2_probe-1.0.0-py3-none-any.whl'
with zipfile.ZipFile(wheel,'w',compression=zipfile.ZIP_DEFLATED) as archive:
 for name,body in files.items():
  entry=zipfile.ZipInfo(name,(1980,1,1,0,0,0));entry.compress_type=zipfile.ZIP_DEFLATED;entry.external_attr=0o644<<16
  archive.writestr(entry,body)
wheel.chmod(0o644)
print(json.dumps({'name':'cauce-x2-probe','version':'1.0.0','wheel':str(wheel),'sha256':hashlib.sha256(wheel.read_bytes()).hexdigest(),'bytes':wheel.stat().st_size}))
`;

export async function prepareX2Package(computer: ComputerHarness, client: X2Docker, container: string, mountRoot: string, state: string): Promise<unknown> {
  const wheel = await computer.onComputer(['python3', '-I', '-B', '-c', WHEEL, mountRoot]);
  if (wheel.code !== 0) throw new Error(`owned wheel could not be built: ${wheel.stderr}`);
  await client.docker(['exec', '--user', 'cauce', container, 'python3', '-I', '-B', '-c',
    'import pathlib,sys;root=pathlib.Path(sys.argv[1]);directory=root/".config"/"pip";directory.mkdir(mode=0o700,parents=True,exist_ok=True);config=directory/"pip.conf";config.write_text("[global]\\nno-index = true\\nfind-links = /workspace/readonly/wheels\\n");config.chmod(0o600)', state]);
  return JSON.parse(wheel.stdout) as unknown;
}

export async function observeX2Package(client: X2Docker, container: string, state: string): Promise<Record<string, unknown>> {
  const output = await client.docker(['exec', '--user', 'cauce', container, 'python3', '-I', '-B', '-c',
    'import importlib.metadata,json,pathlib,site,sys;root=pathlib.Path(sys.argv[1])/".local"/"lib";paths=list(root.glob("python*/site-packages"));[site.addsitedir(str(p)) for p in paths];import cauce_x2_probe;dist=importlib.metadata.distribution("cauce-x2-probe");print(json.dumps({"version":dist.version,"moduleVersion":cauce_x2_probe.__version__,"proof":cauce_x2_probe.proof(),"location":str(pathlib.Path(cauce_x2_probe.__file__).resolve()),"metadata":str(dist._path)}))', state]);
  const result = JSON.parse(output) as Record<string, unknown>;
  if (result.version !== '1.0.0' || result.moduleVersion !== '1.0.0' || result.proof !== 'X2-PIP-INSTALLED'
    || !String(result.location).startsWith(`${state}/.local/lib/`)) throw new Error('the real pinned package did not execute from its state prefix');
  return result;
}

export async function diagnoseX2Policy(computer: ComputerHarness): Promise<unknown> {
  const script = String.raw`import json,pathlib,subprocess,sys
paths=list(pathlib.Path(sys.argv[1]).rglob('executor-policy.json'))
if len(paths)!=1:raise RuntimeError('owned executor policy is ambiguous')
policy=json.loads(paths[0].read_bytes())
executor=pathlib.Path(policy['bundles']['codex']['directory']).parent/'ops'/'cli'/'fleet-executor.py'
result=subprocess.run([sys.executable,'-B',str(executor),'--policy',str(paths[0]),'--capabilities'],capture_output=True,text=True,timeout=35,check=False)
sys.path.insert(0,str(executor.parent))
from fleet_executor_policy import load_policy
from fleet_executor_templates import fleet_harnesses,runtime_candidates
from fleet_executor_authority import authority_ready,signed_call
approved=load_policy(paths[0]);predicates={'eligibleHarnesses':sorted(fleet_harnesses(approved)),'runtimeCount':len(runtime_candidates(approved)),'authorityReady':authority_ready(approved)}
if not predicates['authorityReady']:
 try:predicates['authorityProbe']=signed_call(approved['authority'],{'action':'ready'})
 except Exception as error:predicates['authorityError']={'type':type(error).__name__,'message':str(error)}
print(json.dumps({'policy':str(paths[0]),'executor':str(executor),'code':result.returncode,'stdout':result.stdout,'stderr':result.stderr,'predicates':predicates}))
`;
  return computer.onComputer(['python3', '-I', '-B', '-c', script, computer.installRoot]);
}

export interface X2SshTarget {
  destination: string;
  host: string;
  authorize(publicKey: string): Promise<void>;
  observe(container: string, nonce: string): Promise<Record<string, unknown>>;
  startBrowser(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function startX2SshTarget(client: X2Docker, prefix: string, owner: string, baseImage: string, network: string): Promise<X2SshTarget> {
  const image = `${prefix}:x2-ssh`, base = `${prefix}:x2-base`, name = `${prefix}-x2-ssh`, browser = `${prefix}-x2-remote-browser`;
  await client.docker(['image', 'tag', baseImage, base]);
  const recipe = `FROM ${base}\nRUN printf '#!/bin/sh\\nexit 101\\n' > /usr/sbin/policy-rc.d && chmod 0755 /usr/sbin/policy-rc.d \\\n && apt-get update && apt-get install -y --no-install-recommends openssh-server \\\n && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \\\n && useradd -m -u 1700 -s /bin/sh -p '' canary && mkdir -p /run/sshd\n`;
  const built = await client.command(['build', '-q', '--label', `cauce.e2e.owner=${owner}`, '-t', image, '-'], recipe);
  if (built.code !== 0) throw new Error(`owned sshd image could not be built: ${built.stderr}`);
  await client.docker(['run', '-d', '--name', name, '--network', network, '--label', `cauce.e2e.owner=${owner}`, '--pids-limit', '128', image, '/bin/sleep', 'infinity']);
  await client.docker(['exec', name, 'ssh-keygen', '-A']);
  const host = await client.docker(['inspect', '--format', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name]);
  const hostKey = await client.docker(['exec', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(host) || !hostKey.startsWith('ssh-ed25519 ')) throw new Error('owned sshd public endpoint is invalid');
  const setup = String.raw`import os,pathlib,subprocess
directory=pathlib.Path('/home/canary/.ssh');directory.mkdir(mode=0o700)
os.chown(directory,1700,1700)
key=directory/'authorized_keys';key.write_text('');key.chmod(0o600);os.chown(key,1700,1700)
config=pathlib.Path('/etc/ssh/sshd_config.x2')
config.write_text('Port 22\nListenAddress 0.0.0.0\nHostKey /etc/ssh/ssh_host_ed25519_key\nAuthorizedKeysFile /home/canary/.ssh/authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes yes\nPermitRootLogin no\nAllowUsers canary\nPidFile /run/sshd-x2.pid\nLogLevel VERBOSE\n')
log=open('/tmp/x2-sshd.log','wb')
subprocess.Popen(['/usr/sbin/sshd','-D','-e','-f',str(config)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
`;
  await client.docker(['exec', name, 'python3', '-I', '-B', '-c', setup]);
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const probe = await client.command(['exec', name, 'python3', '-I', '-B', '-c', 'import socket;connection=socket.create_connection(("127.0.0.1",22),1);print(connection.recv(64).decode());connection.close()']);
    if (probe.code === 0 && probe.stdout.startsWith('SSH-')) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('owned sshd did not listen');
  const knownHosts = `${host},[${host}]:22 ${hostKey.split(' ').slice(0, 2).join(' ')}\n`;
  return {
    destination: `canary@${host}:22`, host,
    authorize: async publicKey => {
      if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/u.test(publicKey)) throw new Error('only the public UI key can authorize the owned sshd');
      const result = await client.command(['exec', '-i', name, 'python3', '-I', '-B', '-c',
        'import os,pathlib,sys;path=pathlib.Path("/home/canary/.ssh/authorized_keys");path.write_text(sys.stdin.read().strip()+"\\n");path.chmod(0o600);os.chown(path,1700,1700)'], publicKey);
      if (result.code !== 0) throw new Error('the public UI key could not be authorized');
    },
    observe: async (container, nonce) => {
      const script = String.raw`import hashlib,json,pathlib,subprocess,sys
packet=json.load(sys.stdin)
configs=list(pathlib.Path('/home/cauce/.cauce-profiles').rglob('ssh/config'))
if len(configs)!=1:raise RuntimeError('public SSH config is ambiguous')
known=configs[0].parent/'known_hosts';known.write_text(packet['known']);known.chmod(0o600)
remote="import json,os,pathlib\nvalue="+repr(packet['nonce'])+"\npath=pathlib.Path.home()/'.cauce-x2-effect'\npath.write_text(value)\nprint(json.dumps({'nonce':path.read_text(),'uid':os.getuid(),'file':str(path)}))\n"
result=subprocess.run(['ssh','-F',str(configs[0]),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5','-p','22',packet['target'],'python3','-'],input=remote,capture_output=True,text=True,timeout=15,check=False)
print(json.dumps({'code':result.returncode,'stdout':result.stdout,'stderr':result.stderr,'config':str(configs[0]),'knownHostsSha256':hashlib.sha256(known.read_bytes()).hexdigest()}))
`;
      const output = await client.command(['exec', '-i', '--user', 'cauce', container, 'python3', '-I', '-B', '-c', script],
        JSON.stringify({ known: knownHosts, nonce, target: `canary@${host}` }));
      if (output.code !== 0) throw new Error(`owned SSH observation failed: ${output.stderr}`);
      const receipt = JSON.parse(output.stdout) as Record<string, unknown>;
      if (receipt.code !== 0) throw new Error(`the owned SSH session failed: ${String(receipt.stderr)}`);
      const remote = JSON.parse(String(receipt.stdout)) as { nonce?: string; uid?: number };
      const observed = await client.docker(['exec', name, 'cat', '/home/canary/.cauce-x2-effect']);
      if (remote.nonce !== nonce || remote.uid !== 1700 || observed !== nonce) throw new Error('the owned SSH session did not produce its remote nonce');
      return { ...receipt, remote, destination: `canary@${host}:22`, marker: observed, publicHostKey: hostKey,
        publicHostKeySha256: createHash('sha256').update(hostKey).digest('hex') };
    },
    startBrowser: async () => {
      const id = await client.docker(['run', '-d', '--name', browser, '--network', `container:${name}`,
        '--label', `cauce.e2e.owner=${owner}`, '--shm-size', '268435456', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', X2_BROWSER_IMAGE]);
      return { container: browser, id, image: X2_BROWSER_IMAGE, sharesNamespaceWith: name };
    },
    close: async () => {
      for (const target of [browser, name]) {
        const current = await client.command(['inspect', '--format', '{{.Id}}', target]);
        if (current.code === 0) await client.docker(['rm', '-f', target]);
      }
      for (const tag of [image, base]) {
        const current = await client.command(['image', 'inspect', '--format', '{{.Id}}', tag]);
        if (current.code === 0) await client.docker(['image', 'rm', '-f', tag]);
      }
    },
  };
}

export async function diagnoseX2Restart(client: X2Docker, container: string, runtime: string): Promise<unknown> {
  const script = String.raw`import hashlib,json,os,pathlib,re,stat,subprocess,sys
sys.path.insert(0,'/cauce/lifecycle')
from cauce_container_base import open_control_directory
from cauce_container_proc import matched_fs_credentials,read_metadata
from cauce_container_restart import process_identity,shared_pane,tmux_absent
result={'commands':[],'sourceSha256':{}}
for name in ['cauce_container_base.py','cauce_container_proc.py','cauce_container_restart.py','cauce-container-runtime.py']:
 result['sourceSha256'][name]=hashlib.sha256(pathlib.Path('/cauce/lifecycle',name).read_bytes()).hexdigest()
def identity(pid):
 try:
  path=pathlib.Path('/proc')/str(pid);fields=(path/'stat').read_text().rsplit(') ',1)[1].split()
  return {'pid':pid,'uid':path.stat().st_uid,'startTicks':int(fields[19]),'state':fields[0]}
 except OSError:return {'pid':pid,'absent':True}
try:
 control=open_control_directory('/run/cauce-fleet/'+sys.argv[1])
 try:document,_=read_metadata(control)
 finally:os.close(control)
 result['metadata']={name:document.get(name) for name in ['phase','alias','wireAlias','stopAuthority','runtimeUid','runtimeGid','pid','starttime','controllerPid','controllerStarttime','containerGeneration','bundleDigest']} if document else None
 if document:
  result['identities']=[identity(document['pid']),identity(document['controllerPid'])]
  original=process_identity(document['pid'])
  assert original==(document['starttime'],document['runtimeUid'])
  with matched_fs_credentials(document['runtimeUid'],document['runtimeGid']):
   selected=(pathlib.Path('/proc')/str(document['pid'])/'environ').read_bytes().split(b'\0')
   values={name:[item.partition(b'=')[2] for item in selected if item.partition(b'=')[0]==name]
           for name in [b'CAUCE_BOOTSTRAP',b'CAUCE_SHARED_SESSION']}
  assert process_identity(document['pid'])==original
  def flag(name):
   found=values[name]
   return {'verifiedPid':document['pid'],'verifiedStartTicks':original[0],'verifiedUid':original[1],
           'value':found[0].decode() if len(found)==1 and found[0] in [b'0',b'1'] else 'absent' if not found else 'invalid'}
  result['bootstrapFlag']=flag(b'CAUCE_BOOTSTRAP')
  result['sharedSessionFlag']=flag(b'CAUCE_SHARED_SESSION')
  result['tmuxAbsent']=tmux_absent()
  pane=shared_pane(document);result['sharedPane']=pane is not None
  result['sharedPaneReturnedNone']=pane is None
  if pane:
   result['target']=pane.target;result['runtimeIdentity']={'uid':pane.uid,'gid':pane.gid}
   result['tmuxEnvironment']={key:pane.environment[key] for key in ['HOME','PATH','LANG','TMUX_TMPDIR'] if key in pane.environment}
   socket=pathlib.Path(pane.environment.get('TMUX_TMPDIR','/tmp'))/('tmux-'+str(pane.uid))/'cauce'
   result['socketStats']=[]
   for path in [socket.parent.parent,socket.parent,socket]:
    row={'path':str(path)}
    try:
     observed=path.lstat();row.update(exists=True,uid=observed.st_uid,gid=observed.st_gid,mode=oct(stat.S_IMODE(observed.st_mode)),inode=observed.st_ino,isSocket=stat.S_ISSOCK(observed.st_mode))
    except FileNotFoundError:row['exists']=False
    result['socketStats'].append(row)
   def read(arguments):
    command=['/usr/bin/tmux','-N','-L','cauce',*arguments]
    row={'command':command}
    try:
     value=subprocess.run(command,capture_output=True,timeout=4,check=False,env=pane.environment,cwd='/',**pane.credentials)
     row.update(exitCode=value.returncode,stderr=value.stderr.decode(errors='replace')[:1024],stdoutBytes=len(value.stdout),stdoutSha256=hashlib.sha256(value.stdout).hexdigest())
     return value.stdout if value.returncode==0 else None
    except (OSError,subprocess.TimeoutExpired) as error:row['error']=type(error).__name__
    finally:result['commands'].append(row)
   for scope in [('-g',),(),('-w',),('-p',)]:read(['show-hooks',*scope,'-t',pane.target])
   read(['show-options','-s','command-alias'])
   fields=read(['list-panes','-t',pane.target,'-F','#{pane_id}|#{pane_pid}|#{pane_input_off}|#{@cauce_input_barrier}'])
   if fields is not None:
    lines=fields.decode(errors='replace').splitlines()
    if len(lines)==1 and re.fullmatch(r'%[0-9]+',lines[0].split('|')[0]):
     read(['capture-pane','-p','-e','-t',lines[0].split('|')[0]])
except Exception as error:result['error']={'type':type(error).__name__,'message':str(error)[:512]}
print(json.dumps(result))`;
  const result = await client.command(['exec', '--user', '0', container, 'python3', '-I', '-B', '-c', script, runtime]);
  return { code: result.code, stderr: result.stderr.slice(0, 1024),
    observed: result.code === 0 ? JSON.parse(result.stdout) as unknown : { stdoutBytes: Buffer.byteLength(result.stdout),
      stdoutSha256: createHash('sha256').update(result.stdout).digest('hex') } };
}

export const X2_ADMISSION_DIAGNOSTICS = String.raw`import json
import pathlib
import sys


def document(path):
    if not path.is_file() or path.is_symlink():
        return None
    return json.loads(path.read_bytes())


def pointer(path):
    value = document(path)
    return {'exists': value is not None, 'generation': value.get('generation') if isinstance(value, dict) else None}


root = pathlib.Path(sys.argv[1])
runtime = sys.argv[2]
result = []
for filename in root.rglob('executor-policy.json'):
    policy = document(filename)
    state = pathlib.Path(policy['roots']['state'])
    item = {
        'policy': str(filename),
        'stateRoot': str(state),
        'hostId': policy.get('host_id'),
        'desired': pointer(state / 'desired-fleet.json'),
        'applied': pointer(state / 'applied-fleet.json'),
        'templates': [{name: row.get(name) for name in ('harness_id', 'runtime_user', 'home_directory', 'state_root')}
                      for row in policy.get('container_templates', [])],
        'operations': [],
        'generations': [],
    }
    for operation in (state / 'operations').glob('*'):
        effects = document(operation / 'effects.json')
        if not isinstance(effects, dict):
            continue
        verified = effects.get('verified')
        item['operations'].append({
            'id': operation.name,
            'journalKeys': sorted(effects),
            'attemptedSteps': effects.get('attempted'),
            'verified': {name: verified.get(name) is True for name in
                         ('provider_verified', 'profile_verified', 'bootstrap_verified', 'roundtrip_verified')}
                        if isinstance(verified, dict) else None,
            'generation': effects.get('generation'),
            'expectedApplied': effects.get('expected_applied'),
            'bootstrapCredentialsPrepared': bool(effects.get('bootstrap_credentials')),
            'normalCredentialsPrepared': bool(effects.get('normal_credentials')),
            'admissionRecorded': isinstance(effects.get('admission'), dict),
            'normalProofRecorded': isinstance(effects.get('admission_normal_proof'), dict),
            'replacementRetirementRecorded': isinstance(effects.get('replacement_retirement'), dict),
        })
    for generation in (state / 'generations').glob('*'):
        fleet = document(generation / 'flota.json')
        if not isinstance(fleet, dict):
            continue
        public = {}
        for section in ('fleet', 'bootstrap'):
            row = fleet.get(section, {}).get(runtime)
            public[section] = ({name: row.get(name) for name in ('tenant', 'alias', 'hostId', 'enabled',
                               'lifecycleState', 'runtimeStateDirectory', 'home', 'room')}
                              if isinstance(row, dict) else None)
        item['generations'].append({'generation': generation.name, 'target': public,
                                    'bootstrapPresent': runtime in fleet.get('bootstrap', {})})
    result.append(item)
print(json.dumps(result, sort_keys=True))`;
