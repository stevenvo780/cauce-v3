import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCancelDeployActor, enqueueCancelDeploy, openCancelDeployPanel, type CancelDeployActor } from './v4-fleet-cancel-deploy.flow.js';
import { CANCEL_DEPLOY_OWNER, cancelDeployCapture, cancelDeployReceipts, cancelDeployRun, startCancelDeployFixture,
  type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { bodySnippet } from './v4-console-real-browser.helpers.js';
import { assertNativeSessionTurn, collectSessionFailure, observeSessionExecutor, seedSessionContext, sessionReceipt } from './v4-sesion-tras-despliegue.observe.js';
import { buildSessionRelease, installSessionRelease, type SessionRelease } from './v4-sesion-tras-despliegue.release.js';
import { SESSION_AUTO_BASELINE, SESSION_RELEASE_A } from './v4-sesion-tras-despliegue.refs.js';
import { AUTO_SESSION_MODEL, AUTO_SESSION_OWNER, controlledSessionRuntime, prepareSessionQuotaImage,
  stageSessionDescriptors } from './v4-sesion-tras-despliegue.runtime.js';
import { assertSessionTurnOrdering, automaticOperations, deliveryState, finishSessionDelivery, observeAutomaticActor, observeAutomaticQuota, providerState,
  sendSessionDelivery, sessionControl, sessionKeys, type AutomaticOperation } from './v4-sesion-tras-despliegue.control.js';

type Observation = Awaited<ReturnType<typeof observeAutomaticActor>>;
interface Canary {
  actor: CancelDeployActor; before: Observation; knownOperations: Set<string>;
  context: Awaited<ReturnType<typeof seedSessionContext>>;
  native: Awaited<ReturnType<typeof assertNativeSessionTurn>>;
}

async function createCanary(fixture: CancelDeployFixture, suffix: string): Promise<Canary> {
  const { actor } = await createCancelDeployActor(fixture, suffix);
  const panel = await openCancelDeployPanel(actor);
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('update');
  await panel.getByLabel('Modelo operativo').fill(AUTO_SESSION_MODEL);
  await enqueueCancelDeploy(actor, panel, 'update');
  const context = await seedSessionContext(actor);
  const sent = await sendSessionDelivery(actor);
  const native = await assertNativeSessionTurn(actor, await finishSessionDelivery(actor, sent.marker));
  const before = await observeAutomaticActor(actor);
  expect(before.provider.nativeSessionId).toBe(native.witness.native_session_id);
  expect(before.provider.contextSha256).toBe(context.sha256);
  expect(before.provider.model).toBe(AUTO_SESSION_MODEL);
  expect(before.identity).toMatchObject({ primary_account_id: fixture.accountId, model_id: AUTO_SESSION_MODEL });
  expect(before.runtime.quarantine).toEqual([]);
  return { actor, before, context, native, knownOperations: new Set((await automaticOperations(actor)).map(row => row.id)) };
}

async function newOperations(canary: Canary): Promise<AutomaticOperation[]> {
  const rows = (await automaticOperations(canary.actor)).filter(row => !canary.knownOperations.has(row.id));
  for (const row of rows.filter(operation => operation.status === 'cancelled')) {
    expect(row.events.some(event => event.metadata.maintenance_skipped === 'revision_changed')).toBe(true);
    expect(row.desired_revision).toBeNull();
    expect(row.steps.every(step => step.status === 'pending')).toBe(true);
  }
  return rows.filter(row => row.status !== 'cancelled');
}

function assertAutomaticOrigin(operation: AutomaticOperation, fixture: CancelDeployFixture, release: SessionRelease): void {
  const subject = operation.actor_subject;
  expect(subject).toMatch(new RegExp('^host:' + fixture.hostId + ':[a-f0-9]{64}$', 'u'));
  const queued = operation.events.find(row => row.event === 'queued');
  expect(queued?.metadata.maintenance).toMatchObject({ host_id: fixture.hostId, release_sha256: release.manifest.release.sha256,
    key_fingerprint: subject?.slice(subject.lastIndexOf(':') + 1) });
  const origin = queued?.metadata.maintenance;
  if (typeof origin !== 'object' || !origin || !('enrollment_id' in origin) || !('parameters_sha256' in origin)) {
    throw new Error('the automatic operation lacks its measured maintenance origin');
  }
  expect(origin.enrollment_id).toBeTypeOf('string');
  expect(origin.parameters_sha256).toMatch(/^[a-f0-9]{64}$/u);
}

async function assertDeferred(canary: Canary, fixture: CancelDeployFixture, release: SessionRelease,
  reasons: readonly string[]): Promise<AutomaticOperation> {
  let operation: AutomaticOperation | undefined;
  await expect.poll(async () => {
    const rows = await newOperations(canary);
    expect(rows.length).toBeLessThanOrEqual(1);
    operation = rows[0];
    if (operation?.status === 'failed') throw new Error('the automatic update failed: ' + JSON.stringify(operation));
    return operation?.status === 'queued'
      && operation.events.some(row => row.event === 'renewed' && row.metadata.maintenance_deferred !== undefined);
  }, { timeout: 120_000, interval: 1_000 }).toBe(true);
  if (!operation) throw new Error('the deferred automatic operation disappeared');
  expect(operation.status).toBe('queued');
  expect(operation.desired_revision).toBeNull();
  expect(operation.applied_revision).toBeNull();
  expect(operation.events.some(row => row.event === 'step_completed' && row.metadata.step === 'prepare')).toBe(false);
  expect(operation.steps.every(row => row.status === 'pending')).toBe(true);
  const deferred = operation.events.find(row => row.event === 'renewed' && row.metadata.maintenance_deferred !== undefined);
  const delay = deferred?.metadata.maintenance_deferred;
  if (typeof delay !== 'object' || !delay || !('reason' in delay) || !('attempt' in delay) || !('retry_at' in delay)) {
    throw new Error('the automatic deferral lacks its durable retry receipt');
  }
  expect(reasons).toContain(delay.reason);
  expect(Number.isSafeInteger(delay.attempt)).toBe(true);
  expect(Number(delay.attempt)).toBeGreaterThanOrEqual(1);
  expect(delay.retry_at).toBeTypeOf('string');
  expect(Date.parse(String(delay.retry_at))).toBeGreaterThan(new Date(deferred.created_at).getTime());
  assertAutomaticOrigin(operation, fixture, release);
  return operation;
}

async function assertUpdated(canary: Canary, fixture: CancelDeployFixture, release: SessionRelease) {
  let operation: AutomaticOperation | undefined;
  await expect.poll(async () => {
    const rows = await newOperations(canary);
    expect(rows.length).toBeLessThanOrEqual(1);
    operation = rows[0];
    if (operation?.status === 'failed') throw new Error('the automatic update failed: ' + JSON.stringify(operation));
    return operation?.status;
  }, { timeout: 180_000, interval: 1_000 }).toBe('succeeded');
  if (!operation) throw new Error('the successful automatic operation disappeared');
  assertAutomaticOrigin(operation, fixture, release);
  expect(Number(operation.desired_revision)).toBeGreaterThan(Number(operation.expected_revision));
  expect(operation.applied_revision).toBe(operation.desired_revision);
  expect(operation.events.some(row => row.event === 'step_completed' && row.metadata.step === 'prepare')).toBe(true);
  expect(operation.events.some(row => row.event === 'succeeded')).toBe(true);
  expect(operation.steps.find(row => row.name === 'stop')?.status).toBe('succeeded');
  const observed = await observeAutomaticActor(canary.actor);
  const expectedRelease = join(fixture.computer.installRoot, fixture.company, fixture.hostId, 'release', release.manifest.release.sha256);
  expect(observed.actor.id).not.toBe(canary.before.actor.id);
  expect(observed.actor.release).toBe(expectedRelease);
  expect(observed.actor.bundleDigest).toBe(release.manifest.pins.adapter_digest);
  expect(observed.actor.volumes).toEqual(canary.before.actor.volumes);
  expect(observed.identity).toEqual(canary.before.identity);
  expect(observed.provider.nativeSessionId).toBe(canary.native.witness.native_session_id);
  expect(observed.provider.identitySha256).toBe(canary.before.provider.identitySha256);
  expect(observed.provider.model).toBe(AUTO_SESSION_MODEL);
  expect(observed.runtime.context[canary.context.path]).toBe(canary.context.sha256);
  expect(observed.runtime.quarantine).toEqual([]);
  return { operation, observed };
}

function assertUnchanged(before: Observation, after: Observation): void {
  expect(after.actor).toEqual(before.actor);
  expect(after.provider).toEqual(before.provider);
  expect(after.compositor).toBe(before.compositor);
  expect(after.runtime.metadata).toEqual(before.runtime.metadata);
  expect(after.runtime.sockets).toEqual(before.runtime.sockets);
  expect(after.runtime.tmux).toEqual(before.runtime.tmux);
  expect(after.identity).toEqual(before.identity);
  expect(after.runtime.quarantine).toEqual(before.runtime.quarantine);
}

describe('actualización automática de ejecuciones V4 tras una release', () => {
  it('actualiza reposo y aplaza borradores y turnos reales sin intervención de flota', async () => {
    expect(CANCEL_DEPLOY_OWNER).toBe(AUTO_SESSION_OWNER);
    const baseline = process.env.H13_AUTO_B_SOURCE === 'baseline';
    if (!baseline && process.env.H13_AUTO_B_SOURCE !== undefined) throw new Error('the automatic release source is unsupported');
    const evidence: Record<string, unknown> = { task: 'h13b-actualizacion-automatica-v4-1025', run: cancelDeployRun,
      owner: AUTO_SESSION_OWNER, baseline, releaseA: SESSION_RELEASE_A, releaseBReference: baseline ? SESSION_AUTO_BASELINE : 'HEAD' };
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
      const releaseB = await buildSessionRelease(fixture, 'auto-b', baseline ? SESSION_AUTO_BASELINE : 'HEAD', !baseline, overlay);
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
      evidence.turnDeferred = await assertDeferred(turn, fixture, releaseB, ['pending_deliveries', 'turn_active']);
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
});
