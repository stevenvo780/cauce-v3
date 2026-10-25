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
import { canonicalVersionedContext } from '../src/context/versioned-context-files.js';
import { VersionedContextTurn } from '../src/sdk/engine/versioned-context.js';
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
  assert.deepEqual(calls[0].files, [
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

test('an ingest response accepted by the gateway materializes despite a stricter local scanner', { timeout: 6000 }, async t => {
  const content = 'Gateway-approved\u200b annotation.';
  const calls: NativeContextIngestInput[] = [];
  const ingest: NativeContextIngest = { ingest: async input => {
    calls.push(input);
    const context = snapshot(2, [...input.files, { path: 'directives/server.md', content }]);
    assert.throws(() => canonicalVersionedContext(context), /content is unsafe/u);
    return { state: 'ingested', context };
  } };
  const f = await fixture(t, ingest);
  await f.engine.handleDelivery(claimed('delivered-ingest-first', snapshot(1, v1Files)));
  await writeFile(f.path, 'Safe local edit.');
  await f.engine.handleDelivery(claimed('delivered-ingest-second', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('delivered-ingest-second')?.state, 'done');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.files, [{ path: 'context/mission.md', content: 'Safe local edit.' }]);
  assert.equal(await readFile(join(f.space, 'directives/server.md'), 'utf8'), content);
  assert.ok((await readFile(join(f.space, 'AGENTS.md'), 'utf8')).includes(content));
  assert.equal(await f.stateVersion(), 2);
});

test('a gateway ingest response with an altered digest is rejected before writing or adopting its files', { timeout: 6000 }, async t => {
  let tampered = true;
  const ingest: NativeContextIngest = { ingest: async input => {
    const context = snapshot(input.base_version + 1, [
      { path: 'context/mission.md', content: 'Gateway-normalized text.' },
      { path: 'directives/server.md', content: 'Gateway directive.' },
    ]);
    return { state: 'ingested', context: tampered ? { ...context, digest: '0'.repeat(64) } : context };
  } };
  const f = await fixture(t, ingest);
  await f.engine.handleDelivery(claimed('digest-ingest-first', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('digest-ingest-first')?.state, 'done');
  const localContent = 'Local work that must survive an invalid response.';
  await writeFile(f.path, localContent);
  const nativeBefore = await readFile(join(f.space, 'AGENTS.md'), 'utf8');
  await f.engine.handleDelivery(claimed('digest-ingest-tampered', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('digest-ingest-tampered')?.state, 'failed');
  assert.equal(await f.stateVersion(), 1);
  assert.equal(await readFile(f.path, 'utf8'), localContent);
  assert.equal(await readFile(join(f.space, 'AGENTS.md'), 'utf8'), nativeBefore);
  await assert.rejects(readFile(join(f.space, 'directives/server.md'), 'utf8'), { code: 'ENOENT' });
  assert.deepEqual(f.reads, ['Version 1 instructions.']);
  assert.equal(f.events.some(event => event.context_adoption?.version === 2), false);
  tampered = false;
  await f.engine.handleDelivery(claimed('digest-ingest-valid', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('digest-ingest-valid')?.state, 'done');
  assert.equal(await f.stateVersion(), 2);
  assert.equal(await readFile(f.path, 'utf8'), 'Gateway-normalized text.');
  assert.equal(await readFile(join(f.space, 'directives/server.md'), 'utf8'), 'Gateway directive.');
  assert.equal(f.reads.at(-1), 'Gateway-normalized text.');
});

test('a locally written invisible character is quarantined before any gateway ingest', { timeout: 6000 }, async t => {
  const calls: NativeContextIngestInput[] = [];
  const f = await fixture(t, accepting(calls));
  await f.engine.handleDelivery(claimed('unsafe-ingest-first', snapshot(1, v1Files)));
  const localContent = 'Unsafe\u200b local edit.';
  await writeFile(f.path, localContent);
  await f.engine.handleDelivery(claimed('unsafe-ingest-second', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('unsafe-ingest-second')?.state, 'done');
  assert.equal(calls.length, 0);
  assert.equal(await readFile(f.path, 'utf8'), 'Version 1 instructions.');
  assert.equal(await readFile(join(f.space, 'config/conflicts/context/mission.md.conflict'), 'utf8'), localContent);
  assert.equal(await f.stateVersion(), 1);
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

async function openClawSpace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cauce-native-openclaw-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const previous = process.env.CAUCE_OPENCLAW_WORKSPACE;
  process.env.CAUCE_OPENCLAW_WORKSPACE = workspace;
  t.after(async () => {
    if (previous === undefined) delete process.env.CAUCE_OPENCLAW_WORKSPACE;
    else process.env.CAUCE_OPENCLAW_WORKSPACE = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, memory: join(workspace, 'MEMORY.md'),
    files: [{ path: 'context/MEMORY.md', content: 'Seeded native memory.' },
      { path: 'directives/AGENTS.md', content: 'Native instructions.' },
      { path: 'directives/SOUL.md', content: 'Native personality.' }] };
}

test('first OpenClaw adoption ingests a changed workspace memory before applying and the next server version updates it', async t => {
  const f = await openClawSpace(t); const calls: NativeContextIngestInput[] = [];
  await writeFile(f.memory, 'Native memory written after the seed.');
  await writeFile(join(f.workspace, 'AGENTS.md'), 'Native instructions.');
  await writeFile(join(f.workspace, 'SOUL.md'), 'Native personality.');
  const turn = new VersionedContextTurn(f.root, accepting(calls));
  await turn.materialize(claimed('native-openclaw-first', snapshot(1, f.files)), 'Steven', 'openclaw');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.base_version, 1);
  assert.equal(calls[0].files.find(file => file.path === 'context/MEMORY.md')?.content, 'Native memory written after the seed.');
  assert.equal(turn.materializedVersion, 2);
  assert.equal(turn.materializationDegraded, undefined);
  assert.equal(await readFile(f.memory, 'utf8'), 'Native memory written after the seed.');
  await turn.verify();
  assert.equal(calls.length, 1, 'a native receipt is stable after the turn');
  const nextFiles = calls[0].files.map(file => file.path === 'context/MEMORY.md' ? { ...file, content: 'Server memory update.' } : file);
  const next = new VersionedContextTurn(f.root, accepting(calls));
  await next.materialize(claimed('native-openclaw-next', snapshot(3, [...nextFiles])), 'Steven', 'openclaw');
  assert.equal(calls.length, 1, 'a server-only change is never ingested as local work');
  assert.equal(next.materializedVersion, 3);
  assert.equal(await readFile(f.memory, 'utf8'), 'Server memory update.');
  assert.equal(await readFile(join(f.root, 'context/MEMORY.md'), 'utf8'), 'Server memory update.');
});

test('OpenClaw reports a conflict only after local and server content both change, preserving the local native file', async t => {
  const f = await openClawSpace(t); const calls: NativeContextIngestInput[] = [];
  const seed = new VersionedContextTurn(f.root, accepting(calls));
  await seed.materialize(claimed('native-conflict-seed', snapshot(1, f.files)), 'Steven', 'openclaw');
  await writeFile(f.memory, 'Agent memory to preserve.');
  const ingest: NativeContextIngest = { ingest: async input => {
    calls.push(input); return { state: 'conflict', desired_version: 2, applied_version: 1 };
  } };
  const files = f.files.map(file => file.path === 'context/MEMORY.md' ? { ...file, content: 'Operator memory.' } : file);
  const turn = new VersionedContextTurn(f.root, ingest);
  await turn.materialize(claimed('native-conflict-both', snapshot(2, files)), 'Steven', 'openclaw');
  assert.equal(calls[0]?.base_version, 1);
  assert.equal(turn.materializationDegraded?.code, 'native_context_conflict');
  assert.equal(await readFile(join(f.root, 'config/conflicts/native/context/MEMORY.md.conflict'), 'utf8'), 'Agent memory to preserve.');
  assert.equal(await readFile(f.memory, 'utf8'), 'Operator memory.');
});

test('a native change stays active when no ingest client can preserve it', async t => {
  const f = await openClawSpace(t);
  await writeFile(f.memory, 'Unregistered native work.');
  const turn = new VersionedContextTurn(f.root);
  await assert.rejects(turn.materialize(claimed('native-no-client', snapshot(1, f.files)), 'Steven', 'openclaw'),
    { code: 'VERSIONED_CONTEXT_INGEST_FAILED' });
  assert.equal(await readFile(f.memory, 'utf8'), 'Unregistered native work.');
  await assert.rejects(readFile(join(f.root, 'config/context-state.json')), { code: 'ENOENT' });
});

test('native edits written while ingest is in flight survive without a materialization receipt', async t => {
  const f = await openClawSpace(t);
  await writeFile(f.memory, 'Native work before ingest.');
  const ingest: NativeContextIngest = { ingest: async input => {
    await writeFile(f.memory, 'Newer native work while the gateway records the candidate.');
    return { state: 'ingested', context: snapshot(2, [...input.files]) };
  } };
  const turn = new VersionedContextTurn(f.root, ingest);
  await assert.rejects(turn.materialize(claimed('native-ingest-race', snapshot(1, f.files)), 'Steven', 'openclaw'),
    { code: 'VERSIONED_CONTEXT_INGEST_FAILED' });
  assert.equal(await readFile(f.memory, 'utf8'), 'Newer native work while the gateway records the candidate.');
  await assert.rejects(readFile(join(f.root, 'config/context-state.json')), { code: 'ENOENT' });
});

test('a first native adoption without its server ancestor receipt never guesses between two changed sides', async t => {
  const f = await openClawSpace(t); const calls: NativeContextIngestInput[] = [];
  await writeFile(f.memory, 'Native work with no recorded ancestor.');
  const turn = new VersionedContextTurn(f.root, accepting(calls));
  await assert.rejects(turn.materialize(claimed('native-no-ancestor', snapshot(3, f.files)), 'Steven', 'openclaw'),
    { code: 'VERSIONED_CONTEXT_INGEST_FAILED' });
  assert.equal(calls.length, 0);
  assert.equal(await readFile(f.memory, 'utf8'), 'Native work with no recorded ancestor.');
});

test('a native deletion after an applied receipt is ingested and never restored from the canonical replica', async t => {
  const f = await openClawSpace(t); const calls: NativeContextIngestInput[] = [];
  await new VersionedContextTurn(f.root, accepting(calls)).materialize(claimed('native-delete-seed', snapshot(1, f.files)), 'Steven', 'openclaw');
  await rm(f.memory);
  const turn = new VersionedContextTurn(f.root, accepting(calls));
  await turn.materialize(claimed('native-delete-ingest', snapshot(1, f.files)), 'Steven', 'openclaw');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.files.some(file => file.path === 'context/MEMORY.md'), false);
  assert.equal(turn.materializedVersion, 2);
  await assert.rejects(readFile(f.memory), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.root, 'context/MEMORY.md')), { code: 'ENOENT' });
});

test('a foreign context receipt never authorizes ingesting another target native memory', async t => {
  const f = await openClawSpace(t); const calls: NativeContextIngestInput[] = [];
  await new VersionedContextTurn(f.root, accepting(calls)).materialize(claimed('native-foreign-seed', snapshot(1, f.files)), 'Steven', 'openclaw');
  const receipt = join(f.root, 'config/context-state.json');
  const state = JSON.parse(await readFile(receipt, 'utf8')) as Record<string, unknown>;
  await writeFile(receipt, JSON.stringify({ ...state, alias: 'other' }));
  await writeFile(f.memory, 'Private work of another target.');
  await assert.rejects(new VersionedContextTurn(f.root, accepting(calls)).materialize(
    claimed('native-foreign-ingest', snapshot(1, f.files)), 'Steven', 'openclaw'), { code: 'INVALID_VERSIONED_CONTEXT' });
  assert.equal(calls.length, 0);
  assert.equal(await readFile(f.memory, 'utf8'), 'Private work of another target.');
});

test('a server advance beyond the sealed delivery never applies the obsolete snapshot over native work', async t => {
  const f = await openClawSpace(t);
  await new VersionedContextTurn(f.root, accepting([])).materialize(claimed('native-stale-seed', snapshot(1, f.files)), 'Steven', 'openclaw');
  await writeFile(f.memory, 'Native memory newer than the sealed delivery.');
  const ingest: NativeContextIngest = { ingest: async () => ({ state: 'conflict', desired_version: 3, applied_version: 1 }) };
  const turn = new VersionedContextTurn(f.root, ingest);
  await assert.rejects(turn.materialize(claimed('native-stale-conflict', snapshot(1, f.files)), 'Steven', 'openclaw'),
    { code: 'VERSIONED_CONTEXT_INGEST_FAILED' });
  assert.equal(turn.materializedVersion, undefined);
  assert.equal(await readFile(f.memory, 'utf8'), 'Native memory newer than the sealed delivery.');
});

test('an untracked stale canonical replica cannot replace native content that already matches the delivered version', async t => {
  const f = await openClawSpace(t); const calls: NativeContextIngestInput[] = [];
  await mkdir(join(f.root, 'context'));
  await writeFile(join(f.root, 'context/MEMORY.md'), 'Stale canonical replica.');
  await writeFile(f.memory, 'Seeded native memory.');
  const turn = new VersionedContextTurn(f.root, accepting(calls));
  await turn.materialize(claimed('native-matches-server', snapshot(3, f.files)), 'Steven', 'openclaw');
  assert.equal(calls.length, 0);
  assert.equal(turn.materializedVersion, 3);
  assert.equal(await readFile(f.memory, 'utf8'), 'Seeded native memory.');
  assert.equal(await readFile(join(f.root, 'context/MEMORY.md'), 'utf8'), 'Seeded native memory.');
});
