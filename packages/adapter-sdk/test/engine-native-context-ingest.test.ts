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
import type { CommandRunner, DeliveryEvent } from '../src/sdk/types.js';
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

async function fixture(t: TestContext, ingest: NativeContextIngest | undefined) {
  const root = await mkdtemp(join(tmpdir(), 'cauce-native-ingest-'));
  const space = join(root, 'space'); const path = join(space, 'context/mission.md');
  const previous = process.env.CAUCE_SPACE_ROOT; process.env.CAUCE_SPACE_ROOT = space;
  const reads: string[] = [];
  const runner: CommandRunner = { run: async () => {
    reads.push(await readFile(path, 'utf8'));
    return { stdout: SUCCESS, stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false };
  } };
  const store = await DurableStore.open(join(root, 'store')); const events: DeliveryEvent[] = [];
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  const engine: AdapterEngine = new AdapterEngine({ store, harness, ownTenantId: 'Steven',
    executionIntentMode: 'local-test-only', claimRenewalMs: 10, claimWatchdogMs: 2000,
    ...(ingest === undefined ? {} : { contextIngest: ingest }),
    publish: async event => { events.push(event); if (event.claim_renewal === true) engine.confirmClaim(event.delivery_id, event.attempt, event.claim_token); } });
  await engine.activateEpoch(1);
  t.after(async () => {
    engine.stop();
    if (previous === undefined) delete process.env.CAUCE_SPACE_ROOT; else process.env.CAUCE_SPACE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const stateVersion = async (): Promise<number> =>
    (JSON.parse(await readFile(join(space, 'config/context-state.json'), 'utf8')) as { version: number }).version;
  return { engine, store, events, reads, path, space, stateVersion };
}

test('a local context edit is ingested before the turn, N+1 is adopted, and the turn proceeds', { timeout: 6000 }, async t => {
  const calls: NativeContextIngestInput[] = [];
  const ingest: NativeContextIngest = { ingest: async (input): Promise<NativeContextIngestResult> => {
    calls.push(input);
    return { state: 'ingested', context: snapshot(input.base_version + 1, [...input.files]) };
  } };
  const f = await fixture(t, ingest);
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

test('a conflict preserves the local file untouched and fails the turn closed', { timeout: 6000 }, async t => {
  const ingest: NativeContextIngest = { ingest: async (): Promise<NativeContextIngestResult> => (
    { state: 'conflict', desired_version: 3, applied_version: 1 }) };
  const f = await fixture(t, ingest);
  await f.engine.handleDelivery(claimed('ingest-conflict-first', snapshot(1, v1Files)));
  assert.equal(f.reads.length, 1);
  await writeFile(f.path, 'Local work that must survive.');
  await f.engine.handleDelivery(claimed('ingest-conflict-second', snapshot(1, v1Files)));
  const failed = f.events.find(event => event.delivery_id === 'ingest-conflict-second' && event.phase === 'failed');
  assert.equal(failed?.error?.code, 'VERSIONED_CONTEXT_CONFLICT');
  assert.equal(await readFile(f.path, 'utf8'), 'Local work that must survive.');
  assert.equal(await f.stateVersion(), 1);
  assert.equal(f.reads.length, 1, 'the harness must not run on a conflicted turn');
});

test('without an ingest client the previous fail-closed behavior remains', { timeout: 6000 }, async t => {
  const f = await fixture(t, undefined);
  await f.engine.handleDelivery(claimed('ingest-absent-first', snapshot(1, v1Files)));
  await writeFile(f.path, 'Edited without ingest.');
  await f.engine.handleDelivery(claimed('ingest-absent-second', snapshot(1, v1Files)));
  assert.equal(f.store.getDelivery('ingest-absent-second')?.state, 'failed');
  assert.equal(await readFile(f.path, 'utf8'), 'Edited without ingest.');
  assert.equal(f.reads.length, 1);
});

test('a local file that cannot be ingested safely never reaches the gateway', { timeout: 6000 }, async t => {
  const calls: NativeContextIngestInput[] = [];
  const ingest: NativeContextIngest = { ingest: async (input): Promise<NativeContextIngestResult> => {
    calls.push(input);
    return { state: 'ingested', context: snapshot(2, [...input.files]) };
  } };
  const f = await fixture(t, ingest);
  await f.engine.handleDelivery(claimed('ingest-unsafe-first', snapshot(1, v1Files)));
  await writeFile(join(f.space, 'context/auth.json'), '{"token":"local"}');
  await f.engine.handleDelivery(claimed('ingest-unsafe-second', snapshot(1, v1Files)));
  const failed = f.events.find(event => event.delivery_id === 'ingest-unsafe-second' && event.phase === 'failed');
  assert.equal(failed?.error?.code, 'VERSIONED_CONTEXT_CHANGED');
  assert.equal(calls.length, 0);
  assert.equal(await f.stateVersion(), 1);
});
