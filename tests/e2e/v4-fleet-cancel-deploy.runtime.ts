import { execFile } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FIXTURE_PROVIDER_IDENTITY, type ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';

const execute = promisify(execFile);
const root = process.cwd();

const provider = `#!/usr/local/bin/python3
import json,re,sys,uuid
if 'app-server' in sys.argv:
 for line in sys.stdin:
  packet=json.loads(line)
  if 'id' in packet:
   result={'account':{'type':'chatgpt','email':'${FIXTURE_PROVIDER_IDENTITY}'}} if packet['method']=='account/read' else {}
   print(json.dumps({'id':packet['id'],'result':result}),flush=True)
 sys.exit(0)
prompt=' '.join(sys.argv[1:]) if sys.argv[-1]!='-' else sys.stdin.read()
nonce=re.search(r'CAUCE_BOOTSTRAP_[a-f0-9]{64}',prompt)
if nonce:
 answer=nonce.group(0)
else:
 correlation=re.search(r'"cauce_correlation_id":"([a-f0-9]{64})"',prompt)
 marker=re.search(r'FLEET-DEPLOY-DELIVERY-[a-f0-9-]+',prompt)
 if marker is None: sys.exit('the durable delivery marker is absent')
 output={'reply':'DELIVERED:'+marker.group(0),'messages':[],'status':'done','retryable':False,'artifacts':[]}
 if correlation: output['cauce_correlation_id']=correlation.group(1)
 answer=json.dumps(output)
native=sys.argv[sys.argv.index('resume')+2] if 'resume' in sys.argv and '--json' in sys.argv else str(uuid.uuid4())
print(json.dumps({'type':'thread.started','thread_id':native}),flush=True)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':answer}}),flush=True)
`;

export const cancelDeployRuntime: ComputerRuntimeBundle = {
  providerCli: provider,
  sharedTui: false,
  async stage(directory) {
    await cp(join(root, 'packages/adapter-sdk/descriptors'), join(directory, 'descriptors'), { recursive: true });
    const bin = join(directory, 'src/bin');
    await mkdir(bin, { recursive: true });
    await execute(join(root, 'node_modules/.bin/esbuild'), [join(root, 'packages/adapter-sdk/src/bin/codex.ts'),
      '--bundle', '--platform=node', '--format=esm', '--target=node22', '--log-level=error', `--outfile=${join(bin, 'codex.js')}`,
      `--alias:@cauce/protocol=${join(root, 'packages/protocol/src')}`,
      '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);'],
    { maxBuffer: 1024 * 1024 });
    return ['@release@/adapter/src/bin/codex.js'];
  },
};
