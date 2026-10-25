import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { sharedWindowFixture, until, type Actor, type Identity, type Observation, type SharedWindowFixture } from './s2d-ws-humanizar.fixture.js';

function sameProcess(before: Identity, after: Identity) {
  expect(after.pid).toBe(before.pid); expect(after.ticks).toBe(before.ticks);
}
function sameSharedProcesses(before: Observation, after: Observation, peer: Actor) {
  sameProcess(before.server, after.server);
  const oldPeer = before.actors[peer.alias], newPeer = after.actors[peer.alias]; assert.ok(oldPeer && newPeer);
  sameProcess(oldPeer.adapter, newPeer.adapter); sameProcess(oldPeer.controller, newPeer.controller);
  const oldPane = before.panes[peer.alias], newPane = after.panes[peer.alias]; assert.ok(oldPane && newPane);
  expect(newPane.session).toBe(oldPane.session); expect(newPane.pane).toBe(oldPane.pane);
  sameProcess(oldPane.process, newPane.process);
  assert.ok(before.job && after.job); sameProcess(before.job, after.job);
}
async function holdDraft(fixture: SharedWindowFixture, actor: Actor, peer: Actor, phase: string) {
  await fixture.keys(actor, ['S2D_OWNED_UNSENT_DRAFT'], true);
  await until(async () => (await fixture.provider(actor)).draftLength > 0 ? true : undefined);
  const before = await fixture.snapshot(), pane = await fixture.pane(actor), input = await fixture.provider(actor);
  const attempt = phase === 'current' ? { result: await fixture.directStop(actor), receipt: null } : await fixture.apply(actor, phase);
  const affected = { server: before.server, job: before.job, self: before.actors[actor.alias]?.adapter,
    peer: before.actors[peer.alias]?.adapter, self_tui: before.panes[actor.alias]?.process, peer_tui: before.panes[peer.alias]?.process };
  const survived = Object.fromEntries(await Promise.all(Object.entries(affected).map(async ([name, process]): Promise<[string, unknown]> =>
    [name, process ? { pid: process.pid, ticks: process.ticks, survived: !await fixture.gone(process) } : null])));
  await fixture.save('hold-attempt-' + actor.harness + '-' + phase, { alias: actor.alias, exit_code: attempt.result.code, survived,
    canonical_hold_reported: /(?:RESTART|SPACE)_[A-Z_]*HOLD[A-Z_]*/u.test(attempt.result.stderr + attempt.result.stdout) });
  expect(attempt.result.code).not.toBe(0);
  expect(/(?:RESTART|SPACE)_[A-Z_]*HOLD[A-Z_]*/u.test(attempt.result.stderr + attempt.result.stdout), 'canonical restart must report HOLD').toBe(true);
  const after = await fixture.snapshot(), provider = await fixture.provider(actor);
  const oldSelf = before.actors[actor.alias], newSelf = after.actors[actor.alias]; assert.ok(oldSelf && newSelf);
  sameProcess(oldSelf.adapter, newSelf.adapter); sameProcess(oldSelf.controller, newSelf.controller);
  sameSharedProcesses(before, after, peer);
  expect(await fixture.pane(actor) === pane, 'unsent compositor content changed during HOLD').toBe(true);
  expect(provider).toEqual(input);
  await fixture.save('hold-' + actor.harness + '-' + phase, { alias: actor.alias, before, after,
    mechanism: phase === 'current' ? 'supervisor stop' : 'window', restart_held: true, process_unchanged: true,
    compositor_unchanged: true, input_bytes_unchanged: true, provider });
  await fixture.keys(actor, ['C-u']);
  await until(async () => (await fixture.provider(actor)).draftLength === 0 ? true : undefined);
}

test('the canonical window bridges both legacy shared adapters without touching peers or orphan jobs and holds unsent input', async () => {
  const fixture = await sharedWindowFixture();
  try {
    const [first, second] = fixture.actors; assert.ok(first && second);
    await fixture.start(first); await fixture.start(second);
    await fixture.keys(first, ['S2D_LAUNCH_OWNED_FOREIGN_JOB'], true); await fixture.keys(first, ['Enter']);
    const baseline = await until(async () => { const observed = await fixture.snapshot(); return observed.job ? observed : undefined; });
    const firstState = baseline.actors[first.alias]; assert.ok(firstState && baseline.job);
    expect(firstState.authority).toBeNull(); expect(baseline.actors[second.alias]?.authority).toBeNull();
    expect(baseline.server.ppid).toBe(firstState.controller.pid); expect(baseline.job.ppid).toBe(firstState.controller.pid);
    expect(baseline.server.uid).toBe(1000); expect(baseline.job.uid).toBe(1000);
    await fixture.save('legacy-topology', baseline);
    for (const actor of fixture.actors) {
      const peer = fixture.actors.find(other => other.alias !== actor.alias); assert.ok(peer);
      await holdDraft(fixture, actor, peer, 'legacy');
      const before = await fixture.snapshot(), oldSelf = before.actors[actor.alias]; assert.ok(oldSelf);
      expect(oldSelf.authority).toBeNull();
      const started = Date.now(), applied = await fixture.apply(actor, 'bridge');
      expect(applied.result.code, 'canonical legacy bridge must complete').toBe(0);
      expect(applied.receipt).toMatchObject({ version: 1, status: 'complete', phase: 'verified',
        probe: { process_alive: true, hello_ack: true, lease_valid: true, delivery_done: true } });
      const after = await fixture.snapshot(), own = after.actors[actor.alias]; assert.ok(own);
      expect(own.authority).toBe('adapter-leader-v1'); expect(own.adapter.pid).not.toBe(oldSelf.adapter.pid);
      expect(own.adapter.ticks).not.toBe(oldSelf.adapter.ticks);
      expect(await fixture.gone(oldSelf.adapter)).toBe(true); expect(await fixture.gone(oldSelf.controller)).toBe(true);
      sameSharedProcesses(before, after, peer);
      await fixture.save('legacy-bridge-' + actor.harness, { before, after, window_receipt: applied.receipt,
        peer_untouched: true, server_survived: true, orphan_job_survived: true, duration_ms: Date.now() - started });
    }
    for (const actor of fixture.actors) {
      const peer = fixture.actors.find(other => other.alias !== actor.alias); assert.ok(peer);
      await holdDraft(fixture, actor, peer, 'current');
      const before = await fixture.snapshot(), oldSelf = before.actors[actor.alias]; assert.ok(oldSelf);
      const stopped = await fixture.directStop(actor); expect(stopped.code, 'canonical supervisor stop must complete').toBe(0);
      await until(async () => await fixture.gone(oldSelf.adapter) && await fixture.gone(oldSelf.controller) ? true : undefined);
      await fixture.start(actor);
      const after = await fixture.snapshot(), own = after.actors[actor.alias]; assert.ok(own);
      expect(own.authority).toBe('adapter-leader-v1'); expect(own.adapter.ticks).not.toBe(oldSelf.adapter.ticks);
      sameSharedProcesses(before, after, peer);
      await fixture.save('normal-restart-' + actor.harness, { before, after, peer_untouched: true, server_survived: true, orphan_job_survived: true });
    }
  } catch (error) {
    try { await fixture.diagnostics(); } catch { /* Keep the original physical failure. */ }
    throw error;
  } finally { await fixture.close(); }
}, 900_000);
