import { expect } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { cancelOperations, type CancelOperation } from './v4-fleet-cancel.helpers.js';
import { controlCancelDeployFromBrowser, createCancelDeployActor, enqueueCancelDeploy, observeCancelDeployActor,
  openCancelDeployPanel, waitCancelDeployOperation, type CancelDeployActor } from './v4-fleet-cancel-deploy.flow.js';
import { cancelDeployCapture, type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { materializeDisabledCancelDeploy, observeAdmittedCancelDeploy } from './v4-fleet-cancel-deploy.materialize.js';
import { deployCancelRelease } from './v4-fleet-cancel-deploy.release.js';

async function stopIdentity(actor: CancelDeployActor, id: string): Promise<unknown> {
  const rows = (await actor.fixture.computer.pool.query(`SELECT id,kind,request_hash,executor_host,expected_revision,company_id
    FROM fleet_operations WHERE id=$1`, [id])).rows;
  expect(rows).toHaveLength(1);
  return rows[0];
}

export async function runStopDeployScenario(fixture: CancelDeployFixture, evidence: Record<string, unknown>,
  assertLive: (actor: CancelDeployActor, phase: string) => Promise<void>): Promise<void> {
  const { actor, operation, observed: before } = await createCancelDeployActor(fixture, 's');
  evidence.created = operation; evidence.before = before;
  expect(before.adapterAlive).toBe(true); expect(before.credentialGeneration).not.toBeNull();
  await assertLive(actor, 'stop-initial');
  const panel = await openCancelDeployPanel(actor);
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('stop');
  await docker(['pause', actor.container]);
  let failed: CancelOperation;
  try { failed = await enqueueCancelDeploy(actor, panel, 'stop', ['failed']); }
  finally { await docker(['unpause', actor.container]); }
  expect(failed.steps.find(step => step.name === 'stop')?.status).toBe('failed');
  evidence.failed = failed;
  const identity = await stopIdentity(actor, failed.id);
  evidence.identityBefore = identity;
  await cancelDeployCapture(fixture.page, 'stop-failed-before-deployment');
  evidence.materializedDisabled = await materializeDisabledCancelDeploy(fixture.computer, fixture.tenantId, actor.alias,
    actor.runtime, before.release);
  const deployment = await deployCancelRelease(fixture, fixture.setup, 'stop-deployment', { image: before.image, newImage: true });
  evidence.deployment = deployment;
  expect(deployment.signer).toBe(fixture.setup.signerFingerprint);
  expect(deployment.image).not.toBe(before.image); expect(deployment.bundleDigest).not.toBe(before.bundleDigest);
  const afterDeployment = await observeCancelDeployActor(actor);
  evidence.afterDeployment = afterDeployment;
  expect(afterDeployment.id).toBe(before.id); expect(afterDeployment.image).toBe(before.image);
  expect(afterDeployment.release).toBe(before.release); expect(afterDeployment.volumes).toEqual(before.volumes);
  expect(afterDeployment.credentialGeneration).toBe(before.credentialGeneration);
  evidence.retryHttp = await controlCancelDeployFromBrowser(actor, failed, 'resume');
  expect(evidence.retryHttp).toMatchObject({ status: 200, response: { id: failed.id, status: 'queued' } });
  const stopped = await waitCancelDeployOperation(actor, 'stop', ['succeeded']);
  evidence.stopped = stopped;
  expect(stopped.id).toBe(failed.id); expect(stopped.version).toBeGreaterThan(failed.version);
  expect(stopped.steps.find(step => step.name === 'stop')?.evidence).toMatchObject({ stopped_verified: true });
  const after = await observeCancelDeployActor(actor);
  evidence.afterStop = after; evidence.identityAfter = await stopIdentity(actor, stopped.id);
  expect(evidence.identityAfter).toEqual(identity);
  expect((await cancelOperations(fixture, actor.alias)).filter(row => row.kind === 'stop').map(row => row.id)).toEqual([failed.id]);
  expect(after.running).toBe(true); expect(after.adapterAlive).toBe(false); expect(after.normalProcesses).toBe(0);
  expect(after.id).toBe(before.id); expect(after.image).toBe(before.image); expect(after.release).toBe(before.release);
  expect(after.volumes).toEqual(before.volumes); expect(after.credentialGeneration).toBe(before.credentialGeneration);
  await cancelDeployCapture(fixture.page, 'stop-retried-same-operation');
  const start = await openCancelDeployPanel(actor);
  await start.getByLabel('¿Qué quieres hacer?').selectOption('start');
  evidence.started = await enqueueCancelDeploy(actor, start, 'start');
  const current = await observeCancelDeployActor(actor);
  evidence.afterStart = current;
  expect(current.id).not.toBe(before.id); expect(current.image).toBe(deployment.image);
  expect(current.release).toBe(deployment.release); expect(current.bundleDigest).toBe(deployment.bundleDigest);
  expect(current.volumes).toEqual(before.volumes); expect(current.adapterAlive).toBe(true);
  evidence.materializedAdmitted = await observeAdmittedCancelDeploy(fixture.computer, deployment.release, actor.runtime);
  await assertLive(actor, 'stop-started-current-deployment');
}
