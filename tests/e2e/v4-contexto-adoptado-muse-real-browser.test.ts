import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isaTenant, newTrustedPage } from './console-functional-browser.fixtures.js';
import { prepareChatRuntimeIdentity } from './chat-runtime-identity.fixtures.js';
import { login, publish, startContextFixture, waitForDone, waitForLease } from './context-multiuser-continuity.fixtures.js';
import { asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const markerV1 = `ZZ-CONTEXTO-MUSE-${run}-V1`;
const markerV2 = `ZZ-CONTEXTO-MUSE-${run}-V2`;
const markerV3 = `ZZ-CONTEXTO-MUSE-${run}-V3`;
const markerNuevo = `ZZ-CONTEXTO-MUSE-${run}-NUEVO`;
const falla = `FALLA-${run}`;
const artifacts = join(process.cwd(), '.delegados/v4/recibos/c2d-muse-tui-lab-1025');
let fixture: Awaited<ReturnType<typeof startContextFixture>> | undefined;
let adapter: ChildProcess | undefined;
let diagnostics = '';

function active() { if (!fixture) throw new Error('contexto adoptado muse fixture missing'); return fixture; }

async function appliedVersion(): Promise<number> {
  const row = await active().database.pool.query<{ applied_version: string }>(
    'SELECT applied_version::text AS applied_version FROM agent_context_state WHERE tenant_id=$1 AND alias=$2',
    [isaTenant.tenant, isaTenant.target],
  );
  return Number(row.rows[0]?.applied_version ?? -1);
}

async function appliedState(): Promise<{ version: number; at: string }> {
  const row = await active().database.pool.query<{ applied_version: string; applied_at: string }>(
    'SELECT applied_version::text AS applied_version, applied_at::text AS applied_at FROM agent_context_state WHERE tenant_id=$1 AND alias=$2',
    [isaTenant.tenant, isaTenant.target],
  );
  return { version: Number(row.rows[0]?.applied_version ?? -1), at: row.rows[0]?.applied_at ?? '' };
}

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
process.stdout.write('Muse listo\\n> ');
setInterval(()=>{},60000);
let buffer='';let timer;
async function turn(prompt){
  debug('turn '+prompt.length);
  const marker=prompt.includes(${JSON.stringify(markerNuevo)})?${JSON.stringify(markerNuevo)}:prompt.includes(${JSON.stringify(markerV3)})?${JSON.stringify(markerV3)}:prompt.includes(${JSON.stringify(markerV2)})?${JSON.stringify(markerV2)}:prompt.includes(${JSON.stringify(markerV1)})?${JSON.stringify(markerV1)}:'';
  const answer=JSON.stringify({reply:marker?'CONTEXTO MUSE EN USO '+marker:'SIN CONTEXTO MUSE',messages:[],notify:[],status:'done',retryable:false,artifacts:[]});
  const iid=randomUUID();
  const intent=rec('runtime.user_intent.accepted',{intent_id:iid,model_messages:[{content:[{kind:'text',text:prompt}]}]});
  if(prompt.includes(${JSON.stringify(falla)})){
    const failTerm=rec('runtime.session',{kind:'run',run_id:iid,event:{kind:'terminal',terminal:'failed'}});
    await appendFile(file,intent+failTerm,{mode:0o600});
    process.stdout.write('error\\n> ');
    return;
  }
  const msg=rec('runtime.session',{kind:'run',run_id:iid,event:{kind:'assistant_message_committed',text:answer}});
  const term=rec('runtime.session',{kind:'run',run_id:iid,event:{kind:'terminal',terminal:'completed'}});
  await appendFile(file,intent+msg+term,{mode:0o600});
  process.stdout.write(answer+'\\n> ');
}
process.stdin.on('data',(chunk)=>{
  debug('stdin '+chunk.length);
  buffer+=chunk.toString('utf8');
  clearTimeout(timer);
  timer=setTimeout(()=>{
    const prompt=buffer.replaceAll('\\x1b[200~','').replaceAll('\\x1b[201~','').replace(/\\r+$/u,'');
    buffer='';
    if(prompt.trim().length>0)void turn(prompt);
  },400);
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
      CAUCE_OWNER_HUMAN_ID: ownerHumanId,
      CAUCE_TENANT: isaTenant.tenant, CAUCE_ROOM: isaTenant.room, CAUCE_ALIAS: isaTenant.target,
      CAUCE_INSTANCE_ID: `adoptado-muse-${run}`, CAUCE_STATE_DIR: state, CAUCE_SPACE_ROOT: space,
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

describe('adopción de contexto versionado por un agente Muse V4 en sesión compartida', () => {
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

  it('publicar una versión y conversar acredita applied_version 1 y 2', async () => {
    const fx = active();
    const page: V4Page = asV4Page(await newTrustedPage(fx, { width: 1440, height: 900 }));
    await login(page, fx, isaTenant);
    await page.goto(`${fx.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}?view=context`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
    const versions = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
    await versions.waitFor({ timeout: 20_000 });
    await versions.getByLabel('Nuevo archivo', { exact: true }).fill('context/mission.md');
    await versions.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
    await versions.getByLabel('Contenido de context/mission.md', { exact: true }).fill(`Misión ${markerV1}`);
    await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
    await expect.poll(appliedVersion, { timeout: 20_000 }).toBe(0);

    await prepareChatRuntimeIdentity(fx, isaTenant);
    await startMuseAdapter(join(fx.directory, 'muse-home'));
    await waitForLease(fx, isaTenant);
    const first = await publish(page, fx, isaTenant, isaTenant.room, `turno muse ${run} uno`);
    const doneFirst = await waitForDone(fx, first.deliveryId);
    expect(doneFirst.result).toMatchObject({ output: { reply: `CONTEXTO MUSE EN USO ${markerV1}`, status: 'done' } });
    await expect.poll(appliedVersion, { timeout: 60_000 }).toBe(1);

    await page.goto(`${fx.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}?view=context`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
    const versions2 = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
    await versions2.waitFor({ timeout: 20_000 });
    await versions2.locator('textarea').first().fill(`Misión ${markerV2}`);
    await versions2.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
    const second = await publish(page, fx, isaTenant, isaTenant.room, `turno muse ${run} dos`);
    const doneSecond = await waitForDone(fx, second.deliveryId);
    expect(doneSecond.result).toMatchObject({ output: { reply: `CONTEXTO MUSE EN USO ${markerV2}`, status: 'done' } });
    await expect.poll(appliedVersion, { timeout: 60_000 }).toBe(2);
    await page.screenshot({ path: join(artifacts, `muse-adoptado-${run}-1440.png`) });
    await writeFile(join(artifacts, `muse-adoptado-${run}.json`), JSON.stringify({ run, applied_version: 2 }, null, 2), { mode: 0o600 });
  }, 300_000);

  it('la versión N+1 con un fichero nuevo acredita en el turno siguiente y un turno fallido no avanza', async () => {
    const fx = active();
    const before = await appliedState();
    expect(before.version).toBe(2);
    const page: V4Page = asV4Page(await newTrustedPage(fx, { width: 1440, height: 900 }));
    await login(page, fx, isaTenant);
    await page.goto(`${fx.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}?view=context`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
    const versions = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
    await versions.waitFor({ timeout: 20_000 });
    await versions.getByLabel('Contenido de context/mission.md', { exact: true }).fill(`Misión ${markerV3}`);
    await versions.getByLabel('Nuevo archivo', { exact: true }).fill('context/dato-nuevo.md');
    await versions.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
    await versions.getByLabel('Contenido de context/dato-nuevo.md', { exact: true }).fill(`Dato ${markerNuevo}`);
    await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();

    const third = await publish(page, fx, isaTenant, isaTenant.room, `turno muse ${run} tres`);
    const doneThird = await waitForDone(fx, third.deliveryId);
    expect(doneThird.result).toMatchObject({ output: { reply: `CONTEXTO MUSE EN USO ${markerNuevo}`, status: 'done' } });
    await expect.poll(appliedVersion, { timeout: 60_000 }).toBe(3);
    const after = await appliedState();
    expect(after.version).toBe(3);
    expect(after.at > before.at).toBe(true);

    const failedTurn = await publish(page, fx, isaTenant, isaTenant.room, `turno muse ${run} ${falla}`);
    const deadline = Date.now() + 35_000;
    let failedStatus = '';
    while (Date.now() < deadline) {
      const rows = await fx.database.pool.query<{ status: string }>(
        'SELECT status FROM deliveries WHERE id=$1', [failedTurn.deliveryId]);
      failedStatus = rows.rows[0]?.status ?? '';
      if (failedStatus === 'failed' || failedStatus === 'dead') break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(['failed', 'dead']).toContain(failedStatus);
    const unchanged = await appliedState();
    expect(unchanged.version).toBe(3);
    expect(unchanged.at).toBe(after.at);
    await writeFile(join(artifacts, `muse-adoptado-n1-${run}.json`), JSON.stringify({ run, applied_version: 3, applied_at: after.at }, null, 2), { mode: 0o600 });
  }, 300_000);
});
