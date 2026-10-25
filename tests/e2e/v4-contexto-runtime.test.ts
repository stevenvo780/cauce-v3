import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { newTrustedPage } from './console-functional-browser.fixtures.js';
import { prepareChatRuntimeIdentity } from './chat-runtime-identity.fixtures.js';
import { browserDocker } from './browser-owned-lifecycle.js';
import { CONTEXT_ARTIFACT_DIR, isaTenant, login, readWitness, startContextFixture, waitForDone, waitForLease } from './context-multiuser-continuity.fixtures.js';
import { apiGet, asV4Page, bodySnippet, type V4Page } from './v4-console-real-browser.helpers.js';

const owner = 'e2e-a10-contextos-1025b';
const run = `zz-canary-${owner}-${randomUUID().slice(0, 8)}`;
const artifacts = join(process.cwd(), '.delegados/v4/recibos', owner, 'repository-runtime');
const filePath = 'directives/runtime.md';
const noteFilePath = 'context/notes/runtime.md';
let fixture: Awaited<ReturnType<typeof startContextFixture>> | undefined;
let spaceRoot = '';
let witnessPath = '';
let diagnostics = '';
let conflictReady = '';
let conflictRelease = '';
const initialDeadlineFactor = process.env.CAUCE_PLAZOS_FACTOR;

function active() { if (!fixture) throw new Error('context runtime fixture missing'); return fixture; }
function contextUrl() { return `${active().baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}?view=context`; }

async function screenshot(page: V4Page, name: string) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: join(artifacts, `runtime-${name}-${String(viewport.width)}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function sendTurn(page: V4Page, label: string): Promise<string> {
  const fixture = active();
  await page.goto(`${fixture.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
  const message = `${run}-${label}`;
  await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).fill(message);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  let deliveryId = '';
  await expect.poll(async () => {
    const delivery = await fixture.database.pool.query<{ id: string }>(
      `SELECT d.id FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2 AND m.body->>'text'=$3`,
      [isaTenant.tenant, isaTenant.target, message]);
    deliveryId = delivery.rows[0]?.id ?? '';
    return deliveryId;
  }, { timeout: 20_000 }).not.toBe('');
  return deliveryId;
}

async function finishTurn(page: V4Page, deliveryId: string, marker: string): Promise<void> {
  try {
    const completed = await waitForDone(active(), deliveryId);
    expect(completed.result).toMatchObject({ output: { reply: `CONTEXTO APLICADO ${marker}`, status: 'done', retryable: false } });
  } catch (cause) { throw new Error(`next runtime turn failed: ${diagnostics}; UI=${await bodySnippet(page)}`, { cause }); }
}

async function showVersions(page: V4Page) {
  await page.goto(contextUrl(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
  return page.getByRole('region', { name: 'Versiones de contexto', exact: true });
}

async function startAdapter() {
  const fixture = active();
  await prepareChatRuntimeIdentity(fixture, isaTenant);
  const tls = fixture.pki.adapterCerts[0];
  if (!tls) throw new Error('owned adapter TLS missing');
  const home = join(fixture.directory, 'runtime-home');
  const state = join(fixture.directory, 'r');
  spaceRoot = join(fixture.directory, 'runtime-space');
  witnessPath = join(fixture.directory, 'runtime-witness.jsonl');
  conflictReady = join(fixture.directory, 'native-conflict-ready');
  conflictRelease = join(fixture.directory, 'native-conflict-release');
  await Promise.all([home, join(home, '.codex'), state, spaceRoot].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const harness = join(fixture.directory, 'runtime-kernel.mjs');
  await writeFile(harness, `#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const args=process.argv.slice(2);const resume=args.indexOf('resume');
const sid=resume<0?randomUUID():args[resume+2];
if(resume>=0&&(args[resume+1]!=='--json'||args[resume+3]!=='-'||!/^[a-f0-9-]{36}$/u.test(sid)))throw new Error('native resume arguments differ');
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const prompt=Buffer.concat(chunks).toString('utf8');
const raw=/--- BEGIN VERSIONED AGENT CONTEXT ---\\n([\\s\\S]*?)\\n--- END VERSIONED AGENT CONTEXT ---/u.exec(prompt)?.[1];
if(!raw)throw new Error('current versioned context was not delivered');
const context=JSON.parse(raw);const disk=await readFile(${JSON.stringify(join(spaceRoot, filePath))},'utf8');
const native=await readFile(${JSON.stringify(join(spaceRoot, 'AGENTS.md'))},'utf8');
if(!native.includes(disk)||!(context.files?.some(file=>file.path===${JSON.stringify(filePath)}&&file.content===disk)||(context.materialized===true&&context.paths?.includes(${JSON.stringify(join(spaceRoot, filePath))}))))throw new Error('prompt and native files differ');
let note;try{note=await readFile(${JSON.stringify(join(spaceRoot, noteFilePath))},'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
if(note!==undefined){const rawNotes=/--- BEGIN AGENT NOTES \\(UNTRUSTED\\) ---\\n([\\s\\S]*?)\\n--- END AGENT NOTES \\(UNTRUSTED\\) ---/u.exec(prompt)?.[1];
const notes=rawNotes?JSON.parse(rawNotes):null;if(!native.includes(note)||!(Array.isArray(notes)?notes.some(file=>file.path===${JSON.stringify(noteFilePath)}&&file.content===note):notes?.paths?.includes(${JSON.stringify(join(spaceRoot, noteFilePath))})))throw new Error('agent notes were not delivered as untrusted context');}
await appendFile(${JSON.stringify(witnessPath)},JSON.stringify({version:context.version,digest:context.digest,argv:args,session_id:sid,resumed:resume>=0,content:disk,native_contains_current:true,note:note??null,notes_untrusted:note!==undefined})+'\\n',{mode:0o600});
if(prompt.includes('BLOCK_NATIVE_CONFLICT')){await writeFile(${JSON.stringify(conflictReady)},'ready',{mode:0o600});const deadline=Date.now()+90000;while(true){try{await readFile(${JSON.stringify(conflictRelease)});break;}catch(error){if(error.code!=='ENOENT'||Date.now()>deadline)throw error;await delay(20);}}}
const output={reply:'CONTEXTO APLICADO '+disk,messages:[],notify:[],status:'done',retryable:false,artifacts:[]};
const directory=join(process.env.CODEX_HOME,'sessions');await mkdir(directory,{recursive:true,mode:0o700});
const transcript=join(directory,'rollout-native-'+sid+'.jsonl');const turn=randomUUID();
const records=[...(resume<0?[{type:'session_meta',payload:{id:sid,cwd:process.cwd(),source:'exec'}}]:[]),
 {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}],internal_chat_message_metadata_passthrough:{turn_id:turn}}},
 {type:'event_msg',payload:{type:'task_complete',turn_id:turn,last_agent_message:JSON.stringify(output)}}];
await appendFile(transcript,records.map(record=>JSON.stringify(record)).join('\\n')+'\\n',{mode:0o600});
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:sid})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}})+'\\n');
`, { mode: 0o700 });
  const child = spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/codex.js'], { cwd: process.cwd(), env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', HOME: home, CODEX_HOME: join(home, '.codex'),
    CAUCE_TENANT: isaTenant.tenant, CAUCE_ROOM: isaTenant.room, CAUCE_ALIAS: isaTenant.target,
    CAUCE_INSTANCE_ID: run, CAUCE_STATE_DIR: state, CAUCE_SPACE_ROOT: spaceRoot,
    CAUCE_RELAY_URL: `${fixture.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test',
    CAUCE_HARNESS_COMMAND: harness, CAUCE_HEARTBEAT_MS: '250',
    CAUCE_TLS_CERT_FILE: tls.cert, CAUCE_TLS_KEY_FILE: tls.key, CAUCE_TLS_CA_FILE: fixture.pki.ca.cert,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-32 * 1024); });
  fixture.adapters.push(child);
  await waitForLease(fixture, isaTenant);
}

beforeAll(async () => {
  process.env.CAUCE_PLAZOS_FACTOR ??= '3';
  await mkdir(artifacts, { recursive: true });
  fixture = await startContextFixture();
  const mounts = JSON.parse((await browserDocker(['inspect', '--format', '{{json .Mounts}}', fixture.database.container.getId()])).stdout) as {
    Type: string; Name?: string;
  }[];
  await writeFile(join(artifacts, 'runtime-resources.json'), JSON.stringify({
    run, postgres: fixture.database.container.getId(), browser: fixture.browserContainer,
    browserImage: fixture.browserRuntime.image, browserImageId: fixture.browserRuntime.imageId,
    postgresVolumes: mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name),
  }, null, 2), { mode: 0o600 });
}, 600_000);

afterAll(async () => {
  const errors: unknown[] = [];
  try { await writeFile(join(artifacts, 'runtime-adapter.log'), diagnostics, { mode: 0o600 }); }
  catch (error) { errors.push(error); }
  try { await fixture?.close(); }
  catch (error) { errors.push(error); }
  try { await rm(CONTEXT_ARTIFACT_DIR, { recursive: true, force: true }); }
  catch (error) { errors.push(error); }
  if (initialDeadlineFactor === undefined) delete process.env.CAUCE_PLAZOS_FACTOR;
  else process.env.CAUCE_PLAZOS_FACTOR = initialDeadlineFactor;
  if (errors.length) throw new AggregateError(errors, 'context runtime cleanup incomplete');
}, 180_000);

describe('aplicación del contexto en el siguiente turno del SDK real', () => {
  it('edita desde Chromium, materializa y acredita dos versiones en la misma conversación nativa sintética', async () => {
    const fixture = active();
    const page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
    onTestFailed(async () => {
      await page.screenshot({ path: join(artifacts, 'runtime-failure.png') }).catch(() => undefined);
      await writeFile(join(artifacts, 'runtime-failure.txt'), `URL=${page.url()}\n${await bodySnippet(page)}\n${diagnostics}`, { mode: 0o600 });
    });
    await login(page, fixture, isaTenant);
    await startAdapter();
    const witnesses: Record<string, unknown>[] = [];
    for (const version of [1, 2]) {
      const marker = `${run.toUpperCase()}-VERSION-${String(version)}`;
      const versions = await showVersions(page);
      if (version === 1) {
        await versions.getByLabel('Nuevo archivo', { exact: true }).fill(filePath);
        await versions.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
      }
      await versions.getByLabel('Archivo', { exact: true }).selectOption(filePath);
      await versions.getByLabel(`Contenido de ${filePath}`, { exact: true }).fill(marker);
      await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      await versions.getByText(new RegExp(`Versión ${String(version)} · Consola`, 'u')).waitFor({ timeout: 20_000 });
      const before = await apiGet(page, `/v3/console/context/agents/${isaTenant.tenant}/${isaTenant.target}`);
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({ version, desired_version: version });
      expect(before.body.applied_version).not.toBe(version);
      await screenshot(page, `version-${String(version)}-pending`);

      await finishTurn(page, await sendTurn(page, `TURN-${String(version)}`), marker);
      const witness = (await readWitness(witnessPath)).at(-1);
      expect(witness).toMatchObject({ version, content: marker, native_contains_current: true, resumed: version === 2 });
      if (!witness) throw new Error('native invocation witness missing');
      expect(await readWitness(witnessPath)).toHaveLength(version);
      witnesses.push(witness);
      if (version === 2) expect(witness.argv).toEqual(['exec', '--skip-git-repo-check', 'resume', '--json', witnesses[0]?.session_id, '-']);
      expect(await readFile(join(spaceRoot, filePath), 'utf8')).toBe(marker);
      expect(await readFile(join(spaceRoot, 'AGENTS.md'), 'utf8')).toContain(marker);
      const applied = await fixture.database.pool.query<{ applied_version: string; applied_digest: string }>(
        `SELECT applied_version::text,applied_digest FROM agent_context_state WHERE tenant_id=$1 AND alias=$2`,
        [isaTenant.tenant, isaTenant.target]);
      expect(applied.rows).toEqual([{ applied_version: String(version), applied_digest: witness.digest }]);
      await page.goto(contextUrl(), { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
      await page.getByText('Aplicada', { exact: true }).waitFor({ timeout: 20_000 });
      await screenshot(page, `version-${String(version)}-applied`);
      const reread = await apiGet(page, `/v3/console/context/agents/${isaTenant.tenant}/${isaTenant.target}`);
      expect(reread.body).toMatchObject({ version, desired_version: version, applied_version: version });
    }
    expect(witnesses[1]?.session_id).toBe(witnesses[0]?.session_id);
    expect(witnesses).toHaveLength(2);
    await writeFile(join(artifacts, 'runtime-context-adoption.json'), JSON.stringify({
      run, provider: 'synthetic-kernel', chromium: 'real', gateway: 'real', postgres: 'real',
      scope: 'versioned-context-adoption; provider account and canonical profile adoption are not accredited', witnesses,
    }, null, 2), { mode: 0o600 });

    const marker = `${run.toUpperCase()}-VERSION-2`;
    const nativeNote = `${run}-NOTA NATIVA`;
    const conflictNote = `${run}-NOTA LOCAL EN CONFLICTO`;
    const serverNote = `${run}-NOTA DEL SERVIDOR`;
    const resolvedNote = `${serverNote}\n${conflictNote}`;
    await mkdir(join(spaceRoot, 'context/notes'), { recursive: true, mode: 0o700 });
    await writeFile(join(spaceRoot, noteFilePath), nativeNote, { mode: 0o600 });
    await finishTurn(page, await sendTurn(page, 'NATIVE-INGEST'), marker);
    const ingested = await fixture.database.pool.query<{ source: string; actor_alias: string; actor_human_id: string | null }>(
      'SELECT source,actor_alias,actor_human_id FROM agent_context_versions WHERE tenant_id=$1 AND alias=$2 AND version=3',
      [isaTenant.tenant, isaTenant.target]);
    expect(ingested.rows).toEqual([{ source: 'native', actor_alias: isaTenant.target, actor_human_id: null }]);
    expect((await readWitness(witnessPath)).at(-1)).toMatchObject({ version: 3, note: nativeNote, notes_untrusted: true });
    let versions = await showVersions(page);
    await versions.getByText(/Versión 3 · Nativo \(en el espacio\)/u).waitFor({ timeout: 20_000 });
    await versions.getByLabel('Archivo', { exact: true }).selectOption(noteFilePath);
    expect(await versions.getByLabel(`Contenido de ${noteFilePath}`, { exact: true }).inputValue()).toBe(nativeNote);
    await screenshot(page, 'native-note-ingested');

    await writeFile(join(spaceRoot, noteFilePath), conflictNote, { mode: 0o600 });
    await versions.getByLabel(`Contenido de ${noteFilePath}`, { exact: true }).fill(serverNote);
    await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
    await versions.getByText(/Versión 4 · Consola/u).waitFor({ timeout: 20_000 });
    const conflictedDelivery = await sendTurn(page, 'BLOCK_NATIVE_CONFLICT');
    try {
      await expect.poll(() => readFile(conflictReady, 'utf8').catch(() => ''), { timeout: 25_000 }).toBe('ready');
      const snapshot = await apiGet(page, `/v3/console/context/agents/${isaTenant.tenant}/${isaTenant.target}`);
      expect(snapshot.body).toMatchObject({ version: 4, application: { last_error: 'native_context_conflict' } });
      expect(await readFile(join(spaceRoot, 'config/conflicts', `${noteFilePath}.conflict`), 'utf8')).toBe(conflictNote);
      expect(await readFile(join(spaceRoot, noteFilePath), 'utf8')).toBe(serverNote);
      versions = await showVersions(page);
      await versions.getByText(/Conflicto de ingesta nativa:/u).waitFor({ timeout: 20_000 });
      await screenshot(page, 'native-conflict-preserved');
      await versions.getByRole('button', { name: 'Resolver desde esta ficha', exact: true }).click();
      await versions.getByText('Borrador sin guardar, basado en la versión 4.', { exact: true }).waitFor();
      await versions.getByLabel('Archivo', { exact: true }).selectOption(noteFilePath);
      await versions.getByLabel(`Contenido de ${noteFilePath}`, { exact: true }).fill(resolvedNote);
      await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      await versions.getByText(/Versión 5 · Consola/u).waitFor({ timeout: 20_000 });
      await screenshot(page, 'native-conflict-resolved-pending');
    } finally { await writeFile(conflictRelease, 'release', { mode: 0o600 }); }
    await finishTurn(page, conflictedDelivery, marker);
    await finishTurn(page, await sendTurn(page, 'RESOLUTION-ADOPTION'), marker);
    versions = await showVersions(page);
    await versions.getByText('Aplicada', { exact: true }).waitFor({ timeout: 20_000 });
    await versions.getByLabel('Archivo', { exact: true }).selectOption(noteFilePath);
    expect(await versions.getByLabel(`Contenido de ${noteFilePath}`, { exact: true }).inputValue()).toBe(resolvedNote);
    expect(await readFile(join(spaceRoot, noteFilePath), 'utf8')).toBe(resolvedNote);
    expect(await readFile(join(spaceRoot, 'config/conflicts', `${noteFilePath}.conflict`), 'utf8')).toBe(conflictNote);
    const resolved = await apiGet(page, `/v3/console/context/agents/${isaTenant.tenant}/${isaTenant.target}`);
    expect(resolved.body).toMatchObject({ version: 5, desired_version: 5, applied_version: 5,
      application: { state: 'applied', last_error: null } });
    expect((await readWitness(witnessPath)).at(-1)).toMatchObject({ version: 5, note: resolvedNote, notes_untrusted: true });
    await screenshot(page, 'native-conflict-resolved-applied');
    await writeFile(join(artifacts, 'runtime-native-conflict.json'), JSON.stringify({
      run, provider: 'synthetic-kernel', ingested: ingested.rows, resolved: resolved.body, witnesses: await readWitness(witnessPath),
    }, null, 2), { mode: 0o600 });
  }, 240_000);
});
