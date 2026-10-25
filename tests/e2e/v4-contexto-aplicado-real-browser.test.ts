import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isaTenant, newTrustedPage } from './console-functional-browser.fixtures.js';
import { prepareChatRuntimeIdentity } from './chat-runtime-identity.fixtures.js';
import { login, publish, startContextFixture, waitForDone, waitForLease } from './context-multiuser-continuity.fixtures.js';
import { apiGet, asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const marker = `ZZ-APLICADO-${run}`;
const artifacts = join(process.cwd(), '.delegados/v4/recibos/c1-contexto-aplicado-1025');
let fixture: Awaited<ReturnType<typeof startContextFixture>> | undefined;
let adapter: ChildProcess | undefined;
let diagnostics = '';

function active() { if (!fixture) throw new Error('contexto aplicado fixture missing'); return fixture; }
function perfilPath() { return `/v3/console/tenants/${isaTenant.tenant}/agents/${isaTenant.target}/perfil`; }

async function startAdapter(home: string): Promise<void> {
  const fx = active();
  const tls = fx.pki.adapterCerts[0];
  if (!tls) throw new Error('owned adapter TLS missing');
  const state = join(fx.directory, 'aplicado-state');
  const witness = join(fx.directory, 'aplicado-kernel.mjs');
  await Promise.all([home, join(home, '.codex'), state].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(witness, `#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
const args=process.argv.slice(2);const resume=args.indexOf('resume');
const sid=resume<0?randomUUID():args[resume+2];
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const prompt=Buffer.concat(chunks).toString('utf8');
const found=${JSON.stringify(marker)};
const output={reply:prompt.includes(found)?'PERFIL EN USO '+found:'SIN PERFIL NUEVO',messages:[],notify:[],status:'done',retryable:false,artifacts:[]};
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:sid})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}})+'\\n');
`, { mode: 0o700 });
  adapter = spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/codex.js'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', HOME: home, CODEX_HOME: join(home, '.codex'),
      CAUCE_TENANT: isaTenant.tenant, CAUCE_ROOM: isaTenant.room, CAUCE_ALIAS: isaTenant.target,
      CAUCE_INSTANCE_ID: `aplicado-${run}`, CAUCE_STATE_DIR: state,
      CAUCE_RELAY_URL: `${fx.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test',
      CAUCE_HARNESS_COMMAND: witness, CAUCE_HEARTBEAT_MS: '250',
      CAUCE_TLS_CERT_FILE: tls.cert, CAUCE_TLS_KEY_FILE: tls.key, CAUCE_TLS_CA_FILE: fx.pki.ca.cert,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  adapter.stdout?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-16 * 1024); });
  adapter.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-16 * 1024); });
  fx.adapters.push(adapter);
}

describe('contexto aplicado V4 en navegador real contra gateway y PostgreSQL reales', () => {
  beforeAll(async () => {
    await mkdir(artifacts, { recursive: true });
    fixture = await startContextFixture();
  }, 600_000);

  afterAll(async () => {
    await writeFile(join(artifacts, `adapter-${run}.log`), diagnostics, { mode: 0o600 }).catch(() => undefined);
    await fixture?.close();
  }, 180_000);

  it('un cambio de perfil desde la consola se acredita tras un turno real del agente', async () => {
    const fx = active();
    const home = fx.directory;
    const page: V4Page = asV4Page(await newTrustedPage(fx, { width: 1440, height: 900 }));
    await login(page, fx, isaTenant);
    await page.goto(`${fx.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}?view=context`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Identidad y propósito', { exact: true }).waitFor({ timeout: 20_000 });
    const before = await apiGet(page, perfilPath());
    expect(before.status).toBe(200);
    const revisionBefore = Number(before.body.revision);
    expect(revisionBefore).toBeGreaterThanOrEqual(1);
    expect(before.body.applied_revision).toBeNull();

    await page.getByLabel('Motivo de este cambio de perfil', { exact: true }).fill('Aplicar el perfil V4 y acreditarlo en un turno real.');
    await page.getByLabel('Identidad y propósito', { exact: true }).fill(`Propósito aplicado ${marker}.`);
    await page.getByRole('button', { name: 'Guardar y aplicar perfil', exact: true }).click();

    await expect.poll(async () => {
      const row = await fx.database.pool.query<{ revision: string; applied_revision: string | null }>(
        'SELECT revision::text, applied_revision::text FROM agent_profiles WHERE tenant_id=$1 AND alias=$2',
        [isaTenant.tenant, isaTenant.target],
      );
      return Number(row.rows[0]?.revision ?? 0);
    }, { timeout: 30_000 }).toBe(revisionBefore + 1);
    const desired = revisionBefore + 1;
    const expectation = await fx.database.pool.query<{ revision: string }>(
      'SELECT revision::text AS revision FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2',
      [isaTenant.tenant, isaTenant.target],
    );
    expect(Number(expectation.rows[0]?.revision ?? 0)).toBe(desired);
    await page.getByText(/pendiente|solo tiene acreditada/i).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    const pending = await apiGet(page, perfilPath());
    expect(pending.body.runtime_state).toBe('pending');
    expect(pending.body.applied_revision).toBeNull();

    await prepareChatRuntimeIdentity(fx, isaTenant);
    await startAdapter(home);
    await waitForLease(fx, isaTenant);
    const published = await publish(page, fx, isaTenant, isaTenant.room, `turno aplicado ${run}`);
    const done = await waitForDone(fx, published.deliveryId);
    expect(done.result).toMatchObject({ output: { reply: `PERFIL EN USO ${marker}`, status: 'done' } });

    await expect.poll(async () => {
      const row = await fx.database.pool.query<{ applied_revision: string | null }>(
        'SELECT applied_revision::text FROM agent_profiles WHERE tenant_id=$1 AND alias=$2',
        [isaTenant.tenant, isaTenant.target],
      );
      const appliedValue = row.rows[0]?.applied_revision;
      return appliedValue === null || appliedValue === undefined ? null : Number(appliedValue);
    }, { timeout: 30_000 }).toBe(desired);

    const applied = await apiGet(page, perfilPath());
    expect(applied.body.runtime_state).toBe('applied');
    expect(Number(applied.body.applied_revision)).toBe(desired);
    await page.goto(`${fx.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}?view=context`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Adopción acreditada', { exact: true }).waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(artifacts, `aplicado-${run}-1440.png`) });
    await writeFile(join(artifacts, `aplicado-${run}.json`), JSON.stringify({
      run, desired, runtime_state: applied.body.runtime_state, delivery: published.deliveryId,
    }, null, 2), { mode: 0o600 });
  }, 300_000);
});
