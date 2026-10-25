import { expect } from 'vitest';
import { CANCEL_DEPLOY_OWNER, cancelDeployCapture, cancelDeployRun, startCancelDeployFixture,
  type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { assertDeferred, assertUnchanged, assertUpdated, createCanary, type UnseededCanary } from './v4-sesion-tras-despliegue.assertions.js';
import { assertNativeSessionTurn, collectSessionFailure, sessionReceipt } from './v4-sesion-tras-despliegue.observe.js';
import { automaticOperations, finishSessionDelivery, observeAutomaticActor, observeAutomaticQuota, sendSessionDelivery,
  sessionPointerState } from './v4-sesion-tras-despliegue.control.js';
import { buildSessionRelease, installSessionRelease } from './v4-sesion-tras-despliegue.release.js';
import { automaticSessionReleaseSource, SESSION_RELEASE_A } from './v4-sesion-tras-despliegue.refs.js';
import { AUTO_SESSION_OWNER, controlledSessionRuntime, prepareSessionQuotaImage, stageSessionDescriptors } from './v4-sesion-tras-despliegue.runtime.js';

export async function assertUninitializedSessionDeferred(): Promise<void> {
  expect(CANCEL_DEPLOY_OWNER).toBe(AUTO_SESSION_OWNER);
  const source = automaticSessionReleaseSource();
  const evidence: Record<string, unknown> = { task: 'h13b-actualizacion-automatica-v4-1025', run: cancelDeployRun,
    scenario: 'uninitialized-pointer', owner: AUTO_SESSION_OWNER,
    releaseBReference: source.reference, releaseBWorkingTree: source.workingTree };
  const failures: unknown[] = [];
  let fixture: CancelDeployFixture | undefined;
  let unseeded: UnseededCanary | undefined;
  try {
    const runtime = await controlledSessionRuntime();
    fixture = await startCancelDeployFixture({ runtimeBundle: runtime, initialSharedTui: true });
    const image = await prepareSessionQuotaImage(fixture, 'security');
    const overlay = { runtime, image: image.id, imageReference: image.reference, stageDescriptors: stageSessionDescriptors };
    const releaseA = await buildSessionRelease(fixture, 'security-a', SESSION_RELEASE_A, false, overlay);
    evidence.setupA = await installSessionRelease(fixture, releaseA);
    evidence.sourceA = releaseA;
    unseeded = await createCanary(fixture, 'unseeded', false);
    const pointer = await sessionPointerState(unseeded.actor);
    expect(pointer).toEqual({ exists: false, initialized: false, nativeId: null });
    evidence.initial = { before: unseeded.before, context: unseeded.context, pointer };
    const releaseB = await buildSessionRelease(fixture, 'security-b', source.reference, source.workingTree, overlay);
    evidence.sourceB = releaseB;
    expect(releaseB.source.fixture).toEqual(releaseA.source.fixture);
    evidence.setupB = await installSessionRelease(fixture, releaseB);
    evidence.deferred = await assertDeferred(unseeded, fixture, releaseB, ['preflight_unavailable']);
    assertUnchanged(unseeded.before, await observeAutomaticActor(unseeded.actor));
    expect(await sessionPointerState(unseeded.actor)).toEqual(pointer);
    await cancelDeployCapture(fixture.page, 'auto-pointer-absent');
    const initialized = await finishSessionDelivery(unseeded.actor, (await sendSessionDelivery(unseeded.actor)).marker);
    const native = await assertNativeSessionTurn(unseeded.actor, initialized);
    expect(native.witness.native_session_id).toBe(unseeded.before.provider.nativeSessionId);
    expect(await sessionPointerState(unseeded.actor)).toEqual({ exists: true, initialized: true,
      nativeId: native.witness.native_session_id });
    evidence.initialized = { initialized, native };
    evidence.updated = await assertUpdated({ ...unseeded, native }, fixture, releaseB);
    const sent = await sendSessionDelivery(unseeded.actor);
    const live = await finishSessionDelivery(unseeded.actor, sent.marker);
    const finalNative = await assertNativeSessionTurn(unseeded.actor, live);
    expect(finalNative.witness.native_session_id).toBe(native.witness.native_session_id);
    expect(finalNative.witness.native_turn_id).not.toBe(native.witness.native_turn_id);
    const final = await observeAutomaticActor(unseeded.actor);
    expect(final.provider.contextSha256).toBe(unseeded.context.sha256);
    evidence.final = { live, native: finalNative, observed: final, quota: await observeAutomaticQuota(unseeded.actor) };
    await cancelDeployCapture(fixture.page, 'auto-pointer-initialized-quota');
    fixture.errors.assertClean();
  } catch (error) {
    failures.push(error);
    evidence.failure = error instanceof Error ? error.message : String(error);
    if (fixture) {
      if (unseeded) evidence.operationsAtFailure = await automaticOperations(unseeded.actor).catch(() => []);
      await cancelDeployCapture(fixture.page, 'auto-pointer-failure').catch(() => undefined);
    }
  } finally {
    if (fixture) {
      try { await collectSessionFailure(fixture, unseeded?.actor, 'security'); }
      catch (error) { failures.push(error); }
      try { await fixture.close(); evidence.cleanup = { containers: '', volumes: '', images: '' }; }
      catch (error) { failures.push(error); evidence.cleanupError = error instanceof Error ? error.message : String(error); }
    }
    await sessionReceipt('auto-pointer-evidence', evidence);
  }
  if (failures.length) throw new AggregateError(failures, 'uninitialized shared session update safety failed');
}
