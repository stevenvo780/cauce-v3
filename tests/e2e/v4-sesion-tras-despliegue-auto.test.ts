import { mkdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CANCEL_DEPLOY_OWNER, cancelDeployCapture, cancelDeployReceipts, cancelDeployRun, startCancelDeployFixture,
  type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { bodySnippet } from './v4-console-real-browser.helpers.js';
import { assertNativeSessionTurn, collectSessionFailure, observeSessionExecutor, sessionReceipt } from './v4-sesion-tras-despliegue.observe.js';
import { buildSessionRelease, installSessionRelease } from './v4-sesion-tras-despliegue.release.js';
import { automaticSessionReleaseSource, SESSION_RELEASE_A } from './v4-sesion-tras-despliegue.refs.js';
import { AUTO_SESSION_OWNER, controlledSessionRuntime, prepareSessionQuotaImage,
  stageSessionDescriptors } from './v4-sesion-tras-despliegue.runtime.js';
import { assertSessionTurnOrdering, automaticOperations, deliveryState, finishSessionDelivery, observeAutomaticActor, observeAutomaticQuota, providerState,
  sendSessionDelivery, sessionControl, sessionKeys } from './v4-sesion-tras-despliegue.control.js';

import { assertDeferred, assertUnchanged, assertUpdated, createCanary, type Canary } from './v4-sesion-tras-despliegue.assertions.js';
import { assertUninitializedSessionDeferred } from './v4-sesion-tras-despliegue.security.js';
import { assertNullModelOwnerControl } from './v4-sesion-tras-despliegue.model-null.js';

describe('actualización automática de ejecuciones V4 tras una release', () => {
  it('aplaza antes de prepare una TUI sin conversación acreditada y la actualiza tras inicializarla',
    assertUninitializedSessionDeferred, 1_200_000);

  it('actualiza reposo y aplaza borradores y turnos reales sin intervención de flota', async () => {
    expect(CANCEL_DEPLOY_OWNER).toBe(AUTO_SESSION_OWNER);
    const source = automaticSessionReleaseSource(), baseline = source.baseline;
    const evidence: Record<string, unknown> = { task: 'h13b-actualizacion-automatica-v4-1025', run: cancelDeployRun,
      owner: AUTO_SESSION_OWNER, baseline, releaseA: SESSION_RELEASE_A,
      releaseBReference: source.reference, releaseBWorkingTree: source.workingTree };
    const canaries: Canary[] = [];
    const failures: unknown[] = [];
    let fixture: CancelDeployFixture | undefined;
    try {
      await mkdir(cancelDeployReceipts, { recursive: true, mode: 0o700 });
      const runtime = await controlledSessionRuntime();
      fixture = await startCancelDeployFixture({ runtimeBundle: runtime, initialSharedTui: true });
      const image = await prepareSessionQuotaImage(fixture);
      const overlay = { runtime, image: image.id, imageReference: image.reference, stageDescriptors: stageSessionDescriptors };
      const releaseA = await buildSessionRelease(fixture, 'auto-a', SESSION_RELEASE_A, false, overlay);
      evidence.setupA = await installSessionRelease(fixture, releaseA);
      evidence.sourceA = releaseA;
      for (const suffix of ['idle', 'draft', 'turn']) canaries.push(await createCanary(fixture, suffix));
      const idle = canaries[0], draft = canaries[1], turn = canaries[2];
      if (!idle || !draft || !turn) throw new Error('the three owned canaries are required');
      evidence.initial = canaries.map(row => ({ actor: row.actor.alias, before: row.before, context: row.context, native: row.native }));
      const releaseB = await buildSessionRelease(fixture, 'auto-b', source.reference, source.workingTree, overlay);
      evidence.sourceB = releaseB;
      expect(releaseB.source.fixture).toEqual(releaseA.source.fixture);
      await sessionKeys(draft.actor, ['H13B_OWNED_UNSENT_DRAFT'], true);
      await expect.poll(async () => (await providerState(draft.actor)).draftLength, { timeout: 20_000 }).toBe(23);
      const heldDraft = await observeAutomaticActor(draft.actor);
      expect(heldDraft.compositor).toContain('H13B_OWNED_UNSENT_DRAFT');
      await sessionControl(turn.actor, 'hold-next-turn');
      const heldDelivery = await sendSessionDelivery(turn.actor);
      await expect.poll(async () => (await deliveryState(turn.actor, heldDelivery.marker))[0]?.status, { timeout: 30_000 }).toBe('started');
      await expect.poll(async () => (await providerState(turn.actor)).turnId, { timeout: 20_000 }).toMatch(/^[a-f0-9-]{36}$/u);
      const heldTurn = await observeAutomaticActor(turn.actor);
      expect(heldTurn.compositor).toContain('esc to interrupt');
      evidence.heldBeforeB = { draft: heldDraft, turn: heldTurn, delivery: heldDelivery };
      evidence.executorBefore = await observeSessionExecutor(fixture);
      evidence.setupB = await installSessionRelease(fixture, releaseB);
      const executor = await observeSessionExecutor(fixture);
      evidence.executorAfter = executor;
      expect(executor.execStart).toContain('/release/' + releaseB.manifest.release.sha256 + '/');
      expect(executor.invocationId).not.toBe((evidence.executorBefore as Awaited<ReturnType<typeof observeSessionExecutor>>).invocationId);
      console.info('H13B_PHASE', 'release-b-installed');
      evidence.draftDeferred = await assertDeferred(draft, fixture, releaseB, ['composer_busy', 'tui_unreadable']);
      evidence.turnDeferred = await assertDeferred(turn, fixture, releaseB, ['pending_deliveries', 'turn_active', 'tui_unreadable']);
      assertUnchanged(heldDraft, await observeAutomaticActor(draft.actor));
      assertUnchanged(heldTurn, await observeAutomaticActor(turn.actor));
      evidence.idleUpdated = await assertUpdated(idle, fixture, releaseB);
      assertUnchanged(heldDraft, await observeAutomaticActor(draft.actor));
      assertUnchanged(heldTurn, await observeAutomaticActor(turn.actor));
      await cancelDeployCapture(fixture.page, 'auto-held-draft-turn');
      await sessionKeys(draft.actor, ['C-u']);
      await expect.poll(async () => (await providerState(draft.actor)).draftLength, { timeout: 20_000 }).toBe(0);
      evidence.draftUpdated = await assertUpdated(draft, fixture, releaseB);
      assertUnchanged(heldTurn, await observeAutomaticActor(turn.actor));
      if (!heldTurn.provider.turnId) throw new Error('the held native turn is absent');
      await sessionControl(turn.actor, 'release-' + heldTurn.provider.turnId);
      const finished = await finishSessionDelivery(turn.actor, heldDelivery.marker);
      evidence.heldTurnFinished = { ...finished, native: await assertNativeSessionTurn(turn.actor, finished) };
      const turnUpdated = await assertUpdated(turn, fixture, releaseB);
      evidence.turnUpdated = turnUpdated;
      evidence.turnOrdering = await assertSessionTurnOrdering(turn.actor, heldDelivery.marker, turnUpdated.operation);
      for (const canary of canaries) {
        const sent = await sendSessionDelivery(canary.actor);
        const live = await finishSessionDelivery(canary.actor, sent.marker);
        const native = await assertNativeSessionTurn(canary.actor, live);
        expect(native.witness.native_session_id).toBe(canary.native.witness.native_session_id);
        expect(native.witness.native_turn_id).not.toBe(canary.native.witness.native_turn_id);
        const final = await observeAutomaticActor(canary.actor);
        expect(final.provider.contextSha256).toBe(canary.context.sha256);
        evidence[canary.actor.alias] = { live, native, final, quota: await observeAutomaticQuota(canary.actor) };
        await cancelDeployCapture(fixture.page, 'auto-quota-' + canary.actor.alias);
      }
      fixture.errors.assertClean();
    } catch (error) {
      failures.push(error);
      evidence.failure = error instanceof Error ? error.message : String(error);
      if (fixture) {
        evidence.page = await bodySnippet(fixture.page).catch(() => 'the owned page is unavailable');
        evidence.operationsAtFailure = await Promise.all(canaries.map(async row => ({ alias: row.actor.alias,
          operations: await automaticOperations(row.actor).catch(() => []) })));
        await cancelDeployCapture(fixture.page, 'auto-failure').catch(() => undefined);
      }
    } finally {
      if (fixture) {
        for (const canary of canaries) {
          try { await collectSessionFailure(fixture, canary.actor, canary.actor.alias); }
          catch (error) { failures.push(error); }
        }
        try { await fixture.close(); evidence.cleanup = { containers: '', volumes: '', images: '' }; }
        catch (error) { failures.push(error); evidence.cleanupError = error instanceof Error ? error.message : String(error); }
      }
      await sessionReceipt('auto-evidence', evidence);
    }
    console.info('H13B_EVIDENCE', cancelDeployReceipts, baseline ? 'baseline' : 'candidate', failures.length === 0 ? 'green' : 'red');
    if (failures.length) throw new AggregateError(failures, 'automatic shared session release reconciliation failed');
  }, 1_800_000);
  it('permite Detener y Arrancar sin cancelar mantenimiento con modelo vacío', assertNullModelOwnerControl, 1_200_000);
});
