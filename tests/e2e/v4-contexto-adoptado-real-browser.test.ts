import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isaTenant, newTrustedPage } from './console-functional-browser.fixtures.js';
import { prepareChatRuntimeIdentity } from './chat-runtime-identity.fixtures.js';
import { login, publish, startContextFixture, waitForDone, waitForLease } from './context-multiuser-continuity.fixtures.js';
import { asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const markerV1 = `ZZ-CONTEXTO-GROK-${run}-V1`;
const markerV2 = `ZZ-CONTEXTO-GROK-${run}-V2`;
const artifacts = join(process.cwd(), '.delegados/v4/recibos/c2-adopcion-contexto-1025');
let fixture: Awaited<ReturnType<typeof startContextFixture>> | undefined;
let adapter: ChildProcess | undefined;
let diagnostics = '';

function active() { if (!fixture) throw new Error('contexto adoptado fixture missing'); return fixture; }

async function appliedVersion(): Promise<number> {
  const row = await active().database.pool.query<{ applied_version: string }>(
    'SELECT applied_version::text AS applied_version FROM agent_context_state WHERE tenant_id=$1 AND alias=$2',
    [isaTenant.tenant, isaTenant.target],
  );
  return Number(row.rows[0]?.applied_version ?? -1);
}

async function startGrokAdapter(): Promise<void> {
  const fx = active();
  const tls = fx.pki.adapterCerts[0];
  if (!tls) throw new Error('owned adapter TLS missing');
  const home = join(fx.directory, 'grok-home');
  const space = join(fx.directory, 'grok-space');
  const state = join(fx.directory, 'grok-state');
  const kernel = join(fx.directory, 'grok-kernel.mjs');
  await Promise.all([home, space, state].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(kernel, `#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const prompt=Buffer.concat(chunks).toString('utf8');
const sidPath=join(process.env.HOME,'grok-kernel-session');
let sid;try{sid=await readFile(sidPath,'utf8');}catch{sid=randomUUID();await writeFile(sidPath,sid,{mode:0o600});}
const marker=prompt.includes(${JSON.stringify(markerV2)})?${JSON.stringify(markerV2)}:prompt.includes(${JSON.stringify(markerV1)})?${JSON.stringify(markerV1)}:'';
const result=JSON.stringify({reply:marker?'CONTEXTO GROK EN USO '+marker:'SIN CONTEXTO GROK',messages:[],notify:[],status:'done',retryable:false,artifacts:[]});
process.stdout.write(JSON.stringify({sessionId:sid,text:result,stopReason:'end_turn'})+'\\n');
`, { mode: 0o700 });
  adapter = spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/grok.js'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', HOME: home, GROK_HOME: join(home, '.grok'),
      CAUCE_TENANT: isaTenant.tenant, CAUCE_ROOM: isaTenant.room, CAUCE_ALIAS: isaTenant.target,
      CAUCE_INSTANCE_ID: `adoptado-grok-${run}`, CAUCE_STATE_DIR: state, CAUCE_SPACE_ROOT: space,
      CAUCE_RELAY_URL: `${fx.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test',
      CAUCE_HARNESS_COMMAND: kernel, CAUCE_HEARTBEAT_MS: '250', CAUCE_NO_PROGRESS_TIMEOUT_MS: '120000',
      CAUCE_TLS_CERT_FILE: tls.cert, CAUCE_TLS_KEY_FILE: tls.key, CAUCE_TLS_CA_FILE: fx.pki.ca.cert,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  adapter.stdout?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-16 * 1024); });
  adapter.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-16 * 1024); });
  fx.adapters.push(adapter);
}

describe('adopción de contexto versionado por un agente Grok V4', () => {
  beforeAll(async () => {
    await mkdir(artifacts, { recursive: true });
    fixture = await startContextFixture();
    await fixture.database.pool.query(
      "UPDATE agents SET harness_id='grok' WHERE tenant_id=$1 AND alias=$2",
      [isaTenant.tenant, isaTenant.target],
    );
  }, 600_000);

  afterAll(async () => {
    await writeFile(join(artifacts, `grok-adapter-${run}.log`), diagnostics, { mode: 0o600 }).catch(() => undefined);
    await fixture?.close();
  }, 180_000);

  it('publicar una versión, reiniciar el agente y conversar acredita applied_version', async () => {
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
    await startGrokAdapter();
    await waitForLease(fx, isaTenant);
    const first = await publish(page, fx, isaTenant, isaTenant.room, `turno grok ${run} uno`);
    const doneFirst = await waitForDone(fx, first.deliveryId);
    expect(doneFirst.result).toMatchObject({ output: { reply: `CONTEXTO GROK EN USO ${markerV1}`, status: 'done' } });
    await expect.poll(appliedVersion, { timeout: 60_000 }).toBe(1);
    const outbox = await fx.database.pool.query<{ state: string; applied: boolean }>(
      `SELECT state, applied_at IS NOT NULL AS applied FROM agent_context_outbox
        WHERE tenant_id=$1 AND alias=$2 AND version=1`, [isaTenant.tenant, isaTenant.target]);
    expect(outbox.rows[0]).toMatchObject({ applied: true });

    await page.goto(`${fx.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}?view=context`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
    const versions2 = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
    await versions2.waitFor({ timeout: 20_000 });
    await versions2.locator('textarea').first().fill(`Misión ${markerV2}`);
    await versions2.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
    const second = await publish(page, fx, isaTenant, isaTenant.room, `turno grok ${run} dos`);
    const doneSecond = await waitForDone(fx, second.deliveryId);
    expect(doneSecond.result).toMatchObject({ output: { reply: `CONTEXTO GROK EN USO ${markerV2}`, status: 'done' } });
    await expect.poll(appliedVersion, { timeout: 60_000 }).toBe(2);
    await page.screenshot({ path: join(artifacts, `grok-adoptado-${run}-1440.png`) });
    await writeFile(join(artifacts, `grok-adoptado-${run}.json`), JSON.stringify({ run, applied_version: 2 }, null, 2), { mode: 0o600 });
  }, 300_000);
});
