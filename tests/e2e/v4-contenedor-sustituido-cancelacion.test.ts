import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { requireDockerLab } from '../integration/b2-lab.js';
import { bodySnippet } from './v4-console-real-browser.helpers.js';
import { KEY, confirmReplacement, createReplacementAgent, operations, replacementUpdatePanel,
  reply, snapshot, startReplacementFixture, type Operation, type ReplacementFixture } from './v4-contenedor-sustituido.fixtures.js';
import { DESTINATION, ORIGINAL, authoritySnapshot, changeUpdateDraft, cleanupEvidence, compensationProof, databaseSnapshot,
  removeOwnedOriginal, resourceOwnership, retrySnapshot, runtimeDiagnostic, screenshotPath, seedPriorMemberships, volumeSnapshot, writeEvidence } from './b3p2-cancelacion.helpers.js';

let fixture: ReplacementFixture | undefined;
let paused = false;
let scenario = 0;
let evidence: Record<string, unknown> = {};
const active = () => { if (!fixture) throw new Error('late cancellation fixture absent'); return fixture; };

beforeEach(async () => {
  await requireDockerLab();
  scenario += 1; evidence = {};
  await writeEvidence(`case-${String(scenario)}`, { phase: 'starting' });
  fixture = await startReplacementFixture();
}, 900_000);

afterEach(async () => {
  const failures: unknown[] = [];
  try { if (paused) await docker(['unpause', DESTINATION]); }
  catch (error) { failures.push(error); }
  paused = false;
  try { await fixture?.close(); if (fixture) await cleanupEvidence(`case-${String(scenario)}`); }
  catch (error) { failures.push(error); }
  finally {
    fixture = undefined;
    await writeEvidence(`case-${String(scenario)}`, evidence);
  }
  if (failures.length) throw new AggregateError(failures, 'late cancellation cleanup incomplete');
}, 300_000);

async function prepareCancellation() {
  const current = active();
  evidence.create = await createReplacementAgent(current);
  evidence.reply_before = await reply(current, 'BEFORE-LATE-CANCEL');
  await seedPriorMemberships(current);
  const prior = await databaseSnapshot(current);
  evidence.database_before = prior;
  const original = await snapshot(ORIGINAL);
  expect(original?.running).toBe(true);
  if (!original) throw new Error('original container absent');
  evidence.original_before = original;
  evidence.ownership = await resourceOwnership(current, original.id);
  const volumes = await volumeSnapshot(original.volumes);
  evidence.volumes_before = volumes;
  const authority = await authoritySnapshot(current);
  expect(authority.fleet_mtls?.normal).toBe(1);
  expect(authority.fleet_token?.normal).toBe(1);
  evidence.authority_before = authority;
  const panel = await replacementUpdatePanel(current);
  await changeUpdateDraft(panel);
  await confirmReplacement(panel);
  let operation: Operation | undefined;
  await expect.poll(async () => {
    operation = (await operations(current)).find(row => row.kind === 'update');
    if (operation?.status !== 'running' || (await snapshot(DESTINATION))?.running !== true) return false;
    const metadata = await current.computer.onComputer(['docker', 'exec', '--user', '0', DESTINATION, 'test', '-f',
      `/run/cauce-fleet/${KEY}/cauce-v3-adapter.json`]);
    return metadata.code === 0;
  }, { timeout: 180_000, interval: 100 }).toBe(true);
  await docker(['pause', DESTINATION]); paused = true;
  evidence.replacement_at_cancel = await snapshot(DESTINATION);
  if (!operation) throw new Error('late cancellation operation absent');
  const operationId = operation.id;
  const proof = await compensationProof(current, operationId);
  expect(proof?.original_container_id).toBe(original.id);
  if (!proof) throw new Error('durable replacement checkpoint absent');
  for (const key of ['snapshot_sha256', 'checkpoint_sha256', 'normal_certificate_sha256', 'normal_token_sha256'] as const) {
    expect(proof[key]).toMatch(/^[a-f0-9]{64}$/u);
  }
  evidence.checkpoint = proof;
  return { prior, original, volumes, authority, operationId };
}

async function cancelOperation(operationId: string): Promise<void> {
  const current = active();
  const card = current.page.getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: operationId });
  const cancel = card.getByRole('button', { name: 'Cancelar', exact: true });
  await expect.poll(() => cancel.isDisabled(), { timeout: 30_000 }).toBe(false);
  await current.page.screenshot({ path: screenshotPath(`case-${String(scenario)}-before`) });
  await cancel.click();
  await expect.poll(async () => (await operations(current)).find(row => row.id === operationId)?.status,
    { timeout: 30_000, interval: 100 }).toBe('cancelling');
  await docker(['unpause', DESTINATION]); paused = false;
}

async function recordFailure(error: unknown): Promise<void> {
  evidence.failure = error instanceof Error ? error.message : String(error);
  try {
    const observed = await operations(active());
    evidence.operations_at_failure = observed;
    const update = observed.find(row => row.kind === 'update');
    if (update) evidence.runtime_diagnostic = await runtimeDiagnostic(active(), update.id);
  } catch { evidence.runtime_diagnostic = { available: false }; }
  evidence.page = await bodySnippet(active().page);
  await active().page.screenshot({ path: screenshotPath(`case-${String(scenario)}-failure`) });
}

describe('cancelación tardía de sustitución física', () => {
  it('restaura el original y su respuesta tras cancelar con el sustituto iniciado', async () => {
    const current = active();
    try {
      const before = await prepareCancellation();
      await cancelOperation(before.operationId);
      await expect.poll(async () => {
        const operation = (await operations(current)).find(row => row.id === before.operationId);
        evidence.cancel = operation;
        return operation?.status;
      }, { timeout: 180_000, interval: 500 }).toBe('cancelled');
      evidence.original_after = await snapshot(ORIGINAL);
      evidence.replacement_after = await snapshot(DESTINATION);
      const restored = await databaseSnapshot(current);
      evidence.database_after = restored;
      try { evidence.reply_after = await reply(current, 'AFTER-LATE-CANCEL'); }
      catch (error) { evidence.reply_failure = error instanceof Error ? error.message : String(error); }
      evidence.authority_after = await authoritySnapshot(current);
      evidence.volumes_after = await volumeSnapshot(before.original.volumes);
      await current.page.screenshot({ path: screenshotPath('restored-after') });
      expect(restored.agent).toMatchObject({ enabled: true, container_name: ORIGINAL });
      expect(evidence.reply_failure).toBeUndefined();
      expect(evidence.original_after).toEqual(before.original);
      expect(evidence.replacement_after).toBeNull();
      expect(restored).toEqual(before.prior);
      expect(evidence.authority_after).toEqual(before.authority);
      expect(evidence.volumes_after).toEqual(before.volumes);
      expect(await databaseSnapshot(current)).toEqual(before.prior);
      evidence.runtime_diagnostic_after = await runtimeDiagnostic(current, before.operationId);
    } catch (error) { await recordFailure(error); throw error; }
  }, 900_000);

  it('mantiene cancelling y la autoridad previa cuando el original no se puede verificar', async () => {
    const current = active();
    try {
      const before = await prepareCancellation();
      evidence.removed_original = await removeOwnedOriginal(current, before.original.id);
      expect(await snapshot(ORIGINAL)).toBeNull();
      await cancelOperation(before.operationId);
      const observations: Record<string, unknown>[] = [];
      let observedAttempts = 0;
      await expect.poll(async () => {
        const operation = (await operations(current)).find(row => row.id === before.operationId);
        const retries = await retrySnapshot(current, before.operationId);
        evidence.cancel = operation; evidence.retries = retries;
        expect(operation?.status).toBe('cancelling');
        expect(retries.terminal).toBe(0);
        if (retries.attempts.length > observedAttempts) {
          const authority = await authoritySnapshot(current);
          for (const [name, registry] of Object.entries(before.authority)) {
            expect(authority[name]?.records).toEqual(expect.arrayContaining(registry.records));
          }
          observations.push({ retries, authority, status: operation?.status, error: operation?.error });
          observedAttempts = retries.attempts.length;
          evidence.retry_observations = observations;
        }
        return retries.attempts.length >= 2 && retries.claims.length >= 2
          && new Set(retries.claims.map(row => row.epoch)).size >= 2;
      }, { timeout: 180_000, interval: 500 }).toBe(true);
      const retries = await retrySnapshot(current, before.operationId);
      expect(retries.claims.length).toBeGreaterThanOrEqual(2);
      expect(new Set(retries.claims.map(row => row.epoch)).size).toBeGreaterThanOrEqual(2);
      evidence.retries = retries;
      const operation = (await operations(current)).find(row => row.id === before.operationId);
      expect(operation?.status).toBe('cancelling');
      expect(operation?.error).toMatchObject({ retryable: true, reason: 'replacement_original_unverified' });
      const card = current.page.getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: before.operationId });
      await expect.poll(() => card.innerText(), { timeout: 30_000 })
        .toContain('No se pudo verificar el contenedor original de la actualización.');
      evidence.visible_cause = await card.innerText();
      const after = await authoritySnapshot(current);
      evidence.authority_after = after;
      for (const [name, registry] of Object.entries(before.authority)) {
        expect(after[name]?.records).toEqual(expect.arrayContaining(registry.records));
      }
      evidence.volumes_after = await volumeSnapshot(before.original.volumes);
      expect(evidence.volumes_after).toEqual(before.volumes);
      expect(await snapshot(ORIGINAL)).toBeNull();
      evidence.checkpoint_after = await compensationProof(current, before.operationId);
      evidence.runtime_diagnostic_after = await runtimeDiagnostic(current, before.operationId);
      await current.page.screenshot({ path: screenshotPath('unverified-after') });
    } catch (error) { await recordFailure(error); throw error; }
  }, 900_000);
});
