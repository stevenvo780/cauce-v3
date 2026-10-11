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
function barrier() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
async function fixture(t: TestContext, queueWaitTimeoutMs = 2000, withWitness = false) {
  const root = await mkdtemp(join(tmpdir(), 'cauce-space-turn-'));
  const space = join(root, 'space'); const path = join(space, 'context/mission.md');
  const previous = process.env.CAUCE_SPACE_ROOT; process.env.CAUCE_SPACE_ROOT = space;
  const reads: string[] = []; const releases: (() => void)[] = []; const executions: Promise<void>[] = [];
  const engines: AdapterEngine[] = []; let releasing = false;
  const runner: CommandRunner = { run: async input => {
    reads.push(await readFile(path, 'utf8'));
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
  const createEngine = async (id: string, withoutSessionReservation = false) => {
    const store = await DurableStore.open(join(root, id)); const events: DeliveryEvent[] = [];
    const definition = withWitness ? codexDefinition : fakeDefinition;
    const harness = new HarnessAdapter({ definition: withoutSessionReservation ? { ...definition, sessionStrategy: { kind: 'none' } } : definition, runner, store });
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
  return { path, reads, createEngine, start, release };
}
for (const mode of ['same-session', 'different-sessions', 'different-engines', 'without-session-reservation'] as const) {
  test(`versioned context remains stable throughout an active turn with ${mode}`, { timeout: 6000 }, async t => {
    const f = await fixture(t); const a = await f.createEngine('a', mode === 'without-session-reservation');
    const b = mode === 'different-engines' ? await f.createEngine('b') : a;
    const first = f.start(a.engine, claimed('space-first', 1)); await waitFor(() => f.reads.length === 1, 'first runner');
    const second = f.start(b.engine, claimed('space-second', 2, mode === 'same-session' ? 'shared-conversation' : 'other-conversation'));
    await waitFor(() => b.events.some(event => event.delivery_id === 'space-second' && event.claim_renewal === true), 'accepted queue renewal');
    assert.equal(await readFile(f.path, 'utf8'), 'Version 1 instructions.'); assert.equal(f.reads.length, 1);
    assert.equal(b.store.getDelivery('space-second')?.state, 'accepted');
    assert.equal(b.events.some(event => event.delivery_id === 'space-second' && event.phase === 'started'), false);
    f.release(); await first; await waitFor(() => f.reads.length === 2, 'second runner');
    assert.deepEqual(f.reads, ['Version 1 instructions.', 'Version 2 instructions.']); f.release(); await second;
  });
}
for (const mode of ['cancel', 'timeout'] as const) {
  test(`a ${mode} while awaiting the shared space never materializes its context and releases its reservation`, { timeout: 6000 }, async t => {
    const f = await fixture(t, mode === 'timeout' ? 100 : 2000); const a = await f.createEngine('a');
    const first = f.start(a.engine, claimed('space-blocker', 1)); await waitFor(() => f.reads.length === 1, 'blocking runner');
    const second = f.start(a.engine, claimed('space-queued', 2, 'other-conversation'));
    await waitFor(() => a.events.some(event => event.delivery_id === 'space-queued' && event.claim_renewal === true), 'queue heartbeat');
    if (mode === 'cancel') await a.engine.cancel({ type: 'cancel', delivery_id: 'space-queued', epoch: 1 });
    await waitFor(() => a.store.getDelivery('space-queued')?.state === 'failed', 'aborted space waiter', 2000);
    await second;
    assert.equal(await readFile(f.path, 'utf8'), 'Version 1 instructions.'); assert.equal(f.reads.length, 1);
    assert.equal(a.events.some(event => event.delivery_id === 'space-queued' && event.phase === 'started'), false);
    assert.equal(a.events.find(event => event.delivery_id === 'space-queued' && event.phase === 'failed')?.error?.code,
      mode === 'cancel' ? 'CANCELLED' : 'SESSION_QUEUE_TIMEOUT');
    f.release(); await first;
    const third = f.start(a.engine, claimed('space-next', 3, 'third-conversation'));
    await waitFor(() => f.reads.length === 2, 'runner after aborted waiter'); f.release(); await third;
    assert.equal(await readFile(f.path, 'utf8'), 'Version 3 instructions.');
  });
}
test('the space reservation remains held until the completed delivery is persisted', { timeout: 6000 }, async t => {
  const entered = barrier(); const persist = barrier();
  t.after(() => { persist.open(); });
  const f = await fixture(t); const a = await f.createEngine('a');
  const transition = a.store.transitionAndEnqueue.bind(a.store);
  a.store.transitionAndEnqueue = async (...args) => {
    if (args[0] === 'space-persist' && args[1] === 'done') { entered.open(); await persist.promise; }
    return transition(...args);
  };
  const first = f.start(a.engine, claimed('space-persist', 1)); await waitFor(() => f.reads.length === 1, 'first runner');
  f.release(); await entered.promise;
  const second = f.start(a.engine, claimed('space-after', 2, 'other-conversation'));
  await waitFor(() => a.events.some(event => event.delivery_id === 'space-after' && event.claim_renewal === true), 'persistence queue');
  assert.equal(f.reads.length, 1); assert.equal(await readFile(f.path, 'utf8'), 'Version 1 instructions.');
  persist.open(); await first; await waitFor(() => f.reads.length === 2, 'runner after persistence'); f.release(); await second;
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
