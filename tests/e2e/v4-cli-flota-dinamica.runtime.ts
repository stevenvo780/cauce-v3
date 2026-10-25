import { execFile } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { FIXTURE_PROVIDER_IDENTITY, type ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';

const execute = promisify(execFile);
const workspace = process.cwd();
export const FLEET_CLI_PROVIDER_FIXTURE = { synthetic_provider_cli: true, vendor_tui: false,
  simulated: ['provider_account', 'bootstrap_nonce_response', 'native_conversation'] } as const;
const provider = `#!/usr/local/bin/python3
import json,os,pathlib,re,signal,sys,termios,tty,uuid
if 'app-server' in sys.argv:
 for line in sys.stdin:
  packet=json.loads(line)
  if 'id' in packet:
   result={'account':{'type':'chatgpt','email':'${FIXTURE_PROVIDER_IDENTITY}'}} if packet['method']=='account/read' else {}
   print(json.dumps({'id':packet['id'],'result':result}),flush=True)
 sys.exit(0)
if 'exec' in sys.argv:
 prompt=' '.join(sys.argv[1:]) if sys.argv[-1]!='-' else sys.stdin.read()
 nonce=re.search(r'CAUCE_BOOTSTRAP_[a-f0-9]{64}',prompt)
 if nonce is None: sys.exit(1)
 print(json.dumps({'type':'thread.started','thread_id':'host-setup-fixture'}))
 print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':nonce.group(0)}}))
 sys.exit(0)
home=pathlib.Path(os.environ['CODEX_HOME']);sessions=home/'sessions'
sessions.mkdir(parents=True,exist_ok=True,mode=448)
native=sys.argv[sys.argv.index('resume')+1] if 'resume' in sys.argv else str(uuid.uuid4())
if native=='--last':
 files=sorted(sessions.glob('rollout-cli-*.jsonl'),key=lambda p:p.stat().st_mtime)
 if not files: sys.exit(3)
 native=re.search(r'([a-f0-9-]{36})[.]jsonl$',files[-1].name).group(1)
file=sessions/('rollout-cli-'+native+'.jsonl');memory=home/('cli-memory-'+native+'.json')
def append(value):
 with file.open('a') as stream: stream.write(json.dumps(value)+chr(10));stream.flush();os.fsync(stream.fileno())
if not file.exists(): append({'type':'session_meta','payload':{'id':native,'source':'cli','cwd':os.getcwd()}})
signal.signal(signal.SIGINT,lambda *_:sys.exit(130))
print('CLI_NATIVE_READY:'+native,flush=True)
original=termios.tcgetattr(sys.stdin.fileno());tty.setraw(sys.stdin.fileno())
sys.stdout.write(chr(27)+'[?2004h'+'\\r\\n› ');sys.stdout.flush()
pending='';pasting=False
while True:
 chunk=os.read(sys.stdin.fileno(),4096).decode(errors='replace')
 if not chunk: break
 pending+=chunk
 if chr(27)+'[200~' in pending: pasting=True
 if chr(27)+'[201~' in pending: pasting=False
 sys.stdout.write(chunk.replace(chr(27)+'[200~','').replace(chr(27)+'[201~','').replace('\\n','\\r\\n'));sys.stdout.flush()
 if pasting or not pending.endswith(('\\r','\\n')): continue
 text=pending.replace(chr(27)+'[200~','').replace(chr(27)+'[201~','').replace('\\r','\\n').strip();pending='';turn=str(uuid.uuid4())
 append({'type':'event_msg','payload':{'type':'task_started','turn_id':turn}})
 append({'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':text}],'internal_chat_message_metadata_passthrough':{'turn_id':turn}}})
 remember=re.search(r'REMEMBER ([A-Za-z0-9-]+)',text)
 if remember:
  memory.write_text(json.dumps({'marker':remember.group(1)}));answer='STORED:'+remember.group(1)
 elif 'RECALL' in text: answer='RECALLED:'+json.loads(memory.read_text())['marker']
 else: answer='REPLY:'+text
 correlation=re.search(r'"cauce_correlation_id":"([a-f0-9]{64})"',text)
 if correlation: answer=json.dumps({'reply':answer,'messages':[],'status':'done','retryable':False,'artifacts':[],'cauce_correlation_id':correlation.group(1)})
 append({'type':'event_msg','payload':{'type':'task_complete','turn_id':turn,'last_agent_message':answer}})
 sys.stdout.write('\\r\\n'+answer+'\\r\\n› ');sys.stdout.flush()
`;

export function createFleetCliRuntimeBundle(candidateSource: string): ComputerRuntimeBundle {
  if (!isAbsolute(candidateSource)) throw new Error('the candidate source archive must have an absolute path');
  const source = resolve(candidateSource);
  return {
    providerCli: provider,
    sharedTui: true,
    async stage(directory) {
      const stage = dirname(directory);
      const tree = join(stage, '../tree');
      for (const part of ['ops/cli', 'ops/scripts', 'ops/container-runtime', 'ops/schemas']) {
        for (const destination of [join(stage, part), join(tree, part)]) {
          await rm(destination, { recursive: true, force: true });
          await cp(join(source, part), destination, { recursive: true });
        }
      }
      for (const part of ['services/gateway/src', 'packages/store/src', 'packages/protocol/src', 'packages/adapter-sdk/descriptors']) {
        await rm(join(tree, part), { recursive: true, force: true });
        await cp(join(source, part), join(tree, part), { recursive: true });
      }
      await cp(join(source, 'packages/adapter-sdk/descriptors'), join(directory, 'descriptors'), { recursive: true });
      await rm(join(directory, 'packages/adapter-sdk/dist/descriptors'), { recursive: true, force: true });
      await cp(join(source, 'packages/adapter-sdk/descriptors'), join(directory, 'packages/adapter-sdk/dist/descriptors'), { recursive: true });
      const pty = join(source, 'ops/pty-agent');
      await cp(pty, join(stage, 'ops/pty-agent'), { recursive: true,
        filter: path => { const name = relative(pty, path); return name !== 'tests' && !name.startsWith('tests/'); } });
      await rm(join(directory, 'bootstrap-runtime.mjs'), { force: true });
      const bin = join(directory, 'src/bin');
      await mkdir(bin, { recursive: true });
      for (const name of ['codex', 'shared-session']) {
        await execute(join(workspace, 'node_modules/.bin/esbuild'), [join(source, 'packages/adapter-sdk/src/bin', `${name}.ts`),
          '--bundle', '--platform=node', '--format=esm', '--target=node22', '--log-level=error', `--outfile=${join(bin, `${name}.js`)}`,
          `--alias:@cauce/protocol=${join(source, 'packages/protocol/src/index.ts')}`,
          '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);'],
        { maxBuffer: 1024 * 1024, env: { ...process.env, NODE_PATH: ['packages/adapter-sdk', 'packages/protocol', '']
          .map(part => join(workspace, part, 'node_modules')).join(':') } });
      }
      return ['@release@/adapter/src/bin/codex.js'];
    },
  };
}

export const fleetCliRuntimeDiagnostics = `import json,os,pathlib,re,stat,sys
key,alias,tenant,state=sys.argv[1:5]
canonical='/run/cauce-fleet/'+key
metadata=pathlib.Path(canonical)/'cauce-v3-adapter.json'
result={'metadata_present':False,'metadata_identity_matches':False,'matched_adapters':[],
 'log_codes':[],'shared_session_degraded_reasons':[],'log_state':'absent'}
def private_root_file(path,limit):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&63:
   raise ValueError('unsafe diagnostic file')
  if info.st_size>limit: os.lseek(fd,info.st_size-limit,os.SEEK_SET)
  return os.read(fd,limit)
 finally: os.close(fd)
try:
 result['metadata_present']=metadata.lstat() is not None
 document=json.loads(private_root_file(metadata,65536))
 result['metadata_identity_matches']=all(document.get(name)==value for name,value in
  {'alias':key,'wireAlias':alias,'tenantId':tenant,'stateDirectory':state,'controlDirectory':canonical}.items())
 result['metadata_phase']=document.get('phase') if document.get('phase') in {'starting','running'} else 'unrecognized'
except FileNotFoundError: pass
except (OSError,ValueError,TypeError,AttributeError): result['metadata_unreadable']=True
names={b'CAUCE_RUNTIME_KEY',b'CAUCE_ALIAS',b'CAUCE_TENANT_ID',b'CAUCE_STATE_DIR',b'CAUCE_CONTROL_DIR',b'CAUCE_MODEL_ID',b'CAUCE_REASONING_EFFORT'}
for entry in pathlib.Path('/proc').iterdir():
 if not entry.name.isdigit(): continue
 try:
  argv=(entry/'cmdline').read_bytes().split(bytes([0]))
  if not any(value.endswith(b'/adapter/src/bin/codex.js') for value in argv): continue
  env={name:value.decode('utf-8') for name,value in (part.split(b'=',1) for part in
   (entry/'environ').read_bytes().split(bytes([0])) if b'=' in part) if name in names}
  if any(env.get(name)!=value for name,value in {b'CAUCE_RUNTIME_KEY':key,b'CAUCE_ALIAS':alias,
   b'CAUCE_TENANT_ID':tenant,b'CAUCE_STATE_DIR':state}.items()): continue
  model=env.get(b'CAUCE_MODEL_ID');effort=env.get(b'CAUCE_REASONING_EFFORT')
  result['matched_adapters'].append({'pid':int(entry.name),
   'control_directory':canonical if env.get(b'CAUCE_CONTROL_DIR')==canonical else 'outside_expected_control_scope',
   'model':model if model in {'gpt-5.4','gpt-5.5'} else 'unrecognized',
   'effort':effort if effort in {'minimal','low','medium','high','xhigh','max'} else 'unrecognized'})
 except (OSError,UnicodeError,ValueError): pass
try:
 raw=private_root_file(pathlib.Path(state)/'.cauce-adapter.log',262144).decode('utf-8',errors='replace')
 result['log_state']='observed'
 result['log_codes']=sorted(set(re.findall(r'(?m)^(SHARED_TUI_UNAVAILABLE|ADAPTER_FATAL|LEASE_CONFLICT): adapter stopped(?:$|:)',raw)))
 allowed={'session_absent','tui_absent','session_alias_mismatch','session_harness_mismatch',
  'session_identity_unverified','workspace_mismatch','startup_cancelled','startup_deadline_exceeded'}
 reasons=set()
 for line in raw.splitlines():
  try: packet=json.loads(line)
  except ValueError: continue
  if isinstance(packet,dict) and packet.get('event')=='shared_session_degraded' and packet.get('alias') in {key,alias}:
   reason=packet.get('reason')
   if isinstance(reason,str) and reason in allowed: reasons.add(reason)
 result['shared_session_degraded_reasons']=sorted(reasons)
except FileNotFoundError: pass
except (OSError,ValueError): result['log_state']='unreadable'
print(json.dumps(result))
`;

export const fleetCliPrepareDelivery = `import json,pathlib,re,ssl,sys,urllib.error,urllib.request,uuid
class MissingEnvironment(Exception): pass
def publish():
 pid,action,marker=sys.argv[1:4]
 if action not in {'REMEMBER','RECALL'} or not re.fullmatch(r'[A-Za-z0-9-]{1,128}',marker):
  raise ValueError('invalid fixture publication command')
 names={'CAUCE_ALIAS','CAUCE_TENANT_ID','CAUCE_ROOM','CAUCE_CERT_PATH','CAUCE_KEY_PATH','CAUCE_CA_PATH','CAUCE_GATEWAY_URL'}
 raw=pathlib.Path('/proc/'+pid+'/environ').read_bytes().split(bytes([0]))
 env={key.decode():value.decode() for key,value in (part.split(b'=',1) for part in raw if b'=' in part) if key.decode() in names}
 if not names.issubset(env): raise MissingEnvironment()
 tenant=env['CAUCE_TENANT_ID'];alias=env['CAUCE_ALIAS']
 context=ssl.create_default_context(cafile=env['CAUCE_CA_PATH'])
 context.load_cert_chain(env['CAUCE_CERT_PATH'],env['CAUCE_KEY_PATH'])
 body={'room_id':env['CAUCE_ROOM'],
  'recipients':[{'tenant_id':tenant,'alias':alias}],
  'body':{'type':'text','text':'REMEMBER '+marker if action=='REMEMBER' else 'RECALL'},
  'idempotency_key':'zz-l2-terminal-prepare-'+str(uuid.uuid4())}
 request=urllib.request.Request(env['CAUCE_GATEWAY_URL']+'/v3/messages',data=json.dumps(body).encode(),
  headers={'content-type':'application/json'},method='POST')
 with urllib.request.urlopen(request,context=context,timeout=15) as response:
  result=json.load(response)
  def canonical_id(value):
   return isinstance(value,str) and str(uuid.UUID(value,version=4))==value
  message=result['message_id'];deliveries=result['delivery_ids']
  if not canonical_id(message) or not isinstance(deliveries,list) or len(deliveries)!=1 or not all(map(canonical_id,deliveries)):
   raise ValueError('invalid fixture publication receipt')
  print(json.dumps({'message_id':message,'delivery_ids':deliveries}))
try: publish()
except urllib.error.HTTPError as error: raise SystemExit('canonical bus publication returned HTTP '+str(error.code)) from None
except urllib.error.URLError as error:
 raise SystemExit('canonical bus publication failed: '+('tls' if isinstance(error.reason,ssl.SSLError) else 'urlopen')) from None
except ssl.SSLError: raise SystemExit('canonical bus publication failed: tls') from None
except MissingEnvironment: raise SystemExit('canonical bus publication failed: missing_env') from None
except KeyError: raise SystemExit('canonical bus publication failed: invalid_response') from None
except OSError: raise SystemExit('canonical bus publication failed: local_io') from None
except (ValueError,TypeError): raise SystemExit('canonical bus publication failed: invalid_response') from None
`;
