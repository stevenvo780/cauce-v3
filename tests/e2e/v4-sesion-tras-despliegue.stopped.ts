import { expect } from 'vitest';
import { enqueueCancelDeploy, observeCancelDeployActor, openCancelDeployPanel } from './v4-fleet-cancel-deploy.flow.js';
import { CANCEL_DEPLOY_OWNER, cancelDeployCapture, cancelDeployRun, startCancelDeployFixture,
  type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { collectSessionFailure, sessionReceipt } from './v4-sesion-tras-despliegue.observe.js';
import { automaticOperations, observeAutomaticActor } from './v4-sesion-tras-despliegue.control.js';
import { automaticSessionReleaseSource } from './v4-sesion-tras-despliegue.refs.js';
import { buildSessionRelease, installSessionRelease } from './v4-sesion-tras-despliegue.release.js';
import { AUTO_SESSION_OWNER, controlledSessionRuntime, prepareSessionQuotaImage, stageSessionDescriptors } from './v4-sesion-tras-despliegue.runtime.js';
import { createCanary } from './v4-sesion-tras-despliegue.assertions.js';
import { observeMaintenanceScans } from './v4-sesion-tras-despliegue.model-null.js';

// Un adaptador parado por su dueño cuyo contenedor ya monta la release instalada no se actualiza ni se aplaza:
// el barrido lo reconoce como runtime_current y el mantenimiento se omite sin tocar el contenedor.
export async function assertStoppedCurrentRuntimeSkipped(): Promise<void> {
  expect(CANCEL_DEPLOY_OWNER).toBe(AUTO_SESSION_OWNER);
  const source = automaticSessionReleaseSource();
  const evidence: Record<string, unknown> = { task: 'h13c-e2e-mantenimiento-adaptador-parado-1025', run: cancelDeployRun,
    owner: AUTO_SESSION_OWNER, scenario: 'stopped-current-runtime', releaseBReference: source.reference,
    releaseBWorkingTree: source.workingTree };
  const failures: unknown[] = [];
  let fixture: CancelDeployFixture | undefined;
  let scans: ReturnType<typeof observeMaintenanceScans> | undefined;
  let actorForFailure: Awaited<ReturnType<typeof createCanary>>['actor'] | undefined;
  try {
    const runtime = await controlledSessionRuntime();
    fixture = await startCancelDeployFixture({ runtimeBundle: runtime, initialSharedTui: true });
    const image = await prepareSessionQuotaImage(fixture, 'stopped');
    const release = await buildSessionRelease(fixture, 'stopped-b', source.reference, source.workingTree,
      { runtime, image: image.id, imageReference: image.reference, stageDescriptors: stageSessionDescriptors });
    evidence.sourceB = release;
    evidence.setupB = await installSessionRelease(fixture, release);
    scans = observeMaintenanceScans(fixture, release.manifest.release.sha256);
    const canary = await createCanary(fixture, 'stopped');
    const actor = canary.actor;
    actorForFailure = actor;
    const stop = await openCancelDeployPanel(actor);
    await stop.getByLabel('¿Qué quieres hacer?').selectOption('stop');
    evidence.stopped = await enqueueCancelDeploy(actor, stop, 'stop');
    const stopped = await observeCancelDeployActor(actor);
    expect(stopped.adapterAlive).toBe(false);
    expect(stopped.normalProcesses).toBe(0);
    scans.afterStop();
    await expect.poll(() => scans?.counts.stopped, { timeout: 95_000 }).toBeGreaterThan(0);
    // El omitido por runtime_current es durable: una solicitud de mantenimiento de esta release cancelada por esa razón.
    await expect.poll(async () => (await automaticOperations(actor)).filter(row => row.events.some(event =>
      event.metadata.maintenance_skipped === 'runtime_current')).length, { timeout: 95_000 }).toBeGreaterThan(0);
    const operations = await automaticOperations(actor);
    evidence.operations = operations.map(row => ({ id: row.id.slice(0, 8), status: row.status, desired: row.desired_revision,
      skipped: row.events.map(event => event.metadata.maintenance_skipped).filter(Boolean) }));
    expect(operations.filter(row => !['cancelled', 'succeeded'].includes(row.status))).toEqual([]);
    expect(operations.filter(row => row.status === 'succeeded')).toEqual([]);
    const after = await observeCancelDeployActor(actor);
    expect(after.adapterAlive).toBe(false);
    expect(after.id).toBe(stopped.id);
    expect(after.volumes).toEqual(stopped.volumes);
    evidence.after = after;
    evidence.scans = { ...scans.counts };
    await cancelDeployCapture(fixture.page, 'auto-stopped-current');
    // Start manual posterior: la sesión nativa y el contexto siguen intactos.
    const start = await openCancelDeployPanel(actor);
    await start.getByLabel('¿Qué quieres hacer?').selectOption('start');
    evidence.started = await enqueueCancelDeploy(actor, start, 'start');
    const final = await observeAutomaticActor(actor);
    expect(final.actor.adapterAlive).toBe(true);
    expect(final.provider.contextSha256).toBe(canary.context.sha256);
    expect(final.provider.nativeSessionId).toBe(canary.native.witness.native_session_id);
    fixture.errors.assertClean();
  } catch (error) {
    failures.push(error);
    evidence.failure = error instanceof Error ? error.message : String(error);
    if (scans) evidence.scans = { ...scans.counts };
    if (fixture) await collectSessionFailure(fixture, actorForFailure, 'stopped').catch(() => undefined);
  } finally {
    scans?.close();
    if (fixture) {
      try { await fixture.close(); evidence.cleanup = { containers: '', volumes: '', images: '' }; }
      catch (error) { failures.push(error); evidence.cleanupError = error instanceof Error ? error.message : String(error); }
    }
    await sessionReceipt('auto-stopped-evidence', evidence);
  }
  if (failures.length) throw new AggregateError(failures, 'stopped current runtime maintenance control failed');
}
