import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { EVIDENCE, ALIAS, KEY, RUN, type ReplacementFixture } from './v4-contenedor-sustituido.fixtures.js';

export const FOLLOWUP = '/datos/workspaces/personal/cauce-v3/.delegados/v4/recibos/b3p2-cancelacion-tardia-1025/followup';
export const runDirectory = join(FOLLOWUP, 'e2e', RUN);
export const INJECTED_BOUNDARY = 'B3P2_LAB_INJECTED_AFTER_CREDENTIALS';
export interface BoundaryState {
  boundary: string; mode: string; unit: string; original_sha256: string; driver_sha256: string;
  marker: { operation_id: string; certificate_fingerprint: string } | null; released: boolean;
}
export interface LeaseObservation {
  instance_id: string; epoch: string; heartbeat_ms: number; lease_until_ms: number; observed_ms: number; fresh: boolean;
}

export async function saveFollowup(name: string, value: unknown): Promise<void> {
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(runDirectory, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('bounded boundary object required');
  return value as Record<string, unknown>;
}

function field(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string' || !value[key]) throw new Error(`boundary ${key} absent`);
  return value[key];
}

async function boundaryControl(fixture: ReplacementFixture, action: string, extra: string[] = []): Promise<BoundaryState> {
  const source = await readFile(new URL('./b3p2-credentials-boundary.py', import.meta.url), 'utf8');
  const result = await fixture.computer.onComputer(['python3', '-I', '-B', '-c', source, '--b3p2-control', action,
    fixture.policyFile, fixture.host, ...extra], action === 'install' ? source : undefined);
  expect(result.code, 'owned Lab boundary control must succeed').toBe(0);
  const value = object(JSON.parse(result.stdout) as unknown);
  const marker = value.marker === null ? null : object(value.marker);
  const state = { boundary: field(value, 'boundary'), mode: field(value, 'mode'), unit: field(value, 'unit'),
    original_sha256: field(value, 'original_sha256'), driver_sha256: field(value, 'driver_sha256'),
    marker: marker === null ? null : { operation_id: field(marker, 'operation_id'), certificate_fingerprint: field(marker, 'certificate_fingerprint') },
    released: value.released === true };
  expect(state.boundary).toBe(INJECTED_BOUNDARY);
  expect(state.original_sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(state.driver_sha256).toMatch(/^[a-f0-9]{64}$/u);
  if (state.marker) expect(state.marker.certificate_fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  return state;
}

export const installBoundary = (fixture: ReplacementFixture, mode: 'failure' | 'cancel', container: string): Promise<BoundaryState> =>
  boundaryControl(fixture, 'install', [mode, fixture.tenant, ALIAS, KEY, container]);
export const observeBoundary = (fixture: ReplacementFixture): Promise<BoundaryState> => boundaryControl(fixture, 'status');
export const releaseBoundary = (fixture: ReplacementFixture): Promise<BoundaryState> => boundaryControl(fixture, 'release');

export async function leaseSnapshot(fixture: ReplacementFixture): Promise<LeaseObservation | null> {
  return (await fixture.computer.pool.query<LeaseObservation>(`SELECT instance_id,epoch::text,
    extract(epoch FROM last_heartbeat_at)::float8*1000 AS heartbeat_ms,
    extract(epoch FROM lease_until)::float8*1000 AS lease_until_ms,
    extract(epoch FROM clock_timestamp())::float8*1000 AS observed_ms,lease_until>clock_timestamp() AS fresh
    FROM connection_leases WHERE tenant_id=$1 AND alias=$2`, [fixture.tenant, ALIAS])).rows[0] ?? null;
}

export async function sustainedHeartbeat(fixture: ReplacementFixture, observations: LeaseObservation[]): Promise<void> {
  let initial: LeaseObservation | null = null;
  await expect.poll(async () => { initial = await leaseSnapshot(fixture); return initial?.fresh; }, { timeout: 30_000 }).toBe(true);
  const first = initial as LeaseObservation | null;
  if (!first) throw new Error('restored original lease absent');
  observations.push(first);
  const violations: string[] = [];
  await expect.poll(async () => {
    const current = await leaseSnapshot(fixture);
    if (!current) { violations.push('lease absent'); return false; }
    observations.push(current);
    if (!current.fresh) violations.push('lease expired');
    if (current.instance_id !== first.instance_id || current.epoch !== first.epoch) violations.push('lease owner changed');
    return current.observed_ms - first.observed_ms > 35_000 && current.heartbeat_ms > first.heartbeat_ms;
  }, { timeout: 65_000, interval: 1_000 }).toBe(true);
  expect(violations).toEqual([]);
}

export async function rollbackSnapshot(fixture: ReplacementFixture, operationId: string): Promise<{
  cancel_requested: boolean; rollback_requests: number; rollback_completed: number; original_error: unknown;
}> {
  const operation = (await fixture.computer.pool.query<{ cancel_requested: boolean }>(
    'SELECT cancel_requested FROM fleet_operations WHERE id=$1', [operationId])).rows[0];
  if (!operation) throw new Error('post-credentials operation absent');
  const events = (await fixture.computer.pool.query<{ rollback_requests: number; rollback_completed: number; original_error: unknown }>(
    `SELECT count(*) FILTER(WHERE metadata ? 'rollback_requested')::int AS rollback_requests,
      count(*) FILTER(WHERE metadata->>'rollback_completed'='true')::int AS rollback_completed,
      (array_agg(metadata->'rollback_requested'->'original_error') FILTER(WHERE metadata ? 'rollback_requested'))[1] AS original_error
    FROM fleet_operation_events WHERE operation_id=$1`, [operationId])).rows[0];
  if (!events) throw new Error('post-credentials events absent');
  return { ...operation, ...events };
}

export async function followupCleanup(name: string): Promise<void> {
  const value: unknown = JSON.parse(await readFile(join(EVIDENCE, 'cleanup.json'), 'utf8'));
  expect(value).toEqual({ containers: '', volumes: '', images: '' });
  await saveFollowup(`${name}-cleanup`, value);
}
