import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { requireDockerLab } from '../integration/b2-lab.js';
import { authoritySnapshot, changeUpdateDraft, compensationProof, databaseSnapshot, DESTINATION, ORIGINAL,
  resourceOwnership, runtimeDiagnostic, seedPriorMemberships, volumeSnapshot } from './b3p2-cancelacion.helpers.js';
import { followupCleanup, installBoundary, observeBoundary, releaseBoundary, rollbackSnapshot, runDirectory,
  saveFollowup, sustainedHeartbeat, type LeaseObservation } from './b3p2-credentials.helpers.js';
import { confirmReplacement, createReplacementAgent, operations, replacementUpdatePanel, reply, snapshot,
  startReplacementFixture, type Operation, type ReplacementFixture } from './v4-contenedor-sustituido.fixtures.js';

let fixture: ReplacementFixture | undefined;
let installed = false;
let scenario = 0;
let evidence: Record<string, unknown> = {};
const active = () => { if (!fixture) throw new Error('post-credentials fixture absent'); return fixture; };

beforeEach(async () => {
  await requireDockerLab();
  scenario += 1; installed = false; evidence = {};
  await saveFollowup(`case-${String(scenario)}`, { phase: 'starting' });
  fixture = await startReplacementFixture();
}, 900_000);

afterEach(async () => {
  const failures: unknown[] = [];
  try { if (installed && fixture) evidence.boundary_cleanup = await releaseBoundary(fixture); }
  catch (error) { failures.push(error); }
  try { await fixture?.close(); if (fixture) await followupCleanup(`case-${String(scenario)}`); }
  catch (error) { failures.push(error); }
  finally { fixture = undefined; await saveFollowup(`case-${String(scenario)}`, evidence); }
  if (failures.length) throw new AggregateError(failures, 'post-credentials cleanup incomplete');
}, 300_000);

async function prepareBoundary(mode: 'failure' | 'cancel') {
  const current = active();
  evidence.create = await createReplacementAgent(current);
  evidence.reply_before = await reply(current, 'BEFORE-POST-CREDENTIALS');
  await seedPriorMemberships(current);
  const prior = await databaseSnapshot(current);
  const original = await snapshot(ORIGINAL);
  expect(original?.running).toBe(true);
  if (!original) throw new Error('original container absent');
  const volumes = await volumeSnapshot(original.volumes);
  const authority = await authoritySnapshot(current);
  expect(authority.fleet_mtls?.normal).toBe(1);
  expect(authority.fleet_token?.normal).toBe(1);
  evidence.database_before = prior; evidence.original_before = original;
  evidence.volumes_before = volumes; evidence.authority_before = authority;
  evidence.ownership = await resourceOwnership(current, original.id);
  const boundary = await installBoundary(current, mode, ORIGINAL); installed = true;
  evidence.boundary_installed = boundary;
  expect(boundary.marker).toBeNull();
  const panel = await replacementUpdatePanel(current);
  await panel.getByLabel('Plantilla de ejecución').selectOption('0');
  expect(await panel.getByLabel('Contenedor operativo').inputValue()).toBe(ORIGINAL);
  await changeUpdateDraft(panel);
  await confirmReplacement(panel);
  let operationId = '';
  await expect.poll(async () => {
    const state = await observeBoundary(current);
    evidence.boundary_at_credentials = state;
    operationId = state.marker?.operation_id ?? '';
    return state.marker !== null;
  }, { timeout: 180_000, interval: 250 }).toBe(true);
  const operation = (await operations(current)).find(row => row.id === operationId);
  expect(operation).toMatchObject({ kind: 'update', status: 'running' });
  expect(operation?.steps.map(step => step.name)).toEqual([
    'prepare', 'stop', 'artifacts', 'credentials', 'runtime', 'authenticate', 'profile', 'verify', 'admission',
  ]);
  for (const name of ['prepare', 'stop', 'artifacts']) expect(operation?.steps.find(step => step.name === name)?.status).toBe('succeeded');
  expect(operation?.steps.find(step => step.name === 'stop')?.evidence).toMatchObject({ stopped_verified: true });
  expect(operation?.steps.find(step => step.name === 'credentials')?.status).toBe('running');
  expect(operation?.steps.find(step => step.name === 'runtime')?.status).toBe('pending');
  expect(await snapshot(ORIGINAL)).toEqual(original);
  expect(await snapshot(DESTINATION)).toBeNull();
  evidence.operation_at_credentials = operation;
  const checkpoint = await compensationProof(current, operationId);
  expect(checkpoint?.original_container_id).toBe(original.id);
  if (!checkpoint) throw new Error('post-credentials original checkpoint absent');
  for (const key of ['snapshot_sha256', 'checkpoint_sha256', 'normal_certificate_sha256', 'normal_token_sha256'] as const) {
    expect(checkpoint[key]).toMatch(/^[a-f0-9]{64}$/u);
  }
  evidence.checkpoint = checkpoint;
  await current.page.screenshot({ path: join(runDirectory, `case-${String(scenario)}-credentials.png`) });
  return { prior, original, volumes, authority, operationId, boundary };
}

async function requestCancellation(operationId: string): Promise<void> {
  const current = active();
  const card = current.page.getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: operationId });
  const cancel = card.getByRole('button', { name: 'Cancelar', exact: true });
  await expect.poll(() => cancel.isDisabled(), { timeout: 30_000 }).toBe(false);
  await cancel.click();
  await expect.poll(async () => (await operations(current)).find(row => row.id === operationId)?.status,
    { timeout: 30_000, interval: 100 }).toBe('cancelling');
  evidence.explicit_cancel_at_barrier = await rollbackSnapshot(current, operationId);
  expect(evidence.explicit_cancel_at_barrier).toMatchObject({ cancel_requested: true, rollback_requests: 0 });
  expect((await observeBoundary(current)).released).toBe(false);
}

async function assertContinuity(before: Awaited<ReturnType<typeof prepareBoundary>>, status: 'failed' | 'cancelled'): Promise<void> {
  const current = active();
  let terminal: Operation | undefined;
  await expect.poll(async () => {
    terminal = (await operations(current)).find(row => row.id === before.operationId);
    evidence.terminal = terminal;
    return terminal?.status;
  }, { timeout: 240_000, interval: 500 }).toBe(status);
  const rollback = await rollbackSnapshot(current, before.operationId);
  evidence.rollback = rollback;
  expect(rollback.cancel_requested).toBe(status === 'cancelled');
  if (status === 'failed') {
    expect(rollback).toMatchObject({ rollback_requests: 1, rollback_completed: 1,
      original_error: { code: 'STEP_FAILED', step: 'credentials', retryable: true } });
    expect(terminal?.error).toEqual({ code: 'STEP_FAILED', step: 'credentials', retryable: false });
  } else {
    expect(rollback).toMatchObject({ rollback_requests: 0, rollback_completed: 0 });
    expect(terminal?.error).toEqual({ code: 'CANCELLED', retryable: false });
  }
  expect(await databaseSnapshot(current)).toEqual(before.prior);
  expect(await snapshot(ORIGINAL)).toEqual(before.original);
  expect(await snapshot(DESTINATION)).toBeNull();
  evidence.authority_restored = await authoritySnapshot(current);
  expect(evidence.authority_restored).toEqual(before.authority);
  const heartbeats: LeaseObservation[] = [];
  evidence.heartbeat_observations = heartbeats;
  await sustainedHeartbeat(current, heartbeats);
  evidence.reply_after_35s = await reply(current, 'AFTER-POST-CREDENTIALS-35S');
  evidence.database_after = await databaseSnapshot(current);
  evidence.original_after = await snapshot(ORIGINAL);
  evidence.authority_after = await authoritySnapshot(current);
  evidence.volumes_after = await volumeSnapshot(before.original.volumes);
  expect(evidence.database_after).toEqual(before.prior);
  expect(evidence.original_after).toEqual(before.original);
  expect(evidence.authority_after).toEqual(before.authority);
  expect(evidence.volumes_after).toEqual(before.volumes);
  expect(await snapshot(DESTINATION)).toBeNull();
  const boundary = await observeBoundary(current);
  evidence.boundary_after = boundary;
  expect(boundary.original_sha256).toBe(before.boundary.original_sha256);
  expect(boundary.driver_sha256).toBe(before.boundary.driver_sha256);
  expect(boundary.marker?.operation_id).toBe(before.operationId);
  evidence.runtime_diagnostic_after = await runtimeDiagnostic(current, before.operationId);
  await current.page.screenshot({ path: join(runDirectory, `case-${String(scenario)}-restored.png`) });
}

async function recordFailure(error: unknown): Promise<void> {
  evidence.failure = error instanceof Error ? error.message : String(error);
  const current = active();
  try {
    evidence.operations_at_failure = await operations(current);
    const state = installed ? await observeBoundary(current) : undefined;
    evidence.boundary_at_failure = state;
    if (state?.marker) evidence.runtime_diagnostic = await runtimeDiagnostic(current, state.marker.operation_id);
  } catch { evidence.diagnostic_available = false; }
  await current.page.screenshot({ path: join(runDirectory, `case-${String(scenario)}-failure.png`) });
}

describe('continuidad del mismo contenedor tras credenciales reales', () => {
  it('restaura automáticamente tras un fallo de frontera inyectado y conserva FAILED con su causa', async () => {
    try {
      const before = await prepareBoundary('failure');
      evidence.boundary_released = await releaseBoundary(active());
      await assertContinuity(before, 'failed');
    } catch (error) { await recordFailure(error); throw error; }
  }, 900_000);

  it('restaura tras cancelar desde la consola durante la barrera posterior a credenciales', async () => {
    try {
      const before = await prepareBoundary('cancel');
      await requestCancellation(before.operationId);
      evidence.boundary_released = await releaseBoundary(active());
      await assertContinuity(before, 'cancelled');
    } catch (error) { await recordFailure(error); throw error; }
  }, 900_000);
});
