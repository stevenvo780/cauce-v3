import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessAdapter, codexDefinition, fakeDefinition } from '../src/harnesses/index.js';
import { DurableStore } from '../src/sdk/durable-store.js';
import { AdapterEngine } from '../src/sdk/engine.js';
import type { CommandRunner, DeliveryEvent } from '../src/sdk/types.js';
import { consumptionWitness } from '../src/shared-session/consumption.js';
import { conversation, delivery, SUCCESS, waitFor } from './engine-fixtures.js';

function context(version: number) {
  const files = [{ path: 'context/mission.md', content: `Version ${String(version)} instructions.` }];
  return { company_id: 'context_alpha', tenant_id: 'Steven', alias: 'argos', version, files,
    digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
function claimed(id: string, version: number, session = 'shared-conversation') {
  return { ...delivery(id), ...conversation({ conversationId: session }), versioned_context: context(version) };
}
async function fixture(t: TestContext, queueWaitTimeoutMs = 2000, withWitness = false, withSpace = true) {
  const root = await mkdtemp(join(tmpdir(), 'cauce-space-turn-'));
  const space = join(root, 'space'); const path = join(space, 'context/mission.md');
  const previous = process.env.CAUCE_SPACE_ROOT;
  if (withSpace) process.env.CAUCE_SPACE_ROOT = space; else delete process.env.CAUCE_SPACE_ROOT;
  const inputs: string[] = []; const reads: string[] = []; const releases: (() => void)[] = []; const executions: Promise<void>[] = [];
  const engines: AdapterEngine[] = []; let releasing = false;
  const runner: CommandRunner = { run: async input => {
    inputs.push(input.stdin); reads.push(await readFile(path, 'utf8').catch(() => 'absent'));
    await new Promise<void>(resolve => {
      if (releasing || input.signal.aborted) resolve();
      else { releases.push(resolve); input.signal.addEventListener('abort', () => { resolve(); }, { once: true }); }
    });
    const nativeSession = '00000000-0000-4000-8000-000000000001';
    const proof = withWitness ? consumptionWitness('codex', nativeSession, 'fixture-turn', input.stdin) : undefined;
    const stdout = withWitness ? [JSON.stringify({ type: 'thread.started', thread_id: nativeSession }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: SUCCESS } }), JSON.stringify({ type: 'turn.completed' })].join('\n') : SUCCESS;
    return { stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false,
      ...(proof === undefined ? {} : { consumptionWitness: proof }) };
  } };
  const createEngine = async (id: string) => {
    const store = await DurableStore.open(join(root, id)); const events: DeliveryEvent[] = [];
    const definition = withWitness ? codexDefinition : fakeDefinition;
    const harness = new HarnessAdapter({ definition, runner, store });
    const engine: AdapterEngine = new AdapterEngine({ store, harness, ownTenantId: 'Steven',
      executionIntentMode: 'local-test-only', claimRenewalMs: 10, claimWatchdogMs: 2000, queueWaitTimeoutMs,
      publish: async event => { events.push(event); if (event.claim_renewal === true) engine.confirmClaim(event.delivery_id, event.attempt, event.claim_token); } });
    engines.push(engine); await engine.activateEpoch(1); return { engine, store, events };
  };
  t.after(async () => {
    releasing = true; for (const engine of engines) engine.stop(); for (const release of releases) release();
    await Promise.allSettled(executions);
    if (previous === undefined) delete process.env.CAUCE_SPACE_ROOT; else process.env.CAUCE_SPACE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const start = (engine: AdapterEngine, input: ReturnType<typeof claimed>) => {
    const running = engine.handleDelivery(input); executions.push(running); return running;
  };
  const release = () => { const next = releases.shift(); assert.ok(next); next(); };
  const releaseLast = () => { const next = releases.pop(); assert.ok(next); next(); };
  return { path, reads, inputs, createEngine, start, release, releaseLast };
}
test('a long versioned turn does not block another session from materializing and executing', { timeout: 6000 }, async t => {
  const f = await fixture(t); const a = await f.createEngine('a'); const b = await f.createEngine('b');
  const first = f.start(a.engine, claimed('space-first', 1)); await waitFor(() => f.reads.length === 1, 'first runner');
  const second = f.start(b.engine, claimed('space-second', 2, 'other-conversation'));
  await waitFor(() => f.reads.length === 2, 'second runner while first is active');
  assert.deepEqual(f.reads, ['Version 1 instructions.', 'Version 2 instructions.']);
  f.releaseLast(); await second;
  assert.equal(b.store.getDelivery('space-second')?.state, 'done');
  assert.notEqual(a.store.getDelivery('space-first')?.state, 'done');
  f.release(); await first;
  assert.equal(a.store.getDelivery('space-first')?.state, 'done');
  assert.equal(await readFile(f.path, 'utf8'), 'Version 2 instructions.');
});
test('a delivery without versioned context executes while a versioned turn is active', { timeout: 6000 }, async t => {
  const f = await fixture(t); const a = await f.createEngine('a');
  const first = f.start(a.engine, claimed('space-versioned', 1)); await waitFor(() => f.reads.length === 1, 'versioned runner');
  const plain = { ...delivery('space-plain'), ...conversation({ conversationId: 'plain-conversation' }) };
  const second = f.start(a.engine, plain as ReturnType<typeof claimed>);
  await waitFor(() => f.reads.length === 2, 'plain runner while versioned turn is active');
  f.releaseLast(); await second;
  assert.equal(a.store.getDelivery('space-plain')?.state, 'done');
  assert.notEqual(a.store.getDelivery('space-versioned')?.state, 'done');
  f.release(); await first;
  assert.equal(a.store.getDelivery('space-versioned')?.state, 'done');
});
test('deliveries of one session still serialize through the session reservation', { timeout: 6000 }, async t => {
  const f = await fixture(t); const a = await f.createEngine('a');
  const first = f.start(a.engine, claimed('space-session-first', 1)); await waitFor(() => f.reads.length === 1, 'first runner');
  const second = f.start(a.engine, claimed('space-session-second', 2));
  await waitFor(() => a.events.some(event => event.delivery_id === 'space-session-second' && event.claim_renewal === true), 'session queue renewal');
  assert.equal(f.reads.length, 1);
  assert.equal(a.store.getDelivery('space-session-second')?.state, 'accepted');
  f.release(); await first; await waitFor(() => f.reads.length === 2, 'second runner');
  assert.deepEqual(f.reads, ['Version 1 instructions.', 'Version 2 instructions.']); f.release(); await second;
});
test('an external edit during execution fails without a false context adoption', { timeout: 6000 }, async t => {
  const f = await fixture(t, 2000, true); const a = await f.createEngine('a');
  const running = f.start(a.engine, claimed('space-drift', 1)); await waitFor(() => f.reads.length === 1, 'runner before external edit');
  await writeFile(f.path, 'Externally changed instructions.'); f.release(); await running;
  const failed = a.events.find(event => event.delivery_id === 'space-drift' && event.phase === 'failed');
  assert.equal(failed?.error?.code, 'VERSIONED_CONTEXT_CHANGED');
  assert.equal(a.events.some(event => event.delivery_id === 'space-drift' && event.phase === 'done'), false);
  assert.equal(a.events.some(event => event.context_adoption !== undefined), false);
  assert.equal(a.store.getDelivery('space-drift')?.state, 'failed');
});
test('an unchanged materialized context preserves a matching consumption witness and its adoption receipt', { timeout: 6000 }, async t => {
  const f = await fixture(t, 2000, true); const a = await f.createEngine('a');
  const running = f.start(a.engine, claimed('space-consumed', 1)); await waitFor(() => f.reads.length === 1, 'consuming runner');
  f.release(); await running;
  const done = a.events.find(event => event.phase === 'done'); assert.ok(done?.harness_consumption_v1);
  assert.deepEqual(done.context_adoption, { version: 1, digest: context(1).digest, input_sha256: done.harness_consumption_v1.input_sha256 });
});
test('invalid versioned context scope is rejected before any space materialization or execution', async t => {
  const f = await fixture(t); const a = await f.createEngine('a'); const input = claimed('space-foreign', 1);
  await f.start(a.engine, { ...input, versioned_context: { ...input.versioned_context, tenant_id: 'Foreign' } });
  assert.equal(f.reads.length, 0); await assert.rejects(() => readFile(f.path), { code: 'ENOENT' });
  assert.equal(a.events.at(-1)?.error?.code, 'INVALID_VERSIONED_CONTEXT');
});
test('without a space, a witnessed turn that carried the whole context inline accredits its adoption', { timeout: 6000 }, async t => {
  const f = await fixture(t, 2000, true, false); const a = await f.createEngine('a');
  const running = f.start(a.engine, claimed('inline-consumed', 2)); await waitFor(() => f.reads.length === 1, 'inline runner');
  f.release(); await running;
  assert.deepEqual(f.reads, ['absent']);
  assert.match(f.inputs[0] ?? '', /Version 2 instructions\./u);
  const done = a.events.find(event => event.phase === 'done'); assert.ok(done?.harness_consumption_v1);
  assert.deepEqual(done.context_adoption, { version: 2, digest: context(2).digest, input_sha256: done.harness_consumption_v1.input_sha256 });
});
test('without a space, a context too large to travel whole is never accredited', { timeout: 6000 }, async t => {
  const f = await fixture(t, 2000, true, false); const a = await f.createEngine('a');
  const files = [{ path: 'context/mission.md', content: 'x'.repeat(70_000) }];
  const large = { ...context(3), files, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
  const running = f.start(a.engine, { ...claimed('inline-too-large', 3), versioned_context: large });
  await waitFor(() => f.reads.length === 1, 'large inline runner'); f.release(); await running;
  const done = a.events.find(event => event.phase === 'done'); assert.ok(done?.harness_consumption_v1);
  assert.equal(done.context_adoption, undefined);
});
test('without a consumption witness no context is accredited, inline or materialized', { timeout: 6000 }, async t => {
  const f = await fixture(t, 2000, false, false); const a = await f.createEngine('a');
  const running = f.start(a.engine, claimed('inline-unwitnessed', 1)); await waitFor(() => f.reads.length === 1, 'unwitnessed runner');
  f.release(); await running;
  const done = a.events.find(event => event.phase === 'done'); assert.ok(done);
  assert.equal(done.harness_consumption_v1, undefined); assert.equal(done.context_adoption, undefined);
});
