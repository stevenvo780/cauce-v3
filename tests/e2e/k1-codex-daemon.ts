import type { startK1CodexRuntime } from './k1-codex-runtime.js';
import { k1Receipt } from './k1-codex-runtime.js';

type Runtime = Awaited<ReturnType<typeof startK1CodexRuntime>>;
export interface K1DaemonIdentity {
  pid: number; starttime: string; executable_sha256: string; settings_sha256: string; socket_present: boolean;
}

export async function configureK1Daemon(runtime: Runtime, responsesUrl: string) {
  const configured = (await runtime.exec(['python3', '-I', '-B', '-c', `import hashlib,json,os,pathlib,shlex,sys
home=pathlib.Path('/home/node/.codex');home.mkdir(mode=448,exist_ok=True)
for path in ['/home/node/space','/home/node/.cauce']:
 pathlib.Path(path).mkdir(mode=448)
binary=[]
for candidate in pathlib.Path('/usr/local/lib/node_modules/@openai').rglob('codex'):
 if candidate.is_file() and os.access(candidate,os.X_OK):
  with candidate.open('rb') as stream:
   if stream.read(4)==bytes([127,69,76,70]):binary.append(candidate)
if len(binary)!=1:raise SystemExit('the pinned native Codex executable is not unique')
native=binary[0]
managed=home/'packages/app-server-daemon/current/bin/codex'
managed.parent.mkdir(parents=True,mode=448);managed.symlink_to(native)
settings=home/'app-server-daemon/settings.json';settings.parent.mkdir(mode=448)
settings.write_text(json.dumps({'shutdownGraceSeconds':0,'updater':{'autoUpdateEnabled':False},'featureOverrides':{'api_key_model_discovery':True}}))
config='model="gpt-5.4"\\nmodel_provider="k1"\\nmodel_reasoning_effort="low"\\nsuppress_unstable_features_warning=true\\nanalytics.enabled=false\\ntui.disable_paste_burst=true\\n[projects."/home/node/space"]\\ntrust_level="trusted"\\n[model_providers.k1]\\nname="K1 local fixture"\\nbase_url='+json.dumps(sys.argv[1])+'\\nwire_api="responses"\\nrequires_openai_auth=false\\n'
(home/'config.toml').write_text(config)
wrapper=pathlib.Path('/home/node/k1-codex')
wrapper.write_text('#!/bin/sh\\nexec '+shlex.quote(str(native))+' --disable api_key_model_discovery "$@"\\n');wrapper.chmod(448)
pathlib.Path('/home/node/k1-tmux.conf').write_text('set -g remain-on-exit on\\n')
print(json.dumps({'command':str(wrapper),'sha256':hashlib.sha256(wrapper.read_bytes()).hexdigest(),
 'files':{str(native):hashlib.sha256(native.read_bytes()).hexdigest()}}))`, responsesUrl])).stdout;
  const pins = JSON.parse(configured) as { command: string; sha256: string; files: Record<string, string> };
  await runtime.exec(['/usr/local/bin/codex', 'app-server', 'daemon', 'start'], 60_000);
  await k1Receipt('daemon-setup.json', { official_source_commit: '6aaac694803004a63c6f393d153c96d22521a6b9',
    feature_overrides: { api_key_model_discovery: true }, tui_explicit_override: false,
    command_sha256: pins.sha256, native_file_pins: pins.files });
  return pins;
}

export async function k1DaemonIdentity(runtime: Runtime): Promise<K1DaemonIdentity> {
  return JSON.parse((await runtime.exec(['python3', '-I', '-B', '-c', `import hashlib,json,pathlib
home=pathlib.Path('/home/node/.codex');receipt=json.loads((home/'app-server-daemon/daemon.pid').read_text())
pid=receipt['pid'];process=pathlib.Path('/proc')/str(pid);stat=(process/'stat').read_text();fields=stat[stat.rfind(')')+1:].split()
print(json.dumps({'pid':pid,'starttime':fields[19],
 'executable_sha256':hashlib.sha256((process/'exe').read_bytes()).hexdigest(),
 'settings_sha256':hashlib.sha256((home/'app-server-daemon/settings.json').read_bytes()).hexdigest(),
 'socket_present':(home/'app-server-control/app-server-control.sock').is_socket()}))`])).stdout) as K1DaemonIdentity;
}

export async function probeK1Daemon(runtime: Runtime): Promise<boolean> {
  const result = await runtime.exec(['node', '--input-type=module', '-e', `import WebSocket from '/cauce-sdk/vendor/ws/wrapper.mjs';
const socket=new WebSocket('ws+unix:///home/node/.codex/app-server-control/app-server-control.sock:/');
const timer=setTimeout(()=>{socket.terminate();process.exitCode=1},10000);
socket.on('open',()=>socket.send(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'k1_canary',version:'1.0.0'},capabilities:{experimentalApi:true}}})));
socket.on('message',bytes=>{const packet=JSON.parse(bytes.toString());if(packet.id!==1)return;
const valid=packet.result!==undefined&&packet.error===undefined;
console.log(JSON.stringify({initialize_ok:valid}));clearTimeout(timer);socket.close();if(!valid)process.exitCode=1});
socket.on('error',()=>{clearTimeout(timer);process.exitCode=1});`], 15_000);
  return (JSON.parse(result.stdout) as { initialize_ok: boolean }).initialize_ok;
}

export async function captureK1Mismatch(runtime: Runtime, command: string): Promise<string> {
  await runtime.tmux(['-f', '/home/node/k1-tmux.conf', 'new-session', '-d', '-s', 'k1-baseline', '-n', 'agente', '-x', '120', '-y', '40',
    '-c', '/home/node/space', command, '--yolo', '--no-alt-screen']);
  let captured = '';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    captured = (await runtime.tmux(['capture-pane', '-p', '-J', '-S', '-100', '-t', 'k1-baseline:agente'])).stdout;
    if (captured.includes('Background server has incompatible feature settings')) break;
    if ((await runtime.tmux(['display-message', '-p', '-t', 'k1-baseline:agente', '#{pane_dead}'])).stdout.trim() === '1') break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await k1Receipt('baseline-dialog.txt', captured);
  await k1Receipt('baseline-pane.txt', (await runtime.tmux(['display-message', '-p', '-t', 'k1-baseline:agente',
    '#{pane_dead}|#{pane_dead_status}|#{pane_start_command}'])).stdout);
  await runtime.tmux(['kill-session', '-t', 'k1-baseline']);
  return captured;
}
