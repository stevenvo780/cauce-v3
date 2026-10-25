import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { requireDockerLab } from '../integration/b2-lab.js';
import { authoritySnapshot, compensationProof, databaseSnapshot, ORIGINAL, runtimeDiagnostic, volumeSnapshot } from './b3p2-cancelacion.helpers.js';
import { bodySnippet } from './v4-console-real-browser.helpers.js';
import { ALIAS, RUN, createReplacementAgent, operations, reply, snapshot, startReplacementFixture,
  type Operation, type ReplacementFixture } from './v4-contenedor-sustituido.fixtures.js';

// Production, 25-oct: adding the «Recursos» extension from Ajustes recreated the agent container in place (same name,
// new id); admission then failed and the automatic compensation looped on replacement_original_unverified forever,
// because it only accepted the original container id, which the in-place recreation had already removed.
const RECEIPTS = join(process.cwd(), '.delegados/v4/recibos/h15-compensacion-recreacion-in-situ-1025', RUN);
const RESTORED_LABEL = 'cauce.fleet.restored_by';
let fixture: ReplacementFixture | undefined;
let paused: string | undefined;
const evidence: Record<string, unknown> = { run: RUN };
const active = () => { if (!fixture) throw new Error('in-place recreation fixture absent'); return fixture; };
const screenshot = (name: string) => join(RECEIPTS, `${name}.png`);

async function inspectRuntime(): Promise<{ id: string; running: boolean; pids: number; labels: Record<string, string> } | null> {
  if (await snapshot(ORIGINAL) === null) return null;
  const value = JSON.parse(await docker(['inspect', '--format',
    '{"id":{{json .Id}},"running":{{json .State.Running}},"pids":{{json .HostConfig.PidsLimit}},"labels":{{json .Config.Labels}}}', ORIGINAL])) as
    { id: string; running: boolean; pids: number; labels: Record<string, string> };
  return value;
}

async function unpause(): Promise<void> {
  if (paused === undefined) return;
  const target = paused;
  paused = undefined;
  try { await docker(['unpause', target]); }
  catch (error) { evidence.unpause = error instanceof Error ? error.message.slice(0, 300) : String(error); }
}

async function allowResources(current: ReplacementFixture): Promise<void> {
  const allowed = { types: ['resources'], mount_roots: [], networks: [] };
  await current.computer.pool.query('UPDATE fleet_hosts SET extensions_allowed=$2::jsonb WHERE host_id=$1', [current.host, JSON.stringify(allowed)]);
  const setup = await current.computer.cli(['setup', '--install-root', current.computer.installRoot]);
  expect(setup.code, setup.stderr).toBe(0);
  const policy = await current.computer.onComputer(['python3', '-I', '-B', '-c',
    'import json,pathlib,sys;print(json.dumps(json.loads(pathlib.Path(sys.argv[1]).read_bytes()).get("extensions_allowed")))', current.policyFile]);
  expect(policy.code, policy.stderr).toBe(0);
  evidence.extensions_allowed = JSON.parse(policy.stdout);
  expect(evidence.extensions_allowed).toMatchObject({ types: ['resources'] });
}

async function openExtensions(current: ReplacementFixture) {
  await current.page.goto(`${current.baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${current.tenant}/${ALIAS}`)}`,
    { waitUntil: 'domcontentloaded' });
  const sheet = current.page.getByRole('dialog', { name: 'Canario sustitución', exact: true });
  await sheet.waitFor({ timeout: 30_000 });
  await sheet.getByRole('tab', { name: 'Ampliaciones', exact: true }).click();
  await sheet.getByRole('heading', { name: /^Ampliaciones activas/u }).waitFor();
  return sheet;
}

/** «Aplicar y recrear» with pids 512; the recreated container is paused once verify passes, so admission fails. */
async function applyResourcesAndFailAdmission(current: ReplacementFixture, originalId: string): Promise<Operation> {
  const sheet = await openExtensions(current);
  await sheet.getByRole('button', { name: 'Añadir ampliación Recursos', exact: true }).click();
  await sheet.getByLabel('Procesos (máx. 4096)', { exact: true }).fill('512');
  await sheet.getByRole('button', { name: 'Añadir al borrador', exact: true }).click();
  const preview = sheet.getByRole('button', { name: 'Vista previa', exact: true });
  await expect.poll(() => preview.isDisabled(), { timeout: 30_000 }).toBe(false); await preview.click();
  const apply = sheet.getByRole('button', { name: 'Aplicar y recrear', exact: true });
  await expect.poll(() => apply.isDisabled(), { timeout: 30_000 }).toBe(false);
  await current.page.screenshot({ path: screenshot('aplicar-y-recrear') });
  const known = new Set((await operations(current)).map(row => row.id));
  await apply.click();
  let operation: Operation | undefined;
  await expect.poll(async () => {
    operation = (await operations(current)).find(row => row.kind === 'update' && !known.has(row.id));
    if (operation?.status === 'succeeded') throw new Error('the update finished before its admission could be failed');
    const verify = operation?.steps.find(step => step.name === 'verify');
    const admission = operation?.steps.find(step => step.name === 'admission');
    return verify?.status === 'succeeded' || admission?.status === 'running';
  }, { timeout: 300_000, interval: 100 }).toBe(true);
  const recreated = await inspectRuntime();
  if (!operation || !recreated) throw new Error('in-place update or its recreated container absent');
  evidence.recreated = recreated;
  expect(recreated.id).not.toBe(originalId);
  expect(recreated.pids).toBe(512);
  expect(recreated.labels['cauce.fleet.operation']).toBe(operation.id);
  await docker(['pause', recreated.id]); paused = recreated.id;
  const operationId = operation.id;
  await expect.poll(async () => {
    operation = (await operations(current)).find(row => row.id === operationId);
    return operation?.status;
  }, { timeout: 180_000, interval: 100 }).not.toBe('running');
  await unpause();
  const failed = operation as Operation | undefined; // the poll callback reassigns it and may leave it undefined
  if (!failed) throw new Error('in-place update absent after its admission failure');
  evidence.failed = { status: failed.status, error: failed.error,
    steps: failed.steps.map(step => ({ name: step.name, status: step.status })) };
  expect(failed.steps.find(step => step.name === 'admission')?.status).toBe('failed');
  return failed;
}

beforeAll(async () => {
  await requireDockerLab();
  await mkdir(RECEIPTS, { recursive: true, mode: 0o700 });
  fixture = await startReplacementFixture();
}, 900_000);

afterAll(async () => {
  await unpause();
  try {
    if (fixture) {
      evidence.journal = (await fixture.computer.onComputer(['journalctl', '--user', '--no-pager', '-n', '120'])).stdout;
      evidence.operations_at_end = await operations(fixture).catch(() => []);
    }
  } finally {
    await writeFile(join(RECEIPTS, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    await fixture?.close();
    fixture = undefined;
  }
}, 300_000);

describe('compensación de una actualización que recrea el contenedor in situ', () => {
  it('restaura el runtime anterior y el agente vuelve a responder tras fallar la admisión', async () => {
    const current = active();
    try {
      await allowResources(current);
      evidence.create = await createReplacementAgent(current);
      evidence.reply_before = await reply(current, 'BEFORE-IN-PLACE');
      const prior = await databaseSnapshot(current);
      evidence.database_before = prior;
      const original = await snapshot(ORIGINAL);
      const runtimeBefore = await inspectRuntime();
      if (!original || !runtimeBefore) throw new Error('original container absent');
      expect(original.running).toBe(true);
      evidence.original_before = runtimeBefore;
      const volumes = await volumeSnapshot(original.volumes);
      evidence.volumes_before = volumes;
      const authority = await authoritySnapshot(current);
      evidence.authority_before = authority;

      const failed = await applyResourcesAndFailAdmission(current, original.id);
      const checkpoint = await compensationProof(current, failed.id);
      evidence.checkpoint = checkpoint;
      expect(checkpoint?.original_container_id).toBe(original.id);

      let settled: Operation | undefined;
      await expect.poll(async () => {
        settled = (await operations(current)).find(row => row.id === failed.id);
        evidence.compensation = { status: settled?.status, error: settled?.error, phase: (await compensationProof(current, failed.id))?.phase };
        return settled?.status !== 'cancelling';
      }, { timeout: 420_000, interval: 1_000 }).toBe(true);
      evidence.compensation = { status: settled?.status, error: settled?.error,
        steps: settled?.steps.map(step => ({ name: step.name, status: step.status })) };
      // An automatic restoration ends as the original failure, already restored and no longer retryable.
      expect(settled?.status).toBe('failed');
      expect(settled?.error).toMatchObject({ code: 'STEP_FAILED', step: 'admission', retryable: false });
      expect((await compensationProof(current, failed.id))?.phase).toBe('restored');

      const restored = await inspectRuntime();
      evidence.runtime_after = restored;
      expect(restored).toMatchObject({ running: true, pids: runtimeBefore.pids, labels: { [RESTORED_LABEL]: failed.id } });
      expect(restored?.id).not.toBe(original.id);
      expect(restored?.labels['cauce.fleet.operation']).toBeUndefined();
      evidence.volumes_after = await volumeSnapshot(original.volumes);
      expect(evidence.volumes_after).toEqual(volumes);
      evidence.authority_after = await authoritySnapshot(current);
      expect(evidence.authority_after).toEqual(authority);
      const database = await databaseSnapshot(current);
      evidence.database_after = database;
      expect(database).toEqual(prior);
      evidence.reply_after = await reply(current, 'AFTER-IN-PLACE');

      const sheet = await openExtensions(current);
      await sheet.getByRole('button', { name: 'Releer operación', exact: true }).click().catch(() => undefined);
      evidence.sheet_after = (await sheet.innerText()).slice(0, 4_000);
      await current.page.screenshot({ path: screenshot('restaurado') });
      evidence.runtime_diagnostic = await runtimeDiagnostic(current, failed.id);
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      try {
        const rows = await operations(current);
        evidence.operations_at_failure = rows;
        const update = rows.find(row => row.kind === 'update');
        if (update) {
          evidence.checkpoint_at_failure = await compensationProof(current, update.id);
          evidence.runtime_diagnostic = await runtimeDiagnostic(current, update.id);
        }
        evidence.runtime_at_failure = await inspectRuntime();
        evidence.page = await bodySnippet(current.page);
        await current.page.screenshot({ path: screenshot('fallo') });
      } catch (secondary) { evidence.failure_capture = secondary instanceof Error ? secondary.message : String(secondary); }
      throw error;
    }
  }, 1_500_000);
});
