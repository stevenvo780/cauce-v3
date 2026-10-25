import { expect } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { enqueueCancelDeploy, observeCancelDeployActor, openCancelDeployPanel } from './v4-fleet-cancel-deploy.flow.js';
import { CANCEL_DEPLOY_OWNER, cancelDeployCapture, cancelDeployRun, startCancelDeployFixture,
  type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { collectSessionFailure, sessionReceipt } from './v4-sesion-tras-despliegue.observe.js';
import { automaticOperations } from './v4-sesion-tras-despliegue.control.js';
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
    const skips = async () => (await automaticOperations(actor)).filter(row => row.events.some(event =>
      event.metadata.maintenance_skipped === 'runtime_current'));
    // Con el adaptador vivo y la release montada, el primer barrido de B ya es runtime_current.
    scans.afterStart();
    await expect.poll(async () => (await skips()).length, { timeout: 95_000 }).toBeGreaterThan(0);
    // Una acción del dueño rompe la satisfacción previa del mantenimiento, para que el barrido solicite otra.
    for (const action of ['stop', 'start']) {
      const panel = await openCancelDeployPanel(actor);
      await panel.getByLabel('¿Qué quieres hacer?').selectOption(action);
      evidence[action] = await enqueueCancelDeploy(actor, panel, action);
    }
    const running = await observeCancelDeployActor(actor);
    expect(running.adapterAlive).toBe(true);
    // El contenedor corre sin CAP_KILL: se para el contenedor entero, que es como queda un adaptador parado fuera de flota.
    const inspect = async () => JSON.parse(await docker(['inspect', '--format', '{{json .}}', actor.container])) as {
      Id: string; State: { Running: boolean }; Mounts: { Type: string; Source: string; Name?: string }[] };
    const mounts = (row: Awaited<ReturnType<typeof inspect>>) => row.Mounts.map(mount => mount.Type + ':' + (mount.Name ?? mount.Source)).sort();
    const before = await inspect();
    await docker(['kill', actor.container]);
    const stopped = await inspect();
    expect(stopped.State.Running).toBe(false);
    expect(stopped.Id).toBe(before.Id);
    expect(mounts(stopped)).toEqual(mounts(before));
    // Todo lo solicitado hasta aquí se hizo con el adaptador vivo; solo cuenta lo que llegue con el contenedor parado.
    const known = new Set((await automaticOperations(actor)).map(row => row.id));
    scans.afterStop();
    await expect.poll(async () => (await skips()).filter(row => !known.has(row.id)).length, { timeout: 95_000 }).toBeGreaterThan(0);
    const operations = await automaticOperations(actor);
    evidence.operations = operations.map(row => ({ id: row.id.slice(0, 8), status: row.status, desired: row.desired_revision,
      skipped: row.events.map(event => event.metadata.maintenance_skipped).filter(Boolean) }));
    expect(operations.filter(row => !known.has(row.id) && !['cancelled'].includes(row.status))).toEqual([]);
    const after = await inspect();
    expect(after.State.Running).toBe(false);
    expect(after.Id).toBe(stopped.Id);
    expect(mounts(after)).toEqual(mounts(stopped));
    evidence.after = { id: after.Id.slice(0, 12), running: after.State.Running, mounts: mounts(after).length };
    evidence.scans = { ...scans.counts };
    await cancelDeployCapture(fixture.page, 'auto-stopped-current');
    fixture.errors.assertClean();
  } catch (error) {
    failures.push(error);
    evidence.failure = error instanceof Error ? error.message : String(error);
    if (scans) evidence.scans = { ...scans.counts };
    if (actorForFailure) evidence.operationsAtFailure = (await automaticOperations(actorForFailure).catch(() => [])).map(row => ({
      id: row.id.slice(0, 8), status: row.status, desired: row.desired_revision, steps: row.steps.map(step => step.name + ':' + step.status),
      events: row.events.map(event => event.event + ':' + JSON.stringify(event.metadata).slice(0, 200)) }));
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
