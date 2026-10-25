import type { X2Docker } from './v4-agentes-x2-services.js';
import { X2_BROWSER_IMAGE, X2_PROXY_IMAGE } from './v4-agentes-x2-services.js';

const CDP = String.raw`const expected=process.argv[1];const published=process.argv[2]==='product';
const endpoint=published?process.env.CAUCE_BROWSER_CDP_URL:expected;
if(typeof endpoint!=='string'||endpoint!==expected)throw Error('the published browser endpoint differs');
const response=await fetch(endpoint+'/json/version',{signal:AbortSignal.timeout(3000)});
if(!response.ok)throw Error('CDP HTTP '+response.status);
const version=await response.json();
if(typeof version.webSocketDebuggerUrl!=='string')throw Error('CDP has no public websocket endpoint');
const result=await new Promise((resolve,reject)=>{
 const socket=new WebSocket(version.webSocketDebuggerUrl);
 const timer=setTimeout(()=>{socket.close();reject(Error('CDP websocket deadline'));},5000);
 socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP websocket error'));});
 socket.addEventListener('open',()=>{socket.send(JSON.stringify({id:731,method:'Browser.getVersion'}));});
 socket.addEventListener('message',event=>{const packet=JSON.parse(String(event.data));if(packet.id===731){clearTimeout(timer);socket.close();packet.error?reject(Error(JSON.stringify(packet.error))):resolve(packet.result);}});
});
if(typeof result.product!=='string'||!/(Chrome|Chromium)/.test(result.product))throw Error('CDP browser identity is unavailable');
console.log(JSON.stringify({endpoint,published,httpStatus:response.status,browser:version.Browser,webSocketDebuggerUrl:version.webSocketDebuggerUrl,result}));
`;

export async function cdpFromX2Agent(client: X2Docker, container: string, endpoint: string, published = false): Promise<Record<string, unknown>> {
  let diagnostic = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await client.command(['exec', '--user', 'cauce', container, 'node', '--input-type=module', '-e', CDP, endpoint, published ? 'product' : 'argument']);
    if (result.code === 0) return JSON.parse(result.stdout) as Record<string, unknown>;
    diagnostic = result.stderr;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`the agent did not complete an actual HTTP and WebSocket CDP exchange: ${diagnostic.slice(-1000)}`);
}

interface PublicContainer {
  Id: string; Image: string; State: { Running: boolean }; Config: { Image: string; Labels: Record<string, string> };
  HostConfig: { Privileged: boolean; ReadonlyRootfs: boolean; PortBindings?: Record<string, unknown> };
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> }; Mounts: { Destination: string; RW: boolean }[];
}
async function publicContainer(client: X2Docker, name: string): Promise<PublicContainer> {
  const format = '{"Id":{{json .Id}},"Image":{{json .Image}},"State":{"Running":{{json .State.Running}}},"Config":{"Image":{{json .Config.Image}},"Labels":{{json .Config.Labels}}},"HostConfig":{"Privileged":{{json .HostConfig.Privileged}},"ReadonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"PortBindings":{{json .HostConfig.PortBindings}}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}}},"Mounts":{{json .Mounts}}}';
  return JSON.parse(await client.docker(['inspect', '--format', format, name])) as PublicContainer;
}
export async function observeX2Browser(client: X2Docker, container: string): Promise<Record<string, unknown>> {
  const name = `${container}-browser`, network = `${container}-sidecars`;
  const observed = await publicContainer(client, name);
  const networks = JSON.parse(await client.docker(['network', 'inspect', '--format', '{{json .}}', network])) as { Internal: boolean; Containers: Record<string, unknown> };
  const current = await publicContainer(client, container);
  const image = await client.docker(['image', 'inspect', '--format', '{{.Id}}', X2_BROWSER_IMAGE]);
  const address = observed.NetworkSettings.Networks[network]?.IPAddress;
  if (!observed.State.Running || observed.Image !== image || observed.Config.Image !== X2_BROWSER_IMAGE
    || observed.Config.Labels['cauce.fleet.sidecar'] !== 'browser' || observed.HostConfig.Privileged
    || Object.keys(observed.HostConfig.PortBindings ?? {}).length || Object.keys(observed.NetworkSettings.Networks).join() !== network
    || !networks.Internal || !current.NetworkSettings.Networks[network] || !address) throw new Error('the real browser sidecar does not have its required isolation');
  return { container: name, id: observed.Id, image, labels: observed.Config.Labels, internal: networks.Internal,
    endpoint: await cdpFromX2Agent(client, container, `http://${address}:9222`, true) };
}

export async function observeX2Docker(client: X2Docker, container: string, access: 'read' | 'control', volume: string): Promise<Record<string, unknown>> {
  const name = `${container}-docker-proxy`;
  const observed = await publicContainer(client, name);
  const image = await client.docker(['image', 'inspect', '--format', '{{.Id}}', X2_PROXY_IMAGE]);
  if (!observed.State.Running || observed.Image !== image || observed.Config.Image !== X2_PROXY_IMAGE
    || observed.Config.Labels['cauce.fleet.sidecar'] !== 'docker' || !observed.HostConfig.ReadonlyRootfs || observed.HostConfig.Privileged
    || Object.keys(observed.HostConfig.PortBindings ?? {}).length
    || !observed.Mounts.some(row => row.Destination === '/var/run/docker.sock' && !row.RW)) throw new Error('the actual Docker proxy is not pinned and isolated');
  const runtime = await publicContainer(client, container);
  const script = String.raw`const [expected,access,name,runtime,expectedId]=process.argv.slice(1);
const published=process.env.DOCKER_HOST;
if(published!==expected)throw Error('the published Docker endpoint differs');
const endpoint=published.replace('tcp://','http://');
let ping;
for(let attempt=0;attempt<40;attempt++){try{ping=await fetch(endpoint+'/_ping');if(ping.ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
if(!ping?.ok||await ping.text()!=='OK')throw Error('Docker proxy ping was not answered');
const versionResponse=await fetch(endpoint+'/version');const version=await versionResponse.json();
if(!versionResponse.ok||typeof version.Version!=='string')throw Error('Docker version read failed');
const query=new URLSearchParams({all:'1',filters:JSON.stringify({name:['^/'+runtime+'$']})});
const listResponse=await fetch(endpoint+'/containers/json?'+query);const list=await listResponse.json();
if(!listResponse.ok||!Array.isArray(list)||list.length!==1||list[0].Id!==expectedId||!list[0].Names.includes('/'+runtime))throw Error('Docker exact runtime read differs');
const read={version:version.Version,container:{Id:list[0].Id,Names:list[0].Names,State:list[0].State,Image:list[0].Image}};
const created=await fetch(endpoint+'/volumes/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({Name:name,Labels:{'cauce.e2e.resource':name}})});
if(access==='read'){if(created.status!==403)throw Error('read proxy accepted POST '+created.status);console.log(JSON.stringify({ping:200,post:created.status,name,read,published}));}
else{if(created.status!==201)throw Error('control proxy did not create its volume '+created.status);const body=await created.json();if(body.Name!==name)throw Error('Docker created another volume');const removed=await fetch(endpoint+'/volumes/'+encodeURIComponent(name),{method:'DELETE'});if(removed.status!==204)throw Error('control proxy did not delete its volume '+removed.status);console.log(JSON.stringify({ping:200,post:created.status,deleted:removed.status,name,read,published}));}
`;
  const result = JSON.parse(await client.docker(['exec', '--user', 'cauce', container, 'node', '--input-type=module', '-e', script,
    `tcp://${name}:2375`, access, volume, container, runtime.Id])) as Record<string, unknown>;
  const absent = await client.command(['volume', 'inspect', volume]);
  if (absent.code !== 1 || !absent.stderr.includes(volume) || !/no such volume/iu.test(absent.stderr)) throw new Error('the proxy probe left a volume behind');
  return { access, container: name, id: observed.Id, image, labels: observed.Config.Labels, ...result, absent: true };
}

export async function observeX2Tunnel(client: X2Docker, container: string, state: string): Promise<Record<string, unknown>> {
  const launch = String.raw`import hashlib,json,os,pathlib,subprocess,sys,time
paths=list(pathlib.Path('/home/cauce/.cauce-profiles').rglob('browser/tunnel.json'))
if len(paths)!=1:raise RuntimeError('the product tunnel descriptor is ambiguous')
raw=paths[0].read_bytes();descriptor=json.loads(raw);command=descriptor['command']
if not isinstance(command,list) or not all(isinstance(item,str) for item in command) or 'StrictHostKeyChecking=yes' not in command:raise RuntimeError('the product tunnel command is not strict')
log=open(pathlib.Path(sys.argv[1])/'.x2-tunnel.log','wb')
process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
time.sleep(.2)
if process.poll() is not None:raise RuntimeError('the exact product tunnel command exited')
proc=pathlib.Path('/proc')/str(process.pid);start=(proc/'stat').read_text().split()[21]
argv=(proc/'cmdline').read_bytes()
print(json.dumps({'pid':process.pid,'start':start,'uid':proc.stat().st_uid,'argvSha256':hashlib.sha256(argv).hexdigest(),'descriptorSha256':hashlib.sha256(raw).hexdigest(),'endpoint':descriptor['cdp_url'],'strictHostKeyChecking':True,'launchedExactDescriptor':True}))
`;
  const result = JSON.parse(await client.docker(['exec', '--user', 'cauce', container, 'python3', '-I', '-B', '-c', launch, state])) as Record<string, unknown>;
  let cdp: Record<string, unknown>;
  const stopConsumer = async () => {
    const stop = String.raw`import hashlib,json,os,pathlib,signal,sys,time
expected=json.load(sys.stdin);proc=pathlib.Path('/proc')/str(expected['pid'])
if not proc.exists():raise RuntimeError('owned tunnel disappeared before the fenced stop')
if proc.stat().st_uid!=expected['uid'] or (proc/'stat').read_text().split()[21]!=expected['start'] or hashlib.sha256((proc/'cmdline').read_bytes()).hexdigest()!=expected['argvSha256']:raise RuntimeError('owned tunnel process identity changed')
os.kill(expected['pid'],signal.SIGTERM)
for attempt in range(50):
 if not proc.exists() or (proc/'stat').read_text().split()[2]=='Z':break
 time.sleep(.1)
else:raise RuntimeError('owned tunnel process survived termination')
print('TUNNEL-STOPPED')
`;
    const stopped = await client.command(['exec', '-i', '--user', 'cauce', container, 'python3', '-I', '-B', '-c', stop], JSON.stringify(result));
    if (stopped.code !== 0 || stopped.stdout.trim() !== 'TUNNEL-STOPPED') throw new Error(`the exact product tunnel consumer was not stopped: ${stopped.stderr}`);
    result.stopped = true;
  };
  try { cdp = await cdpFromX2Agent(client, container, String(result.endpoint)); }
  finally { await stopConsumer(); }
  return { ...result, cdp };
}

export async function assertX2SidecarsRemoved(client: X2Docker, container: string): Promise<Record<string, unknown>> {
  const absent = [];
  for (const name of [`${container}-browser`, `${container}-docker-proxy`]) {
    const present = await client.command(['inspect', name]);
    if (present.code === 0 || !/No such (?:object|container)/u.test(present.stderr)) throw new Error('a withdrawn sidecar survived');
    absent.push({ name, code: present.code, stderr: present.stderr });
  }
  const network = await client.command(['network', 'inspect', `${container}-sidecars`]);
  if (network.code === 0 || !(network.stderr.includes('No such network')
    || network.stderr.includes(`network ${container}-sidecars not found`))) throw new Error('the withdrawn sidecar network survived');
  return { containers: absent, network: { name: `${container}-sidecars`, code: network.code, stderr: network.stderr } };
}
