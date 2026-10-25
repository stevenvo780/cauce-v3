import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect } from 'vitest';
import { createCancelDeployActor, enqueueCancelDeploy, observeCancelDeployActor, openCancelDeployPanel,
  type CancelDeployActor } from './v4-fleet-cancel-deploy.flow.js';
import { CANCEL_DEPLOY_OWNER, cancelDeployCapture, cancelDeployRun, startCancelDeployFixture,
  type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { assertNativeSessionTurn, collectSessionFailure, seedSessionContext, sessionReceipt } from './v4-sesion-tras-despliegue.observe.js';
import { finishSessionDelivery, observeAutomaticActor, sendSessionDelivery, sessionPointerState } from './v4-sesion-tras-despliegue.control.js';
import { automaticSessionReleaseSource } from './v4-sesion-tras-despliegue.refs.js';
import { buildSessionRelease, installSessionRelease } from './v4-sesion-tras-despliegue.release.js';
import { AUTO_SESSION_OWNER, controlledSessionRuntime, prepareSessionQuotaImage, stageSessionDescriptors } from './v4-sesion-tras-despliegue.runtime.js';

export function observeMaintenanceScans(fixture: CancelDeployFixture, release: string) {
  const counts = { created: 0, started: 0, stopped: 0 };
  let phase: keyof typeof counts | undefined;
  const observe = (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST' || request.url !== '/v3/fleet/hosts/' + fixture.hostId + '/channel') return;
    const activePhase = phase;
    let chunks: Buffer[] = [], size = 0, matched = false;
    const capture = (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += bytes.length;
      if (size > 4096) { chunks = []; return; }
      chunks.push(bytes);
    };
    const listener = (event: string | symbol) => {
      if (event !== 'data') return;
      request.off('newListener', listener);
      request.on('data', capture);
    };
    if (request.listenerCount('data') > 0) request.on('data', capture);
    else request.on('newListener', listener);
    request.once('end', () => {
      request.off('newListener', listener);
      try {
        const value: unknown = size <= 4096 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        const payload = typeof value === 'object' && value !== null && 'payload' in value ? value.payload : undefined;
        matched = typeof payload === 'object' && payload !== null && 'resource' in payload && payload.resource === 'host_maintenance'
          && 'action' in payload && payload.action === 'reconcile' && 'release_sha256' in payload && payload.release_sha256 === release;
      } catch { matched = false; }
      chunks = [];
    });
    response.once('finish', () => { if (matched && response.statusCode === 200 && activePhase) counts[activePhase]++; });
  };
  fixture.computer.app.server.on('request', observe);
  return { counts, afterCreate() { phase = 'created'; }, afterStart() { phase = 'started'; }, afterStop() { phase = 'stopped'; },
    close() { fixture.computer.app.server.off('request', observe); } };
}

async function nullModelSelection(actor: CancelDeployActor) {
  const rows = (await actor.fixture.computer.pool.query<{
    model_id: string | null; primary_account_id: string; primary_room_id: string; runtime_key: string; host_id: string;
  }>(`SELECT model_id,primary_account_id,primary_room_id,runtime_key,host_id FROM agents
    WHERE tenant_id=$1 AND alias=$2 AND purged_at IS NULL`, [actor.fixture.tenantId, actor.alias])).rows;
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row?.model_id).toBeNull();
  expect(row?.primary_account_id).toBe(actor.fixture.accountId);
  return row;
}

async function noAutomaticHistory(actor: CancelDeployActor) {
  const rows = (await actor.fixture.computer.pool.query<{
    id: string; kind: string; status: string; actor_subject: string | null; maintenance: boolean;
  }>(`SELECT operation.id,operation.kind,operation.status,event.metadata->>'actor_subject' AS actor_subject,
    event.metadata ? 'maintenance' AS maintenance FROM fleet_operations operation
    JOIN fleet_operation_events event ON event.operation_id=operation.id AND event.event='queued'
    WHERE operation.company_id=$1 AND operation.target->>'resource'='agent'
      AND operation.target->>'tenant_id'=$2 AND operation.target->>'alias'=$3 ORDER BY event.id`,
  [actor.fixture.company, actor.fixture.tenantId, actor.alias])).rows;
  expect(rows.filter(row => row.maintenance || row.actor_subject?.startsWith('host:'))).toEqual([]);
  return rows;
}

export async function assertNullModelOwnerControl(): Promise<void> {
  expect(CANCEL_DEPLOY_OWNER).toBe(AUTO_SESSION_OWNER);
  const source = automaticSessionReleaseSource();
  const evidence: Record<string, unknown> = { task: 'h13b-actualizacion-automatica-v4-1025', run: cancelDeployRun,
    owner: AUTO_SESSION_OWNER, scenario: 'model-null-owner-control', releaseBReference: source.reference,
    releaseBWorkingTree: source.workingTree };
  const failures: unknown[] = [];
  let fixture: CancelDeployFixture | undefined, actor: CancelDeployActor | undefined;
  let scans: ReturnType<typeof observeMaintenanceScans> | undefined;
  try {
    const runtime = await controlledSessionRuntime();
    fixture = await startCancelDeployFixture({ runtimeBundle: runtime, initialSharedTui: true });
    const image = await prepareSessionQuotaImage(fixture, 'model-null');
    const release = await buildSessionRelease(fixture, 'model-null-b', source.reference, source.workingTree,
      { runtime, image: image.id, imageReference: image.reference, stageDescriptors: stageSessionDescriptors });
    evidence.sourceB = release;
    evidence.setupB = await installSessionRelease(fixture, release);
    scans = observeMaintenanceScans(fixture, release.manifest.release.sha256);
    const created = await createCancelDeployActor(fixture, 'nomodel');
    actor = created.actor;
    evidence.created = created.operation;
    evidence.selectionBefore = await nullModelSelection(actor);
    scans.afterCreate();
    const context = await seedSessionContext(actor);
    const initial = await finishSessionDelivery(actor, (await sendSessionDelivery(actor)).marker);
    const native = await assertNativeSessionTurn(actor, initial);
    expect(await sessionPointerState(actor)).toEqual({ exists: true, initialized: true, nativeId: native.witness.native_session_id });
    const before = await observeAutomaticActor(actor);
    expect(before.provider.model).toBeNull();
    expect(before.provider.contextSha256).toBe(context.sha256);
    evidence.initial = { context, native, before };
    await expect.poll(() => scans?.counts.created, { timeout: 65_000 }).toBeGreaterThan(0);
    evidence.historyAfterCreate = await noAutomaticHistory(actor);
    const stop = await openCancelDeployPanel(actor);
    await stop.getByLabel('¿Qué quieres hacer?').selectOption('stop');
    evidence.stopped = await enqueueCancelDeploy(actor, stop, 'stop');
    const stopped = await observeCancelDeployActor(actor);
    expect(stopped.adapterAlive).toBe(false);
    expect(stopped.normalProcesses).toBe(0);
    expect(stopped.volumes).toEqual(before.actor.volumes);
    evidence.afterStop = stopped;
    const start = await openCancelDeployPanel(actor);
    await start.getByLabel('¿Qué quieres hacer?').selectOption('start');
    evidence.started = await enqueueCancelDeploy(actor, start, 'start');
    scans.afterStart();
    const finalDelivery = await finishSessionDelivery(actor, (await sendSessionDelivery(actor)).marker);
    const finalNative = await assertNativeSessionTurn(actor, finalDelivery);
    expect(finalNative.witness.native_session_id).toBe(native.witness.native_session_id);
    expect(finalNative.witness.native_turn_id).not.toBe(native.witness.native_turn_id);
    const final = await observeAutomaticActor(actor);
    expect(final.actor.adapterAlive).toBe(true);
    expect(final.actor.volumes).toEqual(before.actor.volumes);
    expect(final.provider.model).toBeNull();
    expect(final.provider.contextSha256).toBe(context.sha256);
    expect(await nullModelSelection(actor)).toEqual(evidence.selectionBefore);
    await expect.poll(() => scans?.counts.started, { timeout: 65_000 }).toBeGreaterThan(0);
    const history = await noAutomaticHistory(actor);
    expect(history.map(row => ({ kind: row.kind, status: row.status }))).toEqual([
      { kind: 'create', status: 'succeeded' }, { kind: 'stop', status: 'succeeded' }, { kind: 'start', status: 'succeeded' },
    ]);
    evidence.historyAfterStart = history;
    evidence.scans = { ...scans.counts };
    evidence.final = { native: finalNative, observed: final };
    await cancelDeployCapture(fixture.page, 'auto-model-null-owner-control');
    fixture.errors.assertClean();
  } catch (error) {
    failures.push(error);
    evidence.failure = error instanceof Error ? error.message : String(error);
    if (actor) evidence.historyAtFailure = await noAutomaticHistory(actor).catch(() => 'automatic history was not empty');
    if (scans) evidence.scans = { ...scans.counts };
    if (fixture) await collectSessionFailure(fixture, actor, 'model-null').catch(() => undefined);
  } finally {
    scans?.close();
    if (fixture) {
      try { await fixture.close(); evidence.cleanup = { containers: '', volumes: '', images: '' }; }
      catch (error) { failures.push(error); evidence.cleanupError = error instanceof Error ? error.message : String(error); }
    }
    await sessionReceipt('auto-model-null-evidence', evidence);
  }
  if (failures.length) throw new AggregateError(failures, 'model-null owner lifecycle control failed');
}
