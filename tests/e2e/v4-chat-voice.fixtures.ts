import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { browserDocker } from './browser-owned-lifecycle.js';
import type { ConnectedBrowser, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';

type Fixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
interface VoiceProcess { profile: string; pid: number; startTicks: string; supervisorPid: number; supervisorStartTicks: string; port: number }
const require = createRequire(join(process.cwd(), 'console/package.json'));
const chromium = (require('playwright') as {
  chromium: { connectOverCDP(endpoint: string, options: { timeout: number }): Promise<ConnectedBrowser> };
}).chromium;

const launchScript = String.raw`
const fs=require('node:fs'),net=require('node:net'),{spawn}=require('node:child_process');
const [profile,browserPath]=process.argv.slice(1);
const ticks=pid=>fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[19];
fs.mkdirSync(profile,{mode:448});
const log=fs.openSync(profile+'/chrome.log','wx',384);
const child=spawn(browserPath,['--no-sandbox','--headless=new','--disable-dev-shm-usage','--no-first-run',
 '--no-default-browser-check','--proxy-server=socks5://127.0.0.1:1080','--proxy-bypass-list=<-loopback>',
 '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,
 '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','about:blank'],{stdio:['ignore',log,log]});
const sockets=new Set();let server;
child.once('exit',(code,signal)=>{
 for(const socket of sockets)socket.destroy();server?.close();
 fs.writeFileSync(profile+'/stopped.json',JSON.stringify({pid:child.pid,code,signal,stoppedVerified:!fs.existsSync('/proc/'+child.pid)}),{mode:384});
});
child.once('error',error=>{fs.writeFileSync(profile+'/startup-error',String(error),{mode:384});process.exitCode=1;});
(async()=>{
 const startTicks=ticks(child.pid),supervisorStartTicks=ticks(process.pid),deadline=Date.now()+20000;
 let active;
 while(Date.now()<deadline){
  try{active=fs.readFileSync(profile+'/DevToolsActivePort','utf8').split(/\s+/);if(active[1]?.startsWith('/devtools/browser/'))break;}catch{}
  if(child.exitCode!==null||child.signalCode!==null)throw new Error('Voice Chromium exited before CDP readiness');
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 const chromePort=Number(active?.[0]);if(!Number.isInteger(chromePort)||chromePort<1)throw new Error('Voice Chromium CDP timeout');
 server=net.createServer(socket=>{
  const upstream=net.connect(chromePort,'127.0.0.1');
  for(const channel of [socket,upstream]){sockets.add(channel);channel.on('error',()=>{socket.destroy();upstream.destroy();});
   channel.once('close',()=>{sockets.delete(channel);socket.destroy();upstream.destroy();});}
  socket.pipe(upstream);upstream.pipe(socket);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',resolve);});
 fs.writeFileSync(profile+'/ready.json',JSON.stringify({profile,pid:child.pid,startTicks,supervisorPid:process.pid,supervisorStartTicks,port:server.address().port}),{mode:384});
})().catch(error=>{fs.writeFileSync(profile+'/startup-error',String(error),{mode:384});child.kill('SIGTERM');process.exitCode=1;});
`;

const readReadyScript = String.raw`
const fs=require('node:fs');const [profile]=process.argv.slice(1);
(async()=>{const deadline=Date.now()+25000;while(Date.now()<deadline){
 if(fs.existsSync(profile+'/startup-error'))throw new Error(fs.readFileSync(profile+'/startup-error','utf8'));
 if(fs.existsSync(profile+'/ready.json')){process.stdout.write(fs.readFileSync(profile+'/ready.json','utf8'));return;}
 await new Promise(resolve=>setTimeout(resolve,100));
}throw new Error('Voice browser supervisor did not publish readiness');})().catch(error=>{console.error(error);process.exitCode=1;});
`;

const stopScript = String.raw`
const fs=require('node:fs');const [profile]=process.argv.slice(1);
const ticks=pid=>{try{return fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[19];}catch(error){if(error.code==='ENOENT')return;throw error;}};
(async()=>{
 if(!fs.existsSync(profile+'/ready.json'))throw new Error('Voice browser has no process receipt; container cleanup required');
 const meta=JSON.parse(fs.readFileSync(profile+'/ready.json','utf8'));
 if(meta.profile!==profile||!Number.isInteger(meta.pid)||!Number.isInteger(meta.supervisorPid))throw new Error('Voice process ownership differs');
 const current=ticks(meta.pid);
 if(current!==undefined){
  const command=fs.readFileSync('/proc/'+meta.pid+'/cmdline','utf8').split('\0');
  if(current!==meta.startTicks||!command.includes('--user-data-dir='+profile)||!command.includes('--use-fake-device-for-media-stream'))throw new Error('Voice process identity changed');
  process.kill(meta.pid,'SIGTERM');
  const deadline=Date.now()+5000;while(ticks(meta.pid)!==undefined&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  if(ticks(meta.pid)===meta.startTicks)process.kill(meta.pid,'SIGKILL');
 }
 const deadline=Date.now()+5000;
 while((ticks(meta.pid)===meta.startTicks||ticks(meta.supervisorPid)===meta.supervisorStartTicks)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
 if(ticks(meta.pid)===meta.startTicks||ticks(meta.supervisorPid)===meta.supervisorStartTicks)throw new Error('Voice process shutdown was not confirmed');
 process.stdout.write(JSON.stringify({profile,pid:meta.pid,supervisorPid:meta.supervisorPid,stoppedVerified:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
`;

async function publishVoiceCdp(host: string, port: number) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    const upstream = createConnection({ host, port });
    for (const channel of [socket, upstream]) {
      sockets.add(channel);
      channel.on('error', () => { socket.destroy(); upstream.destroy(); });
      channel.once('close', () => { sockets.delete(channel); socket.destroy(); upstream.destroy(); });
    }
    socket.pipe(upstream); upstream.pipe(socket);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Voice CDP did not bind its private loopback');
  return { endpoint: `http://127.0.0.1:${String(address.port)}`, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
  } };
}

export async function startVoiceBrowser(fixture: Fixture, receipts: string) {
  const profile = `/tmp/zz-canary-e2e-a6-chat-1025b-voice-${randomUUID()}`;
  let publication: Awaited<ReturnType<typeof publishVoiceCdp>> | undefined;
  let browser: ConnectedBrowser | undefined;
  let launchIssued = false;
  const close = async () => {
    const errors: unknown[] = [];
    try { await browser?.close(); } catch (error) { errors.push(error); }
    try { await publication?.close(); } catch (error) { errors.push(error); }
    if (launchIssued) {
      try {
        const result = await browserDocker(['exec', fixture.browserContainer, 'node', '-e', stopScript, profile], { timeout: 20_000 });
        await writeFile(join(receipts, 'voice-browser-cleanup.json'), result.stdout, { mode: 0o600 });
      } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Voice Chromium cleanup was incomplete');
  };
  try {
    const container = JSON.parse((await browserDocker(['inspect', '--format', '{{json .}}', fixture.browserContainer])).stdout) as {
      Name: string; Image: string; NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
    };
    const networks = Object.values(container.NetworkSettings.Networks);
    const host = networks[0]?.IPAddress;
    if (container.Name !== `/${fixture.browserContainer}` || container.Image !== fixture.browserRuntime.imageId
        || networks.length !== 1 || !host || !/^\d+\.\d+\.\d+\.\d+$/u.test(host)) throw new Error('Voice browser container identity differs from fixture');
    const command = 'for base in /opt/playwright-browsers /root/.cache/ms-playwright; do if [ -d "$base" ]; then find "$base" -type f -path "*/chrome-linux*/chrome" -print -quit; fi; done | sed -n "1p"';
    const browserPath = (await browserDocker(['exec', fixture.browserContainer, 'sh', '-lc', command])).stdout.trim();
    if (!browserPath.startsWith('/') || !browserPath.endsWith('/chrome')) throw new Error('Voice browser executable was not found');
    launchIssued = true;
    await browserDocker(['exec', '--detach', fixture.browserContainer, 'node', '-e', launchScript, profile, browserPath]);
    const processInfo = JSON.parse((await browserDocker(['exec', fixture.browserContainer, 'node', '-e', readReadyScript, profile], { timeout: 30_000 })).stdout) as VoiceProcess;
    if (processInfo.profile !== profile || !Number.isInteger(processInfo.port) || processInfo.port < 1 || processInfo.port > 65535) throw new Error('Voice browser readiness identity differs');
    await writeFile(join(receipts, 'voice-browser.json'), JSON.stringify({ ...processInfo, container: fixture.browserContainer,
      imageId: fixture.browserRuntime.imageId, nativeSyntheticDevice: true, ignoreHTTPSErrors: false }, null, 2), { mode: 0o600 });
    publication = await publishVoiceCdp(host, processInfo.port);
    browser = await chromium.connectOverCDP(publication.endpoint, { timeout: 15_000 });
    return { browser, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Voice browser startup failed with incomplete cleanup'); }
    throw error;
  }
}
