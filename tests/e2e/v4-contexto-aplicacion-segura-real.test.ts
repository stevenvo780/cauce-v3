import { initialDeadlineFactor } from './v4-contexto-aplicacion-segura-real.environment.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CauceRepository, processContextOutbox, settleContextApplications, withTransaction } from '@cauce/store';
import { persistContextVersionInTransaction } from '../../packages/store/src/context-version.js';
import { DeliveryContextRuntimeSink } from '../../services/gateway/src/context-version-runtime.js';
import { newTrustedPage } from './console-functional-browser.fixtures.js';
import { prepareChatRuntimeIdentity } from './chat-runtime-identity.fixtures.js';
import { browserDocker } from './browser-owned-lifecycle.js';
import { isaTenant, login, publish, startContextFixture, waitForDone, waitForLease } from './context-multiuser-continuity.fixtures.js';
import { apiGet, asV4Page } from './v4-console-real-browser.helpers.js';
import { memoryDigest, startLocalContextModel, startRealOpenClaw } from './v4-contexto-aplicacion-segura-real.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 12);
const artifacts = join(process.cwd(), '.delegados/v4/recibos/c7-aplicacion-segura-real-1025', run);
const memoryPath = 'context/MEMORY.md';
const seededMemory = `# Memoria sembrada\n\nzz-canary-${run}: fotografía anterior.\n`;
const nativeMemory = `${seededMemory}\nEdición nativa posterior: conservar café y brújula.\n`;
const serverMemory = `${nativeMemory}\nInstrucción posterior del servidor: versión tres.\n`;
let fixture: Awaited<ReturnType<typeof startContextFixture>> | undefined;
let adapter: Awaited<ReturnType<typeof startRealOpenClaw>> | undefined;
let model: Awaited<ReturnType<typeof startLocalContextModel>> | undefined;
let space = '';
let oldLeaseEpoch: number | undefined;
const active = () => { if (!fixture) throw new Error('safe context application fixture missing'); return fixture; };

async function application() {
  const rows = await active().database.pool.query<{ desired_version: string; applied_version: string; apply_error: string | null;
    infinite: boolean; digest: string | null }>(`SELECT state.desired_version::text,state.applied_version::text,
      outbox.apply_error,outbox.apply_retry_at='infinity' AS infinite,state.applied_digest AS digest
    FROM agent_context_state state JOIN agent_context_outbox outbox
      ON (outbox.company_id,outbox.tenant_id,outbox.alias,outbox.version)=
         (state.company_id,state.tenant_id,state.alias,state.desired_version)
    WHERE state.tenant_id=$1 AND state.alias=$2`, [isaTenant.tenant, isaTenant.target]);
  return rows.rows[0];
}

beforeAll(async () => {
  expect((await browserDocker(['info', '--format', '{{.Name}}'])).stdout.trim()).toBe('docker-lab');
  await mkdir(artifacts, { recursive: true });
  fixture = await startContextFixture();
  space = join(fixture.directory, 'c7-space');
  await Promise.all(['workspace', 'context', 'directives'].map(path => mkdir(join(space, path), { recursive: true, mode: 0o700 })));
  await fixture.database.pool.query("UPDATE agents SET harness_id='openclaw' WHERE tenant_id=$1 AND alias=$2",
    [isaTenant.tenant, isaTenant.target]);
  await withTransaction(fixture.database.pool, async client => {
    const company = (await client.query<{ company_id: string }>('SELECT company_id FROM tenants WHERE id=$1', [isaTenant.tenant])).rows[0];
    if (!company) throw new Error('owned context company missing');
    await persistContextVersionInTransaction(client, { company_id: company.company_id, tenant_id: isaTenant.tenant, alias: isaTenant.target },
      { humanId: null, homeTenant: isaTenant.tenant, alias: isaTenant.target }, 0, [{ path: memoryPath, content: seededMemory }], 'native');
  });
  await Promise.all([writeFile(join(space, memoryPath), seededMemory, { mode: 0o600 }),
    writeFile(join(space, 'workspace/MEMORY.md'), seededMemory, { mode: 0o600 })]);
  const repository = new CauceRepository(fixture.database.pool);
  const oldLease = await repository.acquireLease(isaTenant.tenant, isaTenant.target, `c7-legacy-${run}`, ['harness.openclaw'], 60_000);
  expect(oldLease.acquired).toBe(true);
  oldLeaseEpoch = oldLease.epoch;
  await processContextOutbox(fixture.database.pool, { runtime: new DeliveryContextRuntimeSink(fixture.database.pool) });
  await settleContextApplications(fixture.database.pool);
  model = await startLocalContextModel(space);
}, 600_000);

afterAll(async () => {
  const errors: unknown[] = [];
  try { await writeFile(join(artifacts, 'openclaw-adapter.log'), adapter?.diagnostics() ?? '', { mode: 0o600 }); }
  catch (error) { errors.push(error); }
  try { await adapter?.close(); } catch (error) { errors.push(error); }
  try { await model?.close(); } catch (error) { errors.push(error); }
  try { await fixture?.close(); } catch (error) { errors.push(error); }
  if (initialDeadlineFactor === undefined) delete process.env.CAUCE_PLAZOS_FACTOR;
  else process.env.CAUCE_PLAZOS_FACTOR = initialDeadlineFactor;
  if (errors.length) throw new AggregateError(errors, 'safe application cleanup incomplete');
}, 180_000);

describe('aplicación segura en OpenClaw real con modelo HTTP local determinista', () => {
  it('recupera unsupported, ingiere la memoria editada como v2 sin retroceder y adopta v3 en el turno siguiente', async () => {
    const fixture = active();
    if (!model) throw new Error('owned local model missing');
    await expect.poll(async () => (await application())?.apply_error, { timeout: 25_000 }).toBe('context_runtime_unsupported');
    expect(await application()).toMatchObject({ desired_version: '1', applied_version: '0', infinite: true });
    if (!oldLeaseEpoch) throw new Error('legacy canary lease epoch missing');
    expect(await new CauceRepository(fixture.database.pool).releaseLease(
      isaTenant.tenant, isaTenant.target, `c7-legacy-${run}`, oldLeaseEpoch)).toBe(true);
    await writeFile(join(space, 'workspace/MEMORY.md'), nativeMemory, { mode: 0o600 });
    await prepareChatRuntimeIdentity(fixture, isaTenant);
    const page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
    await login(page, fixture, isaTenant);
    const contextUrl = `/v3/console/context/agents/${isaTenant.tenant}/${isaTenant.target}`;
    expect((await apiGet(page, contextUrl)).body).toMatchObject({ version: 1, applied_version: 0,
      application: { state: 'error', last_error: 'context_runtime_unsupported' } });
    const bytesBefore = await readFile(join(space, 'workspace/MEMORY.md'));
    adapter = await startRealOpenClaw(fixture, space, model.endpoint, run);
    await waitForLease(fixture, isaTenant).catch((cause: unknown) => {
      throw new Error(`OpenClaw lease unavailable: ${adapter?.diagnostics() ?? ''}`, { cause });
    });
    const runtimeVersion = (await browserDocker(['exec', adapter.name, 'node', '-p',
      'require("/usr/local/lib/node_modules/openclaw/package.json").version'])).stdout.trim();
    expect(runtimeVersion).toMatch(/^\d{4}\.\d+\.\d+/u);
    const capabilities = (await fixture.database.pool.query<{ capabilities: string[] }>(
      'SELECT capabilities FROM connection_leases WHERE tenant_id=$1 AND alias=$2', [isaTenant.tenant, isaTenant.target])).rows[0]?.capabilities;
    expect(capabilities).toEqual(expect.arrayContaining(['versioned_context_v1', 'harness.openclaw']));
    await expect.poll(async () => (await application())?.apply_error, { timeout: 20_000 }).toBeNull();
    expect(await application()).toMatchObject({ desired_version: '1', applied_version: '0', infinite: false });

    const first = await publish(page, fixture, isaTenant, isaTenant.room, `zz-canary-${run} primer turno`);
    const firstDone = await waitForDone(fixture, first.deliveryId).catch((cause: unknown) => {
      throw new Error(`OpenClaw first turn failed: ${adapter?.diagnostics() ?? ''}; model=${JSON.stringify(model?.errors)}`, { cause });
    });
    await writeFile(join(artifacts, 'first-turn.json'), JSON.stringify({ result: firstDone.result,
      witnesses: model.witnesses, native_sha256: memoryDigest(await readFile(join(space, 'workspace/MEMORY.md'), 'utf8')),
      state: await application() }, null, 2), { mode: 0o600 });
    expect(firstDone.result).toMatchObject({ output: { reply: `OPENCLAW 2 ${memoryDigest(nativeMemory)}`, status: 'done', retryable: false },
      context_adoption: { version: 2 }, harness_consumption_v1: { harness_id: 'openclaw', evidence_kind: 'canonical_final_response' } });
    await expect.poll(async () => (await application())?.applied_version, { timeout: 30_000 }).toBe('2');
    const bytesAfterV2 = await readFile(join(space, 'workspace/MEMORY.md'));
    expect(bytesAfterV2).toEqual(bytesBefore);
    expect(await readFile(join(space, memoryPath), 'utf8')).toBe(nativeMemory);
    expect(await readdir(join(space, 'config/conflicts')).catch(() => [])).toEqual([]);
    const nativeVersion = (await fixture.database.pool.query<{ source: string; actor_alias: string; actor_human_id: string | null;
      files: { path: string; content: string }[] }>(`SELECT source,actor_alias,actor_human_id,files FROM agent_context_versions
      WHERE tenant_id=$1 AND alias=$2 AND version=2`, [isaTenant.tenant, isaTenant.target])).rows[0];
    expect(nativeVersion).toMatchObject({ source: 'native', actor_alias: isaTenant.target, actor_human_id: null });
    expect(nativeVersion?.files).toContainEqual({ path: memoryPath, content: nativeMemory });
    const current = await apiGet(page, contextUrl);
    expect(current.body).toMatchObject({ version: 2, applied_version: 2, application: { state: 'applied', last_error: null } });
    const files = (current.body.files as { path: string; content: string }[]).map(file => file.path === memoryPath ? { ...file, content: serverMemory } : file);
    const saved = await page.evaluate(async ({ url, files }) => {
      const session = await (await fetch('/v3/auth/session', { credentials: 'include' })).json() as { csrf_token: string };
      const response = await fetch(url, { method: 'PUT', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token },
        body: JSON.stringify({ expected_version: 2, source: 'ui', files }) });
      return { status: response.status, body: await response.json() as unknown };
    }, { url: contextUrl, files });
    expect(saved.status).toBe(202);
    expect(saved.body).toMatchObject({ version: 3, applied_version: 2 });
    expect(await readFile(join(space, 'workspace/MEMORY.md'))).toEqual(bytesBefore);
    const second = await publish(page, fixture, isaTenant, isaTenant.room, `zz-canary-${run} segundo turno`);
    const secondDone = await waitForDone(fixture, second.deliveryId).catch((cause: unknown) => {
      throw new Error(`OpenClaw second turn failed: ${adapter?.diagnostics() ?? ''}; model=${JSON.stringify(model?.errors)}`, { cause });
    });
    expect(secondDone.result).toMatchObject({ output: { reply: `OPENCLAW 3 ${memoryDigest(serverMemory)}`, status: 'done', retryable: false },
      context_adoption: { version: 3 }, harness_consumption_v1: { harness_id: 'openclaw', evidence_kind: 'canonical_final_response' } });
    await expect.poll(async () => (await application())?.applied_version, { timeout: 30_000 }).toBe('3');
    expect(await application()).toMatchObject({ desired_version: '3', applied_version: '3', apply_error: null });
    expect(await readFile(join(space, 'workspace/MEMORY.md'), 'utf8')).toBe(serverMemory);
    expect(model.errors).toEqual([]);
    expect(model.witnesses).toEqual([{ version: 2, model: 'c7-model', memory_sha256: memoryDigest(nativeMemory), native_memory_in_prompt: true },
      { version: 3, model: 'c7-model', memory_sha256: memoryDigest(serverMemory), native_memory_in_prompt: true }]);
    await page.goto(`${fixture.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}?view=context`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
    await page.getByText('Aplicada', { exact: true }).waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(artifacts, 'aplicada.png') });
    await writeFile(join(artifacts, 'evidence.json'), JSON.stringify({ run, daemon: 'docker-lab', openclaw: { real: true, version: runtimeVersion },
      provider: 'owned deterministic HTTP model; no provider account accredited', container: adapter.name, image: adapter.image, image_id: adapter.imageId,
      capabilities, native_v2: nativeVersion, first_delivery: first.deliveryId, second_delivery: second.deliveryId,
      first_result: firstDone.result, second_result: secondDone.result, native_bytes_preserved: bytesBefore.equals(bytesAfterV2),
      native_sha256_before: memoryDigest(bytesBefore.toString('utf8')), native_sha256_after_v2: memoryDigest(bytesAfterV2.toString('utf8')),
      witnesses: model.witnesses, final: await application() }, null, 2), { mode: 0o600 });
  }, 300_000);
});
