import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { CODEX_SHORTCUT_LINE, CODEX_STATUS_LINE, CODEX_STATUS_SEGMENTS, codexFooterProvider } from './g3-pie-codex-real.provider.js';
import { IDLE_PLACEHOLDER, NEUTRAL_HISTORY } from './s2d-provider.js';
import { sharedWindowFixture, until, type Actor, type Identity, type Observation, type SharedWindowFixture } from './s2d-ws-humanizar.fixture.js';

const sources = ['tests/e2e/g3-pie-codex-real.provider.ts', 'tests/e2e/g3-pie-codex-real.test.ts'];
const sgr = new RegExp(String.fromCharCode(27) + '\\[[0-9;:]*m', 'gu');
const plain = (value: string) => value.replace(sgr, '').replaceAll('\r', '');

function sameProcess(before: Identity, after: Identity) {
  expect(after.pid).toBe(before.pid); expect(after.ticks).toBe(before.ticks);
}
function preserveShared(before: Observation, after: Observation, peer: Actor) {
  sameProcess(before.server, after.server);
  assert.ok(before.job && after.job); sameProcess(before.job, after.job);
  const oldPeer = before.actors[peer.alias], newPeer = after.actors[peer.alias]; assert.ok(oldPeer && newPeer);
  sameProcess(oldPeer.adapter, newPeer.adapter); sameProcess(oldPeer.controller, newPeer.controller);
  const oldPane = before.panes[peer.alias], newPane = after.panes[peer.alias]; assert.ok(oldPane && newPane);
  expect(newPane.session).toBe(oldPane.session); expect(newPane.pane).toBe(oldPane.pane);
  sameProcess(oldPane.process, newPane.process);
}
async function preservePeerDraft(fixture: SharedWindowFixture, peer: Actor) {
  const text = 'G3_OWNED_PEER_DRAFT'; await fixture.keys(peer, [text], true);
  await until(async () => (await fixture.provider(peer)).draftLength === text.length ? true : undefined);
  const pane = await fixture.pane(peer), input = await fixture.provider(peer), cursor = await fixture.cursor(peer);
  return {
    verify: async () => {
      expect(await fixture.pane(peer) === pane, 'the peer compositor changed').toBe(true);
      expect(await fixture.provider(peer)).toEqual(input); expect(await fixture.cursor(peer)).toEqual(cursor);
      return { compositor_unchanged: true, input_unchanged: true, cursor_unchanged: true, provider: input };
    },
    clear: async () => {
      await fixture.keys(peer, ['C-u']);
      await until(async () => (await fixture.provider(peer)).draftLength === 0 ? true : undefined);
    },
  };
}
async function idleFooter(fixture: SharedWindowFixture, actor: Actor) {
  const captured = await fixture.pane(actor), styled = captured.split('\n'), lines = plain(captured).split('\n');
  const prompt = lines.findIndex(line => line.trim() === '› ' + IDLE_PLACEHOLDER);
  const status = lines.findIndex(line => line.trim() === CODEX_STATUS_LINE);
  expect(lines.some(line => line.trim() === NEUTRAL_HISTORY)).toBe(true);
  expect(prompt).toBeGreaterThan(0); expect(lines[prompt - 1]?.trim() === '').toBe(true);
  expect(status).toBe(prompt + 2); expect(lines[status - 1]?.trim() === '').toBe(true);
  expect(lines[status + 1]?.trim() === CODEX_SHORTCUT_LINE).toBe(true);
  expect(styled[prompt]?.includes('\x1b[2m'), 'the empty composer has no dim placeholder').toBe(true);
  for (const [index, color] of [223, 151, 225].entries()) {
    const segment = CODEX_STATUS_SEGMENTS[index]; assert.ok(segment);
    expect(styled[status]?.includes('\x1b[38;5;' + String(color) + 'm' + segment), 'the footer lost an explicit segment color').toBe(true);
  }
  const reset = String.fromCharCode(27) + '\\[(?:0|39|)m · ';
  expect([...(styled[status] ?? '').matchAll(new RegExp(reset, 'gu'))].length === 2, 'both footer separators must use the default color').toBe(true);
  expect(styled[status + 1]?.includes('\x1b[1m?'), 'the shortcut key must be bold').toBe(true);
  expect(styled[status + 1]?.includes('\x1b[38;5;179m⚠ 2 warnings'), 'the warning count must have its explicit color').toBe(true);
  expect(styled[status + 1]?.includes('\x1b[1mf2'), 'the warning shortcut must be bold').toBe(true);
  const provider = await fixture.provider(actor); expect(provider.draftLength).toBe(0);
  expect(await fixture.cursor(actor)).toEqual({ x: 2, y: 2 });
  return { neutral_history: true, empty_composer: true, dim_placeholder: true, explicit_segment_colors: [223, 151, 225],
    default_separator: true, bold_shortcuts: true, warnings_line: true, warning_color: 179, cursor_at_input_start: true, provider };
}

interface Draft { name: string; text: string; paste: boolean; right: number }
const drafts: Draft[] = [
  { name: 'plain-footer-home', text: CODEX_STATUS_LINE, paste: false, right: 0 },
  { name: 'plain-footer-middle', text: CODEX_STATUS_LINE, paste: false, right: 8 },
  { name: 'pasted-footer', text: CODEX_STATUS_LINE, paste: true, right: 0 },
  { name: 'multiline-footer', text: '\n' + CODEX_STATUS_LINE + '\n' + CODEX_SHORTCUT_LINE, paste: true, right: 0 },
];
async function holdDraft(fixture: SharedWindowFixture, actor: Actor, peer: Actor, draft: Draft, phase: 'legacy' | 'current') {
  await fixture.keys(actor, [draft.paste ? '\x1b[200~' + draft.text + '\x1b[201~' : draft.text], true);
  await until(async () => (await fixture.provider(actor)).draftLength === draft.text.length ? true : undefined);
  await fixture.keys(actor, ['C-a', ...Array<string>(draft.right).fill('Right')]);
  await until(async () => { const cursor = await fixture.cursor(actor); return cursor.x === 2 + draft.right && cursor.y === 2 ? true : undefined; });
  const before = await fixture.snapshot(), pane = await fixture.pane(actor), input = await fixture.provider(actor), cursor = await fixture.cursor(actor);
  expect(input.draftLength).toBe(draft.text.length);
  const draftRows = pane.split('\n').slice(2, 2 + draft.text.split('\n').length);
  expect(draftRows.every(row => row === plain(row)), 'the owner draft must remain unstyled').toBe(true);
  const attempted = phase === 'legacy' ? (await fixture.apply(actor, 'hold-' + draft.name)).result : await fixture.directStop(actor);
  await fixture.save('hold-attempt-' + phase + '-' + draft.name, { exit_code: attempted.code,
    canonical_hold: /(?:RESTART|SPACE)_[A-Z_]*HOLD[A-Z_]*/u.test(attempted.stderr + attempted.stdout) });
  expect(attempted.code).not.toBe(0);
  expect(/(?:RESTART|SPACE)_[A-Z_]*HOLD[A-Z_]*/u.test(attempted.stderr + attempted.stdout), 'the canonical restart must report HOLD').toBe(true);
  const after = await fixture.snapshot(), oldSelf = before.actors[actor.alias], newSelf = after.actors[actor.alias]; assert.ok(oldSelf && newSelf);
  sameProcess(oldSelf.adapter, newSelf.adapter); sameProcess(oldSelf.controller, newSelf.controller);
  const oldPane = before.panes[actor.alias], newPane = after.panes[actor.alias]; assert.ok(oldPane && newPane);
  expect(newPane.session).toBe(oldPane.session); expect(newPane.pane).toBe(oldPane.pane); sameProcess(oldPane.process, newPane.process);
  preserveShared(before, after, peer);
  expect(await fixture.pane(actor) === pane, 'the unsent compositor changed during HOLD').toBe(true);
  expect(await fixture.provider(actor)).toEqual(input); expect(await fixture.cursor(actor)).toEqual(cursor);
  await fixture.save('hold-' + phase + '-' + draft.name, { before, after, draft_case: draft.name, mechanism: phase === 'legacy' ? 'window' : 'supervisor stop',
    canonical_hold: true, draft_without_style: true, processes_unchanged: true, compositor_unchanged: true, cursor_unchanged: true, input_unchanged: true, provider: input });
  await fixture.keys(actor, ['C-u']); await until(async () => (await fixture.provider(actor)).draftLength === 0 ? true : undefined);
}
async function verifyRestart(fixture: SharedWindowFixture, actor: Actor, peer: Actor, before: Observation) {
  const after = await fixture.snapshot(), oldSelf = before.actors[actor.alias], newSelf = after.actors[actor.alias]; assert.ok(oldSelf && newSelf);
  expect(newSelf.authority).toBe('adapter-leader-v1');
  expect(newSelf.adapter.pid === oldSelf.adapter.pid && newSelf.adapter.ticks === oldSelf.adapter.ticks, 'the adapter process identity did not rotate').toBe(false);
  expect(await fixture.gone(oldSelf.adapter)).toBe(true); expect(await fixture.gone(oldSelf.controller)).toBe(true);
  const oldPane = before.panes[actor.alias], newPane = after.panes[actor.alias]; assert.ok(oldPane && newPane);
  expect(newPane.session).toBe(oldPane.session); expect(newPane.pane).toBe(oldPane.pane); sameProcess(oldPane.process, newPane.process);
  preserveShared(before, after, peer);
  return after;
}

test('the canonical Codex footer permits real unit stop, start and restart while owner drafts remain held', async () => {
  const fixture = await sharedWindowFixture({ campaign: 'g3-pie-codex-real-1025', providerSource: codexFooterProvider, extraSourceFiles: sources });
  try {
    const actor = fixture.actors.find(value => value.harness === 'codex'), peer = fixture.actors.find(value => value.harness === 'claude');
    assert.ok(actor && peer); await fixture.start(actor); await fixture.start(peer);
    await fixture.keys(actor, ['S2D_LAUNCH_OWNED_FOREIGN_JOB'], true); await fixture.keys(actor, ['Enter']);
    const baseline = await until(async () => { const observed = await fixture.snapshot(); return observed.job ? observed : undefined; });
    const oldSelf = baseline.actors[actor.alias]; assert.ok(oldSelf && baseline.job);
    expect(oldSelf.authority).toBeNull(); expect(baseline.server.ppid).toBe(oldSelf.controller.pid); expect(baseline.job.ppid).toBe(oldSelf.controller.pid);
    expect(baseline.server.uid).toBe(1000); expect(baseline.job.uid).toBe(1000);
    await fixture.save('legacy-topology', baseline);
    for (const draft of drafts) await holdDraft(fixture, actor, peer, draft, 'legacy');
    const bridgePeer = await preservePeerDraft(fixture, peer), beforeBridge = await fixture.snapshot(), bridgeFooter = await idleFooter(fixture, actor);
    const applied = await fixture.apply(actor, 'bridge'); expect(applied.result.code, 'the canonical bridge must complete with the styled footer').toBe(0);
    expect(applied.receipt).toMatchObject({ version: 1, status: 'complete', phase: 'verified',
      probe: { process_alive: true, hello_ack: true, lease_valid: true, delivery_done: true } });
    const afterBridge = await verifyRestart(fixture, actor, peer, beforeBridge);
    await fixture.save('legacy-bridge', { before: beforeBridge, after: afterBridge, idle_footer: bridgeFooter, receipt: applied.receipt, peer_draft: await bridgePeer.verify() });
    await bridgePeer.clear();
    for (const draft of drafts) await holdDraft(fixture, actor, peer, draft, 'current');
    const stoppedPeer = await preservePeerDraft(fixture, peer), beforeStop = await fixture.snapshot(), stopFooter = await idleFooter(fixture, actor);
    const stopped = await fixture.stopUnit(actor); expect(stopped.code, 'systemd stop must complete with the styled footer').toBe(0);
    const stoppedSelf = beforeStop.actors[actor.alias]; assert.ok(stoppedSelf);
    await until(async () => await fixture.gone(stoppedSelf.adapter) && await fixture.gone(stoppedSelf.controller) ? true : undefined);
    await fixture.start(actor);
    const afterStart = await verifyRestart(fixture, actor, peer, beforeStop);
    await fixture.save('unit-stop-start', { before: beforeStop, after: afterStart, idle_footer: stopFooter, stop_exit: stopped.code, peer_draft: await stoppedPeer.verify() });
    await stoppedPeer.clear();
    const restartPeer = await preservePeerDraft(fixture, peer), beforeRestart = await fixture.snapshot(), restartFooter = await idleFooter(fixture, actor);
    const restarted = await fixture.restartUnit(actor); expect(restarted.code, 'systemd restart must complete with the styled footer').toBe(0);
    await fixture.waitReady(actor);
    const afterRestart = await verifyRestart(fixture, actor, peer, beforeRestart);
    await fixture.save('unit-restart', { before: beforeRestart, after: afterRestart, idle_footer: restartFooter, restart_exit: restarted.code, peer_draft: await restartPeer.verify() });
    await restartPeer.clear();
  } catch (error) {
    try { await fixture.diagnostics(); } catch { /* Keep the original physical failure. */ }
    throw error;
  } finally { await fixture.close(); }
}, 900_000);
