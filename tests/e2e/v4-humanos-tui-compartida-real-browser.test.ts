import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isaSecondHuman, isaTenant, newTrustedPage } from './console-functional-browser.fixtures.js';
import { prepareChatRuntimeIdentity } from './chat-runtime-identity.fixtures.js';
import { login, publish, startContextFixture, waitForDone, waitForLease } from './context-multiuser-continuity.fixtures.js';
import { asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const artifacts = join(process.cwd(), '.delegados/v4/recibos/c2e-humanos-tui-compartida-1025');
let fixture: Awaited<ReturnType<typeof startContextFixture>> | undefined;
let adapter: ChildProcess | undefined;
let diagnostics = '';

function active() { if (!fixture) throw new Error('contexto adoptado muse fixture missing'); return fixture; }

async function startMuseAdapter(home: string): Promise<void> {
  const fx = active();
  const tls = fx.pki.adapterCerts[0];
  if (!tls) throw new Error('owned adapter TLS missing');
  const space = join(fx.directory, 'muse-space');
  const workspace = join(space, 'projects');
  const state = join(fx.directory, 'muse-state');
  const data = join(home, 'xdg', 'data');
  const kernel = join(fx.directory, 'muse-tui.mjs');
  await Promise.all([home, workspace, state, data, join(home, 'xdg', 'config')]
    .map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(kernel, `#!${process.execPath}
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';\nimport { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const debug=(line)=>{try{appendFileSync(${JSON.stringify(join(fx.directory, 'tui-debug.log'))},line+'\\n');}catch{}};
debug('start argv='+process.argv.slice(2).join(' ')+' cwd='+process.cwd());
const SID=randomUUID();
const now=new Date();
const parts=[String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')];
const dataHome=join(process.env.HOME,'xdg','data');
const dir=join(dataHome,'muse','sessions',...parts,SID);
await mkdir(dir,{recursive:true,mode:0o700});
const file=join(dir,'session.jsonl');
const rec=(payloadType,payload)=>JSON.stringify({stream:{kind:'session',id:SID},payload_type:payloadType,payload})+'\\n';
await writeFile(file,rec('runtime.session',{kind:'session',event:{kind:'started'}}),{mode:0o600});
let buffer='',processing=false,skipLf=false,lastOutput='Muse listo';
const composerRule='─'.repeat(60);
const composer=()=>process.stdout.write('\\x1b[2J\\x1b[H'+lastOutput+'\\r\\n'+composerRule+'\\r\\n> '
  +buffer.replaceAll('\\x1b[200~','').replaceAll('\\x1b[201~','').replace(/\\r\\n?/gu,'\\n')
    .replace(/[\\x00-\\x09\\x0b-\\x1f\\x7f]/gu,'�').replaceAll('\\n','\\r\\n')
  +'\\x1b7\\r\\n'+composerRule+'\\x1b8');
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h');composer();
setInterval(()=>{},60000);
async function turn(prompt){
  debug('turn '+prompt.length);
  const answer=JSON.stringify({reply:'MUSE TUI COMPARTIDA ${run}',messages:[],notify:[],status:'done',retryable:false,artifacts:[]});
  const iid=randomUUID();
  const intent=rec('runtime.user_intent.accepted',{intent_id:iid,model_messages:[{content:[{kind:'text',text:prompt}]}]});
  const msg=rec('runtime.session',{kind:'run',run_id:iid,event:{kind:'assistant_message_committed',text:answer}});
  const term=rec('runtime.session',{kind:'run',run_id:iid,event:{kind:'terminal',terminal:'completed'}});
  await appendFile(file,intent+msg+term,{mode:0o600});
  lastOutput=answer;composer();
}
function submission(){
  if(skipLf&&buffer){if(buffer.startsWith('\\n'))buffer=buffer.slice(1);skipLf=false;}
  const start=buffer.indexOf('\\x1b[200~'),newline=buffer.search(/[\\r\\n]/u);
  let end,consumed,prompt;
  if(start>=0&&(newline<0||start<newline)){
    end=buffer.indexOf('\\x1b[201~',start+6);
    if(end<0||!/[\\r\\n]/u.test(buffer[end+6]??''))return;
    prompt=buffer.slice(0,start)+buffer.slice(start+6,end);consumed=end+7;
  }else{
    if(newline<0)return;
    prompt=buffer.slice(0,newline);consumed=newline+1;
  }
  skipLf=buffer[consumed-1]==='\\r';
  if(skipLf&&buffer[consumed]==='\\n'){consumed+=1;skipLf=false;}
  buffer=buffer.slice(consumed);
  return prompt.replace(/\\r\\n?/gu,'\\n');
}
async function drain(){
  if(processing)return;
  processing=true;
  try{let prompt;while((prompt=submission())!==undefined){if(prompt.trim())await turn(prompt);}}
  finally{processing=false;composer();}
}
process.stdin.on('data',(chunk)=>{
  debug('stdin '+chunk.length);
  buffer+=chunk;composer();void drain();
});
`, { mode: 0o700 });
  const kernelSha = createHash('sha256').update(await readFile(kernel)).digest('hex');
  await new Promise<void>((resolve, reject) => {
    const check = spawn(process.execPath, ['--check', kernel], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    check.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    check.stderr.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    check.on('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`kernel syntax: ${out}`)); });
  });
  const ownerRows = await fx.database.pool.query('SELECT id FROM console_users WHERE tenant_id = $1 AND alias = $2 AND email = $3', [isaTenant.tenant, isaTenant.operator, isaTenant.email]);
  const ownerHumanId = (ownerRows.rows[0] as { id: string }).id;
  adapter = spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/muse.js'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', HOME: home,
      XDG_CONFIG_HOME: join(home, 'xdg', 'config'), XDG_DATA_HOME: data,
      CAUCE_SHARED_SESSION: '1', CAUCE_SHARED_SESSION_WORKSPACE: workspace, CAUCE_MUSE_WORKSPACE: workspace,
      CAUCE_SHARED_HUMAN_IDS: `${isaTenant.tenant}:${ownerHumanId}`,
      CAUCE_TENANT: isaTenant.tenant, CAUCE_ROOM: isaTenant.room, CAUCE_ALIAS: isaTenant.target,
      CAUCE_INSTANCE_ID: `humanos-muse-${run}`, CAUCE_STATE_DIR: state, CAUCE_SPACE_ROOT: space,
      CAUCE_RELAY_URL: `${fx.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test',
      CAUCE_HARNESS_COMMAND: kernel, CAUCE_HARNESS_COMMAND_SHA256: kernelSha,
      CAUCE_HARNESS_COMMAND_FILES: JSON.stringify({ [kernel]: kernelSha }),
      CAUCE_MUSE_CLI_COMMAND: kernel, CAUCE_MUSE_CLI_SHA256: kernelSha,
      CAUCE_HEARTBEAT_MS: '250', CAUCE_NO_PROGRESS_TIMEOUT_MS: '120000',
      CAUCE_TLS_CERT_FILE: tls.cert, CAUCE_TLS_KEY_FILE: tls.key, CAUCE_TLS_CA_FILE: fx.pki.ca.cert,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  adapter.stdout?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-16 * 1024); });
  adapter.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-16 * 1024); });
  fx.adapters.push(adapter);
}

describe('humanos de la empresa ante un agente Muse V4 con TUI compartida', () => {

  beforeAll(async () => {
    await mkdir(artifacts, { recursive: true });
    fixture = await startContextFixture();
    await fixture.database.pool.query(
      "UPDATE agents SET harness_id='muse' WHERE tenant_id=$1 AND alias=$2",
      [isaTenant.tenant, isaTenant.target],
    );
  }, 600_000);

  afterAll(async () => {
    const debug = fixture === undefined ? '' : await readFile(
      join(fixture.directory, 'tui-debug.log'), 'utf8').catch(() => '');
    const paneDump = await new Promise<string>((resolve) => {
      const tmux = spawn('tmux', ['-u', '-L', 'cauce', 'capture-pane', '-p', '-t', 'cauce-e2eagentisa', '-S', '-80'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      tmux.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      tmux.stderr.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      tmux.on('error', () => { resolve(''); });
      tmux.on('exit', () => { resolve(out); });
    }).catch(() => '');
    await writeFile(join(artifacts, `muse-adapter-${run}.log`), `${diagnostics}\n--- TUI DEBUG ---\n${debug}\n--- PANE ---\n${paneDump}`, { mode: 0o600 }).catch(() => undefined);
    await fixture?.close();
  }, 180_000);

  it('el humano listado llega a la TUI compartida y el no listado recibe el rechazo', async () => {
    const fx = active();
    const page: V4Page = asV4Page(await newTrustedPage(fx, { width: 1440, height: 900 }));
    await login(page, fx, isaTenant);
    await prepareChatRuntimeIdentity(fx, isaTenant);
    await startMuseAdapter(join(fx.directory, 'muse-home'));
    await waitForLease(fx, isaTenant);

    const first = await publish(page, fx, isaTenant, isaTenant.room, `turno del dueño ${run}`);
    const doneFirst = await waitForDone(fx, first.deliveryId);
    expect(doneFirst.result).toMatchObject({ output: { reply: `MUSE TUI COMPARTIDA ${run}`, status: 'done' } });
    await page.goto(`${fx.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
    await page.getByText(`MUSE TUI COMPARTIDA ${run}`, { exact: true }).waitFor({ timeout: 20_000 });

    const secondPage: V4Page = asV4Page(await newTrustedPage(fx, { width: 1440, height: 900 }));
    await login(secondPage, fx, isaSecondHuman);
    const rejected = await publish(secondPage, fx, isaSecondHuman, isaTenant.room, `turno no listado ${run}`);
    const deadline = Date.now() + 35_000;
    let failed: { status: string; result: unknown } | undefined;
    while (Date.now() < deadline) {
      const rows = await fx.database.pool.query<{ status: string; result: unknown }>(
        'SELECT status,result FROM deliveries WHERE id=$1', [rejected.deliveryId]);
      if (rows.rows[0]?.status === 'failed') { failed = rows.rows[0]; break; }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(failed?.status).toBe('failed');
    expect(JSON.stringify(failed?.result ?? '') + diagnostics).toContain('UNSUPPORTED_HUMAN_ISOLATION');
    const debug = await readFile(join(fx.directory, 'tui-debug.log'), 'utf8').catch(() => '');
    expect(debug.split('\n').filter((line) => line.startsWith('turn '))).toHaveLength(1);
    await page.screenshot({ path: join(artifacts, `muse-humanos-${run}-1440.png`) });
    await writeFile(join(artifacts, `muse-humanos-${run}.json`), JSON.stringify({ run, listed: 'done', unlisted: 'failed' }, null, 2), { mode: 0o600 });
  }, 300_000);
});
