import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertCancelDeployLive } from './v4-fleet-cancel-deploy.delivery.js';
import { createCancelDeployActor, type CancelDeployActor } from './v4-fleet-cancel-deploy.flow.js';
import { CANCEL_DEPLOY_OWNER, cancelDeployCapture, cancelDeployReceipts, cancelDeployRun, startCancelDeployFixture,
  type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { cancelDeployTuiRuntime } from './v4-fleet-cancel-deploy.tui.js';
import { apiGet, bodySnippet } from './v4-console-real-browser.helpers.js';
import { buildSessionRelease, installSessionRelease } from './v4-sesion-tras-despliegue.release.js';
import { assertNativeSessionTurn, collectSessionFailure, observeDeploymentSession, observeSessionExecutor,
  seedSessionContext, sessionReceipt } from './v4-sesion-tras-despliegue.observe.js';
import { SESSION_BASELINE, SESSION_RELEASE_A } from './v4-sesion-tras-despliegue.refs.js';

describe('TUI compartida después de recibir una release nueva', () => {
  it('contesta el primer turno posterior al setup y conserva su estado sin intervención', async () => {
    expect(CANCEL_DEPLOY_OWNER).toBe('h13-sesion-1025');
    if (!/^[a-f0-9]{40}$/u.test(SESSION_RELEASE_A)) throw new Error('release A still requires its measured historical Git commit');
    const baseline = process.env.H13_RELEASE_B_SOURCE === 'baseline';
    if (!baseline && process.env.H13_RELEASE_B_SOURCE !== undefined) throw new Error('the requested release B source is unsupported');
    await mkdir(cancelDeployReceipts, { recursive: true, mode: 0o700 });
    const evidence: Record<string, unknown> = { run: cancelDeployRun, task: 'h13-sesion-tras-despliegue-1025', releaseA: SESSION_RELEASE_A,
      releaseBSource: baseline ? 'baseline' : 'isolated-candidate-working-tree', owner: CANCEL_DEPLOY_OWNER };
    const failures: unknown[] = [];
    let fixture: CancelDeployFixture | undefined;
    let actor: CancelDeployActor | undefined;
    try {
      fixture = await startCancelDeployFixture({ runtimeBundle: cancelDeployTuiRuntime, initialSharedTui: true });
      const releaseA = await buildSessionRelease(fixture, 'a', SESSION_RELEASE_A);
      evidence.setupA = await installSessionRelease(fixture, releaseA);
      console.info('H13_PHASE', 'release-a-installed');
      evidence.sourceA = { revision: releaseA.revision, manifest: releaseA.manifest, source: releaseA.source };
      const created = await createCancelDeployActor(fixture, 'h13');
      actor = created.actor;
      console.info('H13_PHASE', 'agent-a-created');
      evidence.create = created.operation;
      const context = await seedSessionContext(actor);
      evidence.workspaceContext = { ...context, proof: 'workspace file preservation; semantic provider memory is not asserted' };
      const liveA: Record<string, unknown> = {};
      evidence.turnA = liveA;
      await assertCancelDeployLive(actor, 'release-a', liveA);
      const nativeA = await assertNativeSessionTurn(actor, liveA);
      liveA.native = nativeA;
      console.info('H13_PHASE', 'turn-a-done');
      const before = await observeDeploymentSession(actor);
      evidence.before = before;
      const expectedA = join(fixture.computer.installRoot, fixture.company, fixture.hostId, 'release', releaseA.manifest.release.sha256);
      expect(before.actor.release).toBe(expectedA);
      expect(before.actor.bundleDigest).toBe(releaseA.manifest.pins.adapter_digest);
      expect(before.runtime.environment.CAUCE_SHARED_SESSION).toBe('1');
      expect(before.runtime.environment.TMUX_TMPDIR).toBe('/home/cauce/.cauce/' + actor.runtime);
      expect(before.runtime.tmux.code, JSON.stringify(before.runtime.tmux)).toBe(0);
      expect(before.runtime.quarantine).toEqual([]);
      expect(Object.keys(before.runtime.transcripts).length).toBeGreaterThan(0);
      expect(Object.keys(before.runtime.context).length).toBeGreaterThan(0);
      expect(before.runtime.context[context.path]).toBe(context.sha256);
      const releaseB = await buildSessionRelease(fixture, 'b', SESSION_BASELINE, !baseline);
      evidence.sourceB = { revision: releaseB.revision, manifest: releaseB.manifest, source: releaseB.source };
      expect(releaseB.manifest.release.sha256).not.toBe(releaseA.manifest.release.sha256);
      const executorBefore = await observeSessionExecutor(fixture);
      evidence.executorBefore = executorBefore;
      evidence.setupB = await installSessionRelease(fixture, releaseB);
      console.info('H13_PHASE', 'release-b-installed');
      const executorAfter = await observeSessionExecutor(fixture);
      evidence.executorAfter = executorAfter;
      expect(executorAfter.activeState).toBe('active');
      expect(executorAfter.invocationId).not.toBe('');
      expect(executorAfter.invocationId).not.toBe(executorBefore.invocationId);
      expect(executorAfter.starttime).not.toBe(executorBefore.starttime);
      expect(executorAfter.execStart).toContain('/release/' + releaseB.manifest.release.sha256 + '/');
      evidence.afterSetup = await observeDeploymentSession(actor);
      const liveB: Record<string, unknown> = {};
      evidence.firstTurnB = liveB;
      await assertCancelDeployLive(actor, 'release-b-first', liveB);
      const nativeB = await assertNativeSessionTurn(actor, liveB);
      liveB.native = nativeB;
      expect(nativeB.witness.native_session_id).toBe(nativeA.witness.native_session_id);
      expect(nativeB.witness.native_turn_id).not.toBe(nativeA.witness.native_turn_id);
      console.info('H13_PHASE', 'turn-b-done');
      const after = await observeDeploymentSession(actor);
      evidence.after = after;
      expect(after.actor.volumes).toEqual(before.actor.volumes);
      expect(after.runtime.quarantine).toEqual([]);
      expect(after.runtime.environment.CAUCE_SHARED_SESSION).toBe('1');
      expect(after.runtime.tmux.code, JSON.stringify(after.runtime.tmux)).toBe(0);
      for (const filename of Object.keys(before.runtime.transcripts)) expect(Object.keys(after.runtime.transcripts)).toContain(filename);
      for (const [filename, hash] of Object.entries(before.runtime.context)) expect(after.runtime.context[filename]).toBe(hash);
      const second: Record<string, unknown> = {};
      evidence.secondTurnB = second;
      await assertCancelDeployLive(actor, 'release-b-second', second);
      const nativeSecond = await assertNativeSessionTurn(actor, second);
      second.native = nativeSecond;
      expect(nativeSecond.witness.native_session_id).toBe(nativeA.witness.native_session_id);
      expect(new Set([nativeA, nativeB, nativeSecond].map(turn => turn.witness.native_turn_id)).size).toBe(3);
      evidence.final = await observeDeploymentSession(actor);
      expect((await observeDeploymentSession(actor)).runtime.quarantine).toEqual([]);
      evidence.recoveryReadOnly = await apiGet(fixture.page, '/v3/console/tenants/' + encodeURIComponent(fixture.tenantId)
        + '/agents/' + encodeURIComponent(actor.alias) + '/recovery').catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
      fixture.errors.assertClean();
    } catch (error) {
      failures.push(error);
      evidence.failure = error instanceof Error ? error.message : String(error);
      if (fixture) {
        evidence.page = await bodySnippet(fixture.page).catch(() => 'the owned page could not be observed');
        if (actor) evidence.failedSession = await observeDeploymentSession(actor).catch((probeError: unknown) => ({
          error: probeError instanceof Error ? probeError.message : String(probeError),
        }));
        try { await cancelDeployCapture(fixture.page, 'failure'); }
        catch (captureError) { evidence.captureError = captureError instanceof Error ? captureError.message : String(captureError); }
      }
    }
    if (fixture) {
      try { await collectSessionFailure(fixture, actor); }
      catch (error) { failures.push(error); evidence.diagnosticError = error instanceof Error ? error.message : String(error); }
      try { await fixture.close(); evidence.cleanup = { containers: '', volumes: '', images: '' }; }
      catch (error) { failures.push(error); evidence.cleanupError = error instanceof Error ? error.message : String(error); }
    }
    await sessionReceipt('evidence', evidence);
    console.info('H13_EVIDENCE', cancelDeployReceipts, baseline ? 'baseline' : 'candidate', failures.length === 0 ? 'green' : 'red');
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'shared TUI deployment continuity failed');
  }, 1_200_000);
});
