import { execFile } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FIXTURE_PROVIDER_IDENTITY, type ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { IDLE_PLACEHOLDER } from './s2d-provider.js';

const execute = promisify(execFile);
const ROOT = process.cwd();

const PROVIDER = `#!/usr/local/bin/python3
import json,os,pathlib,re,signal,sys,termios,time,tty,uuid
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
 files=sorted(sessions.glob('rollout-*.jsonl'),key=lambda p:p.stat().st_mtime)
 if not files: sys.exit(3)
 native=re.search(r'([a-f0-9-]{36})[.]jsonl$',files[-1].name).group(1)
file=sessions/('rollout-canary-'+native+'.jsonl');memory=home/('memory-'+native+'.json')
def append(value):
 with file.open('a') as stream: stream.write(json.dumps(value)+chr(10));stream.flush();os.fsync(stream.fileno())
if not file.exists(): append({'type':'session_meta','payload':{'id':native,'source':'cli','cwd':os.getcwd()}})
with (home/'recovery-invocations.jsonl').open('a') as stream:
 stream.write(json.dumps({'pid':os.getpid(),'native_id':native,'argv':sys.argv[1:]})+chr(10))
signal.signal(signal.SIGINT,lambda *_:sys.exit(130))
print('STANDARD_READY:'+native,flush=True)
original=termios.tcgetattr(sys.stdin.fileno());tty.setraw(sys.stdin.fileno())
sys.stdout.write(chr(27)+'[?2004h');sys.stdout.flush()
# An idle Codex composer shows a dim placeholder with the cursor right after the prompt.
def render_idle():
 sys.stdout.write('\\r\\n› '+chr(27)+'[2m'+${JSON.stringify(IDLE_PLACEHOLDER)}+chr(27)+'[22m\\r'+chr(27)+'[2C');sys.stdout.flush()
render_idle()
pending='';pasting=False
while True:
 chunk=os.read(sys.stdin.fileno(),4096).decode(errors='replace')
 if not chunk: break
 if not pending: sys.stdout.write('\\r'+chr(27)+'[2K› ');sys.stdout.flush()
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
 elif 'HOLD-CANARY' in text:
  (home/'hold-entered').touch()
  while not (home/'hold-release').exists(): time.sleep(0.05)
  (home/'hold-release').unlink();answer='HELD-CANARY'
 elif 'RECALL' in text: answer='RECALLED:'+json.loads(memory.read_text())['marker']
 else: answer='REPLY:'+text
 correlation=re.search(r'"cauce_correlation_id":"([a-f0-9]{64})"',text)
 if correlation: answer=json.dumps({'reply':answer,'messages':[],'status':'done','retryable':False,'artifacts':[],'cauce_correlation_id':correlation.group(1)})
 append({'type':'event_msg','payload':{'type':'task_complete','turn_id':turn,'last_agent_message':answer}})
 sys.stdout.write('\\r\\n'+answer+'\\r\\n');sys.stdout.flush();render_idle()
`;

/** The real SDK entry of `harness` and its shared-session helper, bundled into the release adapter directory. */
export async function stageSharedAdapter(directory: string, harness: 'codex' | 'claude'): Promise<readonly string[]> {
  await cp(join(ROOT, 'packages/adapter-sdk/descriptors'), join(directory, 'descriptors'), { recursive: true });
  const bin = join(directory, 'src/bin');
  await mkdir(bin, { recursive: true });
  for (const name of [harness, 'shared-session']) {
    await execute(join(ROOT, 'node_modules/.bin/esbuild'), [join(ROOT, 'packages/adapter-sdk/src/bin', `${name}.ts`),
      '--bundle', '--platform=node', '--format=esm', '--target=node22', '--log-level=error', `--outfile=${join(bin, `${name}.js`)}`,
      `--alias:@cauce/protocol=${join(ROOT, 'packages/protocol/src/index.ts')}`,
      '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);'],
    { maxBuffer: 1024 * 1024 });
  }
  return [`@release@/adapter/src/bin/${harness}.js`];
}

export const standardRecoveryBundle: ComputerRuntimeBundle = {
  providerCli: PROVIDER,
  sharedTui: true,
  stage: directory => stageSharedAdapter(directory, 'codex'),
};
