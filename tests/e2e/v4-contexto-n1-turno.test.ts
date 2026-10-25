import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isaTenant, jhonTenant, newTrustedPage, type FunctionalTenant } from './console-functional-browser.fixtures.js';
import { prepareChatRuntimeIdentity } from './chat-runtime-identity.fixtures.js';
import { login, publish, startContextFixture, waitForDone } from './context-multiuser-continuity.fixtures.js';
import { asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const M1 = `ZZ-N1-${run}-MISION-V1`;
const M2 = `ZZ-N1-${run}-MISION-V2`;
const M3 = `ZZ-N1-${run}-MISION-V3`;
const M4 = `ZZ-N1-${run}-MISION-V4`;
const NEW1 = `ZZ-N1-${run}-NUEVO-V2`;
const NEW2 = `ZZ-N1-${run}-NUEVO-V4`;
const artifacts = join(process.cwd(), '.delegados/v4/recibos/c5-contexto-n1-turno-1025', run);
let fixture: Awaited<ReturnType<typeof startContextFixture>> | undefined;
let diagnostics = '';
const adapters: ChildProcess[] = [];
function active() { if (!fixture) throw new Error('n1 fixture missing'); return fixture; }
async function applied(tenant: FunctionalTenant = isaTenant): Promise<{ version: number; at: string | null }> {
  const row = await active().database.pool.query<{ applied_version: string; applied_at: string | null }>(
    'SELECT applied_version::text AS applied_version, applied_at::text AS applied_at FROM agent_context_state WHERE tenant_id=$1 AND alias=$2',
    [tenant.tenant, tenant.target]);
  return { version: Number(row.rows[0]?.applied_version ?? -1), at: row.rows[0]?.applied_at ?? null };
}
async function openVersions(page: V4Page, tenant: FunctionalTenant = isaTenant) {
  await page.goto(`${active().baseUrl}/messages/${tenant.tenant}/${tenant.target}?view=context`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
  const region = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
  await region.waitFor({ timeout: 20_000 });
  return region;
}
async function addFile(page: V4Page, path: string, content: string, tenant: FunctionalTenant = isaTenant) {
  const region = await openVersions(page, tenant);
  await region.getByLabel('Nuevo archivo', { exact: true }).fill(path);
  await region.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
  await region.getByLabel(`Contenido de ${path}`, { exact: true }).fill(content);
  await region.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
  return region;
}
async function editMission(page: V4Page, content: string, newPath?: string, newContent?: string, tenant: FunctionalTenant = isaTenant) {
  const region = await openVersions(page, tenant);
  await region.locator('textarea').first().fill(content);
  if (newPath && newContent) {
    await region.getByLabel('Nuevo archivo', { exact: true }).fill(newPath);
    await region.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
    await region.getByLabel(`Contenido de ${newPath}`, { exact: true }).fill(newContent);
  }
  await region.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
  return region;
}
async function waitForInstance(instanceId: string, tenant: FunctionalTenant = isaTenant): Promise<void> {
  await expect.poll(async () => {
    const row = await active().database.pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND lease_until>now()',
      [tenant.tenant, tenant.target, instanceId]);
    return row.rows[0]?.count ?? 0;
  }, { timeout: 60_000 }).toBe(1);
}
function adoptionOf(done: { result: unknown }): { version?: number } {
  const result = done.result as { context_adoption?: { version?: number } } | null;
  return result?.context_adoption ?? {};
}
function track(child: ChildProcess): ChildProcess {
  adapters.push(child);
  active().adapters.push(child);
  child.stdout?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-16 * 1024); });
  child.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-16 * 1024); });
  return child;
}
async function startOpenClawKernel(): Promise<ChildProcess> {
  const fx = active();
  const tls = fx.pki.adapterCerts[0];
  if (!tls) throw new Error('owned adapter TLS missing');
  const home = join(fx.directory, 'n1-openclaw-home');
  const kernel = join(fx.directory, 'n1-openclaw-kernel.mjs');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const failing = `if(prompt.includes(${JSON.stringify(M3)})){const failed=JSON.stringify({reply:'',messages:[],notify:[],status:'error',retryable:false,artifacts:[]});process.stdout.write(JSON.stringify({result:{payloads:[{text:failed}]},session_id:sid})+'\\n');process.exit(0);}\nconst marker=prompt.includes(${JSON.stringify(NEW1)})?${JSON.stringify(NEW1)}:prompt.includes(${JSON.stringify(M2)})?${JSON.stringify(M2)}:prompt.includes(${JSON.stringify(M1)})?${JSON.stringify(M1)}:'';\nconst answer=JSON.stringify({reply:marker?'CONTEXTO N1 EN USO '+marker:'SIN CONTEXTO N1',messages:[],notify:[],status:'done',retryable:false,artifacts:[]});`;
  await writeFile(kernel, `#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
process.stderr.write('<<cauce:harness-started>>\\n');
const sidIndex=process.argv.indexOf('--session-key');
const sid=sidIndex>=0?process.argv[sidIndex+1]:undefined;
if(!sid)throw new Error('openclaw kernel requires --session-key');
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const prompt=Buffer.concat(chunks).toString('utf8');
${failing}
const sessions=join(process.env.HOME,'.openclaw','agents','main','sessions');
await mkdir(sessions,{recursive:true,mode:0o700});
const tidPath=join(process.env.HOME,'openclaw-kernel-transcript');
let tid;try{tid=await readFile(tidPath,'utf8');}catch{tid=randomUUID();await writeFile(tidPath,tid,{mode:0o600});}
const file=join(sessions,tid+'.jsonl');
const indexPath=join(sessions,'sessions.json');
let store={};try{store=JSON.parse(await readFile(indexPath,'utf8'));}catch{}
store['agent:main:'+sid]={sessionId:tid,sessionFile:file};
await writeFile(indexPath,JSON.stringify(store),{mode:0o600});
let existing='';try{existing=await readFile(file,'utf8');}catch{}
const line=(entry)=>JSON.stringify(entry)+'\\n';
if(!existing)await writeFile(file,line({type:'session',id:tid}),{mode:0o600});
const msg=(role,content)=>line({type:'message',id:randomUUID(),message:{role,content}});
await appendFile(file,msg('user',prompt.trim())+msg('assistant',[{type:'text',text:answer}]),{mode:0o600});
process.stdout.write(JSON.stringify({result:{payloads:[{text:answer}]},session_id:sid})+'\\n');
`, { mode: 0o700 });
  return track(spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/openclaw.js'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', HOME: home,
      CAUCE_OPENCLAW_WORKSPACE: join(home, 'workspace'),
      CAUCE_TENANT: isaTenant.tenant, CAUCE_ROOM: isaTenant.room, CAUCE_ALIAS: isaTenant.target,
      CAUCE_INSTANCE_ID: `n1-openclaw-${run}`, CAUCE_STATE_DIR: join(fx.directory, 'n1-openclaw-state'),
      CAUCE_SPACE_ROOT: join(fx.directory, 'n1-openclaw-space'),
      CAUCE_RELAY_URL: `${fx.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test',
      CAUCE_HARNESS_COMMAND: kernel, CAUCE_HEARTBEAT_MS: '250', CAUCE_NO_PROGRESS_TIMEOUT_MS: '120000',
      CAUCE_TLS_CERT_FILE: tls.cert, CAUCE_TLS_KEY_FILE: tls.key, CAUCE_TLS_CA_FILE: fx.pki.ca.cert,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}
async function startGrokKernel(): Promise<ChildProcess> {
  const fx = active();
  const tls = fx.pki.adapterCerts[1];
  if (!tls) throw new Error('owned adapter TLS missing');
  const home = join(fx.directory, 'n1-grok-home');
  const kernel = join(fx.directory, 'n1-grok-kernel.mjs');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(kernel, `#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const prompt=Buffer.concat(chunks).toString('utf8');
const sidPath=join(process.env.HOME,'grok-kernel-session');
let sid;try{sid=await readFile(sidPath,'utf8');}catch{sid=randomUUID();await writeFile(sidPath,sid,{mode:0o600});}
const marker=prompt.includes(${JSON.stringify(NEW2)})?${JSON.stringify(NEW2)}:prompt.includes(${JSON.stringify(M4)})?${JSON.stringify(M4)}:'';
const result=JSON.stringify({reply:marker?'CONTEXTO N1 GROK EN USO '+marker:'SIN CONTEXTO N1 GROK',messages:[],notify:[],status:'done',retryable:false,artifacts:[]});
process.stdout.write(JSON.stringify({sessionId:sid,text:result,stopReason:'end_turn'})+'\\n');
`, { mode: 0o700 });
  return track(spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/grok.js'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', HOME: home, GROK_HOME: join(home, '.grok'),
      CAUCE_TENANT: jhonTenant.tenant, CAUCE_ROOM: jhonTenant.room, CAUCE_ALIAS: jhonTenant.target,
      CAUCE_INSTANCE_ID: `n1-grok-${run}`, CAUCE_STATE_DIR: join(fx.directory, 'n1-grok-state'),
      CAUCE_SPACE_ROOT: join(fx.directory, 'n1-grok-space'),
      CAUCE_RELAY_URL: `${fx.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test',
      CAUCE_HARNESS_COMMAND: kernel, CAUCE_HEARTBEAT_MS: '250', CAUCE_NO_PROGRESS_TIMEOUT_MS: '120000',
      CAUCE_TLS_CERT_FILE: tls.cert, CAUCE_TLS_KEY_FILE: tls.key, CAUCE_TLS_CA_FILE: fx.pki.ca.cert,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

describe('contexto N+1 adoptado en el turno siguiente (OpenClaw, fallo y Grok)', () => {
  beforeAll(async () => {
    await mkdir(artifacts, { recursive: true });
    fixture = await startContextFixture();
    await fixture.database.pool.query("UPDATE agents SET harness_id='openclaw' WHERE tenant_id=$1 AND alias=$2",
      [isaTenant.tenant, isaTenant.target]);
  }, 600_000);
  afterAll(async () => {
    await writeFile(join(artifacts, `n1-adapters-${run}.log`), diagnostics, { mode: 0o600 }).catch(() => undefined);
    await fixture?.close();
  }, 180_000);

  it('OpenClaw adopta N+1 con fichero nuevo en el turno siguiente y la consola lo muestra', async () => {
    const fx = active();
    const page: V4Page = asV4Page(await newTrustedPage(fx, { width: 1440, height: 900 }));
    await login(page, fx, isaTenant);
    await addFile(page, 'context/mission.md', `Misión ${M1}`);
    await expect.poll(async () => (await applied()).version, { timeout: 20_000 }).toBe(0);
    await prepareChatRuntimeIdentity(fx, isaTenant);
    await startOpenClawKernel();
    await waitForInstance(`n1-openclaw-${run}`);
    const first = await publish(page, fx, isaTenant, isaTenant.room, `turno n1 ${run} uno`);
    const doneFirst = await waitForDone(fx, first.deliveryId);
    expect(doneFirst.result).toMatchObject({ output: { reply: `CONTEXTO N1 EN USO ${M1}`, status: 'done' } });
    expect(adoptionOf(doneFirst).version).toBe(1);
    await expect.poll(async () => (await applied()).version, { timeout: 60_000 }).toBe(1);
    await editMission(page, `Misión ${M2}`, 'context/extra.md', `Dato nuevo ${NEW1}`);
    const second = await publish(page, fx, isaTenant, isaTenant.room, `turno n1 ${run} dos`);
    const doneSecond = await waitForDone(fx, second.deliveryId);
    expect(doneSecond.result).toMatchObject({ output: { reply: `CONTEXTO N1 EN USO ${NEW1}`, status: 'done' } });
    expect(adoptionOf(doneSecond).version).toBe(2);
    const after = await applied();
    expect(after.version).toBe(2);
    expect(after.at).not.toBeNull();
    const region = await openVersions(page);
    expect(await region.innerText()).toMatch(/Usado por el agente\s+2/u);
    await region.getByText('Aplicada', { exact: true }).waitFor({ timeout: 20_000 });
    await writeFile(join(artifacts, `n1-openclaw-${run}.json`), JSON.stringify({ run, applied_version: 2, applied_at: after.at }, null, 2), { mode: 0o600 });
  }, 300_000);

  it('si el turno falla, la versión guardada no se da por aplicada', async () => {
    const fx = active();
    const page: V4Page = asV4Page(await newTrustedPage(fx, { width: 1440, height: 900 }));
    await login(page, fx, isaTenant);
    const beforeFail = await applied();
    expect(beforeFail.version).toBe(2);
    await editMission(page, `Misión ${M3}`);
    const failed = await publish(page, fx, isaTenant, isaTenant.room, `turno n1 ${run} fallido`);
    await expect.poll(async () => {
      const row = await fx.database.pool.query<{ status: string; result: { output?: { status?: string } } | null }>(
        'SELECT status,result FROM deliveries WHERE id=$1', [failed.deliveryId]);
      const current = row.rows[0];
      if (current?.status === 'dead') return 'failed';
      if (current?.status === 'done' && current.result?.output?.status === 'error') return 'failed';
      return current?.status ?? 'missing';
    }, { timeout: 120_000 }).toBe('failed');
    const afterFail = await applied();
    expect(afterFail.version).toBe(2);
    expect(afterFail.at).toBe(beforeFail.at);
    const region = await openVersions(page);
    expect(await region.innerText()).toMatch(/Usado por el agente\s+2/u);
    expect(await region.innerText()).not.toMatch(/Usado por el agente\s+3/u);
  }, 300_000);

  it('Grok adopta su N+1 con fichero nuevo en el turno siguiente', async () => {
    const fx = active();
    await fx.database.pool.query("UPDATE agents SET harness_id='grok' WHERE tenant_id=$1 AND alias=$2",
      [jhonTenant.tenant, jhonTenant.target]);
    const page: V4Page = asV4Page(await newTrustedPage(fx, { width: 1440, height: 900 }));
    await login(page, fx, jhonTenant);
    await addFile(page, 'context/mission.md', `Misión ${M4}`, jhonTenant);
    await prepareChatRuntimeIdentity(fx, jhonTenant);
    await startGrokKernel();
    await waitForInstance(`n1-grok-${run}`, jhonTenant);
    const first = await publish(page, fx, jhonTenant, jhonTenant.room, `turno n1 ${run} grok uno`);
    const doneFirst = await waitForDone(fx, first.deliveryId);
    expect(doneFirst.result).toMatchObject({ output: { reply: `CONTEXTO N1 GROK EN USO ${M4}`, status: 'done' } });
    await editMission(page, `Misión ${M2}`, 'context/extra-grok.md', `Dato nuevo ${NEW2}`, jhonTenant);
    const turn = await publish(page, fx, jhonTenant, jhonTenant.room, `turno n1 ${run} grok dos`);
    const done = await waitForDone(fx, turn.deliveryId);
    expect(done.result).toMatchObject({ output: { reply: `CONTEXTO N1 GROK EN USO ${NEW2}`, status: 'done' } });
    expect(adoptionOf(done).version).toBe(2);
    const after = await applied(jhonTenant);
    expect(after.version).toBe(2);
    expect(after.at).not.toBeNull();
    const region = await openVersions(page, jhonTenant);
    expect(await region.innerText()).toMatch(/Usado por el agente\s+2/u);
  }, 300_000);
});

