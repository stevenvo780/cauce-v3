import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VersionedContext } from '@cauce/protocol';
import { HarnessAdapter, fakeDefinition } from '../src/harnesses/index.js';
import type { NativeContextIngest, NativeContextIngestInput, NativeContextIngestResult } from '../src/sdk/context-ingest-client.js';
import { DurableStore } from '../src/sdk/durable-store.js';
import { AdapterEngine } from '../src/sdk/engine.js';
import type { AdapterLog, CommandRunner, DeliveryEvent } from '../src/sdk/types.js';
import { conversation, delivery, SUCCESS } from './engine-fixtures.js';

function digestOf(files: { path: string; content: string }[]): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
function snapshot(version: number, files: { path: string; content: string }[]): VersionedContext {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : 1);
  return { company_id: 'context_alpha', tenant_id: 'Steven', alias: 'argos', version, files: sorted, digest: digestOf(sorted) };
}
const v1Files = [{ path: 'context/mission.md', content: 'Version 1 instructions.' }];
function claimed(id: string, context: VersionedContext) {
  return { ...delivery(id), ...conversation({ conversationId: `conv-${id}` }), versioned_context: context };
}

async function fixture(t: TestContext, ingest: NativeContextIngest | undefined,
  options: { editDuringTurn?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cauce-native-ingest-'));
  const space = join(root, 'space'); const path = join(space, 'context/mission.md');
  const previous = process.env.CAUCE_SPACE_ROOT; process.env.CAUCE_SPACE_ROOT = space;
  const reads: string[] = []; const logs: AdapterLog[] = []; let runs = 0;
  const runner: CommandRunner = { run: async () => {
    runs += 1;
    reads.push(await readFile(path, 'utf8').catch(() => 'absent'));
    if (options.editDuringTurn !== undefined && runs === 2) await writeFile(path, options.editDuringTurn);
    return { stdout: SUCCESS, stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false };
  } };
  const store = await DurableStore.open(join(root, 'store')); const events: DeliveryEvent[] = [];
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  const engine: AdapterEngine = new AdapterEngine({ store, harness, ownTenantId: 'Steven',
    executionIntentMode: 'local-test-only', claimRenewalMs: 10, claimWatchdogMs: 2000,
    ...(ingest === undefined ? {} : { contextIngest: ingest }), logger: entry => { logs.push(entry); },
    publish: async event => { events.push(event); if (event.claim_renewal === true) engine.confirmClaim(event.delivery_id, event.attempt, event.claim_token); } });
  await engine.activateEpoch(1);
  t.after(async () => {
    engine.stop();
    if (previous === undefined) delete process.env.CAUCE_SPACE_ROOT; else process.env.CAUCE_SPACE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const stateVersion = async (): Promise<number> =>
    (JSON.parse(await readFile(join(space, 'config/context-state.json'), 'utf8')) as { version: number }).version;
  return { engine, store, events, logs, reads, path, space, stateVersion };
}
const accepting = (calls: NativeContextIngestInput[]): NativeContextIngest => ({
  ingest: async (input): Promise<NativeContextIngestResult> => {
    calls.push(input);
    return { state: 'ingested', context: snapshot(input.base_version + 1, [...input.files]) };
  },
});

test('a local context edit is ingested before the turn, N+1 is adopted, and the turn proceeds', { timeout: 6000 }, async t => {
  const calls: NativeContextIngestInput[] = [];
  const f = await fixture(t, accepting(calls));
  await f.engine.handleDelivery(claimed('ingest-first', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('ingest-first')?.state, 'done');
  assert.equal(await f.stateVersion(), 1);
  await writeFile(f.path, 'Edited inside the space.');
  await mkdir(join(f.space, 'directives'), { recursive: true });
  await writeFile(join(f.space, 'directives/local.md'), 'Created inside the space.');
  await f.engine.handleDelivery(claimed('ingest-second', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('ingest-second')?.state, 'done', JSON.stringify(f.store.getDelivery('ingest-second')?.error));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.base_version, 1);
  assert.deepEqual(calls[0]?.files, [
    { path: 'context/mission.md', content: 'Edited inside the space.' },
    { path: 'directives/local.md', content: 'Created inside the space.' }]);
  assert.equal(f.reads.at(-1), 'Edited inside the space.');
  assert.equal(await f.stateVersion(), 2);
  await f.engine.handleDelivery(claimed('ingest-third', snapshot(2, [
    { path: 'context/mission.md', content: 'Edited inside the space.' },
    { path: 'directives/local.md', content: 'Created inside the space.' }])));
  assert.equal(f.store.getDelivery('ingest-third')?.state, 'done');
  assert.equal(calls.length, 1, 'a steady state must not ingest again');
});

test('files added or normalized by the server snapshot are materialized after ingest', { timeout: 6000 }, async t => {
  const ingest: NativeContextIngest = { ingest: async (input): Promise<NativeContextIngestResult> => (
    { state: 'ingested', context: snapshot(2, [...input.files, { path: 'context/profile.json', content: '{"role":"helper"}\n' }]) }) };
  const f = await fixture(t, ingest);
  await f.engine.handleDelivery(claimed('ingest-profile-first', snapshot(1, v1Files)));
  await writeFile(f.path, 'Edited with profile sync.');
  await f.engine.handleDelivery(claimed('ingest-profile-second', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('ingest-profile-second')?.state, 'done');
  assert.equal(await readFile(join(f.space, 'context/profile.json'), 'utf8'), '{"role":"helper"}\n');
  assert.equal(await f.stateVersion(), 2);
});

test('a server version that already contains the local edit reconciles without ingesting', { timeout: 6000 }, async t => {
  const calls: NativeContextIngestInput[] = [];
  const f = await fixture(t, accepting(calls));
  await f.engine.handleDelivery(claimed('ingest-reconciled-first', snapshot(1, v1Files)));
  await writeFile(f.path, 'Agreed final text.');
  await f.engine.handleDelivery(claimed('ingest-reconciled-second',
    snapshot(2, [{ path: 'context/mission.md', content: 'Agreed final text.' }])));
  assert.equal(f.store.getDelivery('ingest-reconciled-second')?.state, 'done');
  assert.equal(calls.length, 0);
  assert.equal(await f.stateVersion(), 2);
  assert.equal(await readFile(f.path, 'utf8'), 'Agreed final text.');
});

test('a conflict quarantines the local edit as .conflict and the turn proceeds with the server version', { timeout: 6000 }, async t => {
  const ingest: NativeContextIngest = { ingest: async (): Promise<NativeContextIngestResult> => (
    { state: 'conflict', desired_version: 3, applied_version: 1 }) };
  const f = await fixture(t, ingest);
  await f.engine.handleDelivery(claimed('ingest-conflict-first', snapshot(1, v1Files)));
  await writeFile(f.path, 'Local work that must survive.');
  await f.engine.handleDelivery(claimed('ingest-conflict-second', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('ingest-conflict-second')?.state, 'done');
  assert.equal(await readFile(f.path, 'utf8'), 'Version 1 instructions.');
  assert.equal(await readFile(join(f.space, 'config/conflicts/context/mission.md.conflict'), 'utf8'), 'Local work that must survive.');
  assert.equal(await f.stateVersion(), 1);
  assert.equal(f.logs.find(entry => entry.event === 'versioned_context_degraded')?.reason, 'native_context_conflict');
});

test('without an ingest client a local edit is quarantined and the turn proceeds', { timeout: 6000 }, async t => {
  const f = await fixture(t, undefined);
  await f.engine.handleDelivery(claimed('ingest-absent-first', snapshot(1, v1Files)));
  await writeFile(f.path, 'Edited without ingest.');
  await f.engine.handleDelivery(claimed('ingest-absent-second', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('ingest-absent-second')?.state, 'done');
  assert.equal(await readFile(f.path, 'utf8'), 'Version 1 instructions.');
  assert.equal(await readFile(join(f.space, 'config/conflicts/context/mission.md.conflict'), 'utf8'), 'Edited without ingest.');
  assert.equal(f.logs.find(entry => entry.event === 'versioned_context_degraded')?.reason, 'local_context_quarantined');
});

test('non-versionable local files are ignored untouched and never reach the gateway', { timeout: 6000 }, async t => {
  const calls: NativeContextIngestInput[] = [];
  const f = await fixture(t, accepting(calls));
  await f.engine.handleDelivery(claimed('ingest-ignored-first', snapshot(1, v1Files)));
  await writeFile(join(f.space, 'context/auth.json'), '{"token":"local"}');
  await writeFile(join(f.space, 'context/.mission.md.swp'), 'swap');
  await f.engine.handleDelivery(claimed('ingest-ignored-second', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('ingest-ignored-second')?.state, 'done');
  assert.equal(calls.length, 0);
  assert.equal(await readFile(join(f.space, 'context/auth.json'), 'utf8'), '{"token":"local"}');
  assert.equal(await readFile(join(f.space, 'context/.mission.md.swp'), 'utf8'), 'swap');
  assert.ok(f.logs.some(entry => entry.event === 'versioned_context_ignored'));
  assert.equal(await f.stateVersion(), 1);
});

test('an edit made during the turn is ingested at close without failing the turn', { timeout: 6000 }, async t => {
  const calls: NativeContextIngestInput[] = [];
  const f = await fixture(t, accepting(calls), { editDuringTurn: 'Written by the agent mid-turn.' });
  await f.engine.handleDelivery(claimed('ingest-close-first', snapshot(1, v1Files)));
  await f.engine.handleDelivery(claimed('ingest-close-second', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('ingest-close-second')?.state, 'done', JSON.stringify(f.store.getDelivery('ingest-close-second')?.error));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.files, [{ path: 'context/mission.md', content: 'Written by the agent mid-turn.' }]);
  assert.equal(await f.stateVersion(), 2);
  assert.equal(f.events.some(event => event.context_adoption?.version === 1 && event.delivery_id === 'ingest-close-second'), false,
    'no adoption evidence for a version the turn did not execute');
});

test('an oversize version degrades materialization without failing the turn', { timeout: 6000 }, async t => {
  const calls: NativeContextIngestInput[] = [];
  const f = await fixture(t, accepting(calls));
  const big = 'x'.repeat(70_000);
  await f.engine.handleDelivery(claimed('ingest-oversize', snapshot(1, [{ path: 'context/mission.md', content: big }])));
  assert.equal(f.store.getDelivery('ingest-oversize')?.state, 'done', JSON.stringify(f.store.getDelivery('ingest-oversize')?.error));
  assert.equal(f.reads.at(-1), 'absent');
  assert.equal(f.logs.find(entry => entry.event === 'versioned_context_degraded')?.reason, 'context_too_large');
});

test('a delivery sealed with an older version is treated as superseded, not as an error', { timeout: 6000 }, async t => {
  const calls: NativeContextIngestInput[] = [];
  const f = await fixture(t, accepting(calls));
  await f.engine.handleDelivery(claimed('ingest-superseded-first', snapshot(2, [{ path: 'context/mission.md', content: 'Version 2 instructions.' }])));
  assert.equal(await f.stateVersion(), 2);
  await f.engine.handleDelivery(claimed('ingest-superseded-stale', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('ingest-superseded-stale')?.state, 'done', JSON.stringify(f.store.getDelivery('ingest-superseded-stale')?.error));
  assert.equal(await readFile(f.path, 'utf8'), 'Version 2 instructions.');
  assert.equal(f.logs.find(entry => entry.event === 'versioned_context_degraded')?.reason, 'context_superseded');
});

test('the native harness document is generated from the applied version around user content', { timeout: 6000 }, async t => {
  const f = await fixture(t, undefined);
  await f.engine.handleDelivery(claimed('native-doc-first', snapshot(1, v1Files)));
  const nativePath = join(f.space, 'AGENTS.md');
  const first = await readFile(nativePath, 'utf8');
  assert.match(first, /CAUCE VERSIONED CONTEXT START/);
  assert.match(first, /Version 1; digest [a-f0-9]{64}/);
  assert.match(first, /Version 1 instructions\./);
  await writeFile(nativePath, `Operator preamble kept across versions.\n\n${first}`);
  await f.engine.handleDelivery(claimed('native-doc-second', snapshot(2, [{ path: 'context/mission.md', content: 'Version 2 instructions.' }])));
  const second = await readFile(nativePath, 'utf8');
  assert.match(second, /^Operator preamble kept across versions\./);
  assert.match(second, /Version 2; digest [a-f0-9]{64}/);
  assert.match(second, /Version 2 instructions\./);
  assert.doesNotMatch(second, /Version 1 instructions\./);
  assert.equal(f.store.getDelivery('native-doc-second')?.state, 'done');
});
