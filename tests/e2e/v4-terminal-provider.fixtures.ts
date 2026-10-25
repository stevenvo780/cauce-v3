import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { reserveNamedLoopbackPorts } from './port-reservation.js';

const execute = promisify(execFile);
export type RealTuiHarness = 'claude' | 'codex' | 'grok' | 'muse' | 'openclaw';
export interface ProviderTuiOptions { readonly realTuiHarness?: RealTuiHarness; readonly openclawGateway?: boolean }

export async function providerTuiVersion(container: string, harness: RealTuiHarness): Promise<string> {
  const { stdout } = await execute('docker', ['exec', '--user', 'node', container, harness, '--version'], { timeout: 30_000 });
  return stdout.trim();
}

export async function readShellCanary(container: string, nonce: string): Promise<string> {
  if (!/^SHELL-[a-f0-9-]{36}$/u.test(nonce)) throw new Error('invalid shell canary');
  return (await execute('docker', ['exec', '--user', 'node', container, 'cat', `/tmp/${nonce}`], { timeout: 15_000 })).stdout;
}

export async function openclawFixtureDiagnostics(container: string): Promise<string> {
  const script = `import hashlib,json,os,pathlib
root=pathlib.Path('/home/node/.openclaw/agents/main/sessions')
state={}
try:
 raw=(root/'sessions.json').read_bytes(); document=json.loads(raw); state['store_sha256']=hashlib.sha256(raw).hexdigest()
 state['sessions']={}
 for key,entry in document.items():
  path=pathlib.Path(entry.get('sessionFile','')).resolve()
  item={field:entry.get(field) for field in ['sessionId','thinkingLevel','modelProvider','model']}
  item['file']=path.name
  if path.is_relative_to(root):
   body=path.read_bytes(); item.update(sha256=hashlib.sha256(body).hexdigest(),history_marker=b'CAUCE-CANARY-EXISTING-HISTORY' in body)
  state['sessions'][key]=item
except (OSError,ValueError,AttributeError) as error: state['store_error']=type(error).__name__
state['processes']=[]
for name in os.listdir('/proc'):
 if not name.isdigit(): continue
 try:
  command=pathlib.Path('/proc',name,'cmdline').read_bytes().split(bytes([0]))
  if b'/usr/local/lib/node_modules/openclaw/dist/entry.js' not in command: continue
  fields=pathlib.Path('/proc',name,'stat').read_text().split(') ',1)[1].split()
  state['processes'].append({'pid':int(name),'mode':'tui' if b'tui' in command else 'gateway','status':fields[0],'wchan':pathlib.Path('/proc',name,'wchan').read_text()})
 except (OSError,ValueError,IndexError): continue
print(json.dumps(state))
`;
  return (await execute('docker', ['exec', '--user', 'node', container, 'python3', '-c', script], { timeout: 15_000 })).stdout;
}

const packages: Record<Exclude<RealTuiHarness, 'muse'>, string> = {
  claude: '@anthropic-ai/claude-code@2.1.296',
  codex: '@openai/codex@0.160.1',
  grok: '@xai-official/grok@1.0.41',
  openclaw: 'openclaw@2026.7.1-2',
};

export function providerTuiDockerfile(harness: RealTuiHarness): string {
  if (harness !== 'muse') return `RUN npm install --global --no-audit --no-fund ${packages[harness]} && npm cache clean --force\n`;
  return `RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL --proto '=https' --tlsv1.2 -o /usr/local/bin/muse 'https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.10-R6427.1&file=muse-x86-linux' \\
 && echo 'decefc0fb33c48ee43419c3e72ac2dbc781743868611074c7292807f5960dfcf  /usr/local/bin/muse' | sha256sum -c - \\
 && chmod 0555 /usr/local/bin/muse
`;
}

export function openclawFixtureBundle(gateway = false) {
  return {
    openclaw_tui: { node: '/usr/local/bin/node', entry: '/usr/local/lib/node_modules/openclaw/dist/entry.js', state_directory: '/home/node/.cauce', history_limit: 50, local: !gateway },
    session_recovery: { state_directory: '/home/node/.cauce', adapter_generation: 'a'.repeat(64) },
  };
}

export async function initializeOpenclawTui(container: string, alias: string, tenant: string, id: string, gateway: boolean): Promise<void> {
  const document = JSON.stringify({ version: 1, sessions: { [`openclaw:${alias}:shared:${alias}`]: { native_id: 'agent:main:canary', initialized: true } } });
  const nativeId = randomUUID();
  const timestamp = new Date().toISOString();
  const sessionFile = `/home/node/.openclaw/agents/main/sessions/${nativeId}.jsonl`;
  const history = [
    { type: 'session', version: 3, id: nativeId, timestamp, cwd: '/home/node' },
    { type: 'message', id: 'canary-history', parentId: null, timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'CAUCE-CANARY-EXISTING-HISTORY' }], timestamp: Date.now() } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  const providerSessions = JSON.stringify({ 'agent:main:canary': { sessionId: nativeId, updatedAt: Date.now(), sessionFile, thinkingLevel: 'medium' } });
  await execute('docker', ['exec', '--user', 'node', container, 'python3', '-c',
    'import os,sys; paths=["/home/node/.cauce","/home/node/.openclaw/agents/main/agent","/home/node/.openclaw/agents/main/sessions","/home/node/.openclaw/.external-cli-disabled","/home/node/tmp","/home/node/node-compile-cache"]; [(os.makedirs(p,mode=0o700,exist_ok=True),os.chmod(p,0o700)) for p in paths]; files={"/home/node/.cauce/sessions.json":sys.argv[1],"/home/node/.openclaw/agents/main/sessions/sessions.json":sys.argv[2],sys.argv[3]:sys.argv[4],"/home/node/.openclaw/openclaw.json":"{}"}; [(open(p,"w").write(v),os.chmod(p,0o600)) for p,v in files.items()]', document, providerSessions, sessionFile, history], { timeout: 15_000 });
  const reserved = gateway ? await reserveNamedLoopbackPorts(['gateway']) : undefined;
  const gatewayPort = reserved?.ports.gateway;
  await reserved?.releaseAll();
  const gatewayScript = `import json,os,secrets,socket,subprocess,time
env=dict(os.environ,OPENCLAW_GATEWAY_TOKEN=secrets.token_urlsafe(32))
port=${String(gatewayPort ?? 0)}
with open(env['OPENCLAW_CONFIG_PATH'],'w') as stream: json.dump({'gateway':{'mode':'local','port':port,'auth':{'mode':'token'}}},stream)
child=subprocess.Popen(['/usr/local/bin/node','/usr/local/lib/node_modules/openclaw/dist/entry.js','gateway','--allow-unconfigured','--bind','loopback','--port',str(port),'--auth','token'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
for attempt in range(150):
 if child.poll() is not None: raise SystemExit('canary gateway exited before listening')
 try:
  connection=socket.create_connection(('127.0.0.1',port),timeout=0.2); connection.close(); break
 except OSError: time.sleep(0.2)
else: raise SystemExit('canary gateway did not open')
open('/home/node/.cauce/gateway-ready','w').write('ready')
os.execvpe('sleep',['sleep','900'],env)
`;
  await execute('docker', ['exec', '--detach', '--user', 'node',
    '--env', `CAUCE_RUNTIME_KEY=${alias}`, '--env', `CAUCE_ALIAS=${alias}`, '--env', `CAUCE_TENANT_ID=${tenant}`,
    '--env', 'CAUCE_STATE_DIR=/home/node/.cauce', '--env', `CAUCE_CONTAINER_ID=${id}`,
    '--env', `CAUCE_CONTAINER_GENERATION=${'a'.repeat(64)}`, '--env', `CAUCE_OPENCLAW_LOCAL=${gateway ? '0' : '1'}`,
    '--env', 'CAUCE_OPENCLAW_AGENT_ID=main', '--env', 'OPENCLAW_HOME=/home/node',
    '--env', 'OPENCLAW_STATE_DIR=/home/node/.openclaw', '--env', 'OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json',
    '--env', 'OPENCLAW_AGENT_DIR=/home/node/.openclaw/agents/main/agent', '--env', 'TMPDIR=/home/node/tmp',
    '--env', 'CODEX_HOME=/home/node/.openclaw/.external-cli-disabled', '--env', 'CLAUDE_CONFIG_DIR=/home/node/.openclaw/.external-cli-disabled',
    '--env', 'NODE_COMPILE_CACHE=/home/node/node-compile-cache', container,
    ...(gateway ? ['python3', '-c', gatewayScript] : ['sleep', '900'])], { timeout: 15_000 });
  if (gateway) await execute('docker', ['exec', '--user', 'node', container, 'python3', '-c',
    'import os,time; deadline=time.monotonic()+35\nwhile not os.path.exists("/home/node/.cauce/gateway-ready") and time.monotonic()<deadline: time.sleep(0.2)\nassert os.path.exists("/home/node/.cauce/gateway-ready"), "canary gateway unavailable"'], { timeout: 40_000 });
}

export async function initializeProviderTui(container: string, socket: string, alias: string, harness: RealTuiHarness, tenant: string, id: string, gateway = false): Promise<void> {
  if (harness === 'openclaw') return initializeOpenclawTui(container, alias, tenant, id, gateway);
  if (harness === 'claude') await execute('docker', ['exec', '--user', 'node', container, 'python3', '-c',
    'import json; json.dump({"hasCompletedOnboarding":True,"theme":"dark","customApiKeyResponses":{"approved":["zz-canary-not-a-real-key"[-20:]],"rejected":[]},"projects":{"/home/node":{"hasTrustDialogAccepted":True,"hasCompletedProjectOnboarding":True}}},open("/home/node/.claude.json","w"))'], { timeout: 15_000 });
  if (harness === 'grok') await execute('docker', ['exec', '--user', 'node', container, 'python3', '-c',
    'import os,sys; os.makedirs("/home/node/.grok",mode=0o700,exist_ok=True); open("/home/node/.grok/config.toml","w").write(sys.argv[1])',
    '[auth]\npreferred_method = "api_key"\n[model.canary]\nmodel = "canary"\nbase_url = "http://127.0.0.1:9/v1"\napi_key = "zz-canary-not-a-real-key"\n[models]\ndefault = "canary"\n[endpoints]\nxai_api_base_url = "http://127.0.0.1:9/v1"\nmodels_base_url = "http://127.0.0.1:9"\n'], { timeout: 15_000 });
  await execute('docker', ['exec', '--user', 'node', container, 'python3', '-c',
    'open("/tmp/tmux-provider.conf","w").write("set -g remain-on-exit on\\n")'], { timeout: 15_000 });
  const session = `cauce-${alias}`;
  const tmux = ['exec', '--user', 'node', '--env', 'TERM=xterm-256color', container, '/usr/bin/tmux', '-f', '/tmp/tmux-provider.conf', '-L', socket];
  const command: Record<Exclude<RealTuiHarness, 'openclaw'>, string> = {
    claude: 'env ANTHROPIC_API_KEY=zz-canary-not-a-real-key ANTHROPIC_BASE_URL=http://127.0.0.1:9 DISABLE_AUTOUPDATER=1 claude',
    codex: `codex --no-alt-screen -c 'model_provider="canary"' -c 'model_providers.canary.name="Canary"' -c 'model_providers.canary.base_url="http://127.0.0.1:9/v1"' -c 'model_providers.canary.wire_api="responses"'`,
    grok: 'env XAI_API_KEY=zz-canary-not-a-real-key GROK_DISABLE_AUTOUPDATER=1 grok',
    muse: 'env MUSE_NO_AUTO_UPDATE=1 muse --provider echo --trust-workspace --disable-write --disable-shell',
  };
  await execute('docker', [...tmux, 'new-session', '-d', '-s', session, '-n', 'agente', '-x', '100', '-y', '30', command[harness]], { timeout: 15_000 });
  await execute('docker', [...tmux, 'set-option', '-t', session, '@cauce_alias', alias], { timeout: 15_000 });
  await execute('docker', [...tmux, 'set-option', '-t', session, '@cauce_harness', harness], { timeout: 15_000 });
}
