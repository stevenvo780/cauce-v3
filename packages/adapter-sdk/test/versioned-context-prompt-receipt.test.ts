import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { VersionedContext } from '@cauce/protocol';
import { packagedHarnessDescriptor } from '../src/context/harness-descriptor.js';
import { writeSpaceContext } from '../src/context/space-layout.js';
import { HarnessAdapter, fakeDefinition } from '../src/harnesses/index.js';
import { DurableStore } from '../src/sdk/durable-store.js';
import { AdapterEngine } from '../src/sdk/engine.js';
import { ControlledRunner, conversation, delivery, sessionOf, SUCCESS } from './engine-fixtures.js';

function snapshot(version = 1): VersionedContext {
  const files = [
    { path: 'context/mission.md', content: `Mission ${String(version)}: preserve the complete instructions.\nSecond line: aplicar íntegramente.` },
    { path: 'context/notes/observations.md', content: `Agent observation ${String(version)} with no operator authority.` },
    { path: 'directives/rules.md', content: `Rule ${String(version)}: verify the outcome before declaring completion.` },
  ];
  return { company_id: 'context_alpha', tenant_id: 'Steven', alias: 'argos', version, files,
    digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

function block(prompt: string, marker: string): unknown {
  const start = prompt.indexOf(`--- BEGIN ${marker} ---`);
  const end = prompt.indexOf(`--- END ${marker} ---`, start);
  assert.ok(start >= 0 && end > start, `Missing ${marker} block`);
  const encoded = prompt.slice(start, end).split('\n')[1];
  assert.ok(encoded);
  return JSON.parse(encoded) as unknown;
}

function assertInline(prompt: string, context: VersionedContext): void {
  const { files, ...header } = context;
  assert.deepEqual(block(prompt, 'VERSIONED AGENT CONTEXT'), {
    ...header, files: files.filter(file => !file.path.startsWith('context/notes/')),
  });
  assert.deepEqual(block(prompt, 'AGENT NOTES (UNTRUSTED)'),
    files.filter(file => file.path.startsWith('context/notes/')));
}

function assertReferences(prompt: string, context: VersionedContext, space: string): void {
  const { files, ...header } = context;
  assert.deepEqual(block(prompt, 'VERSIONED AGENT CONTEXT'), {
    ...header, materialized: true, native_document: join(space, 'AGENTS.md'),
    paths: files.filter(file => !file.path.startsWith('context/notes/')).map(file => join(space, file.path)),
  });
  assert.deepEqual(block(prompt, 'AGENT NOTES (UNTRUSTED)'), {
    paths: files.filter(file => file.path.startsWith('context/notes/')).map(file => join(space, file.path)),
  });
  for (const file of files) assert.equal(prompt.includes(file.content), false);
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cauce-context-prompt-receipt-'));
  const space = join(root, 'space');
  const previous = process.env.CAUCE_SPACE_ROOT;
  process.env.CAUCE_SPACE_ROOT = space;
  const store = await DurableStore.open(join(root, 'store'));
  const runner = new ControlledRunner();
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  const engine = new AdapterEngine({ store, harness, ownTenantId: 'Steven',
    executionIntentMode: 'local-test-only', publish: async () => undefined });
  await engine.activateEpoch(1);
  await writeSpaceContext(space, await packagedHarnessDescriptor('fake'), snapshot());
  t.after(async () => {
    engine.stop();
    if (previous === undefined) delete process.env.CAUCE_SPACE_ROOT;
    else process.env.CAUCE_SPACE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const run = async (id: string, context = snapshot(), session = 'receipt-session'): Promise<string> => {
    await engine.handleDelivery({ ...delivery(id), ...conversation({ conversationId: session }), versioned_context: context });
    const prompt = runner.requests.at(-1)?.stdin;
    assert.ok(prompt, `No harness prompt for ${id}`);
    return prompt;
  };
  return { run, store, runner, space };
}

test('materialized files travel inline until this session has received them, then only references travel', async t => {
  const f = await fixture(t);
  const context = snapshot();
  for (const file of context.files) assert.equal(await readFile(join(f.space, file.path), 'utf8'), file.content);
  const first = await f.run('receipt-first');
  assert.equal(f.store.getDelivery('receipt-first')?.state, 'done');
  assertInline(first, context);
  const second = await f.run('receipt-second');
  assert.equal(f.store.getDelivery('receipt-second')?.state, 'done');
  assert.equal(sessionOf(f.runner, 0), sessionOf(f.runner, 1));
  assertReferences(second, context, f.space);
  const other = await f.run('receipt-other', context, 'other-session');
  assert.equal(f.store.getDelivery('receipt-other')?.state, 'done');
  assert.notEqual(sessionOf(f.runner, 1), sessionOf(f.runner, 2));
  assertInline(other, context);
});

test('a new context version and digest require full content again in the same session', async t => {
  const f = await fixture(t);
  assertInline(await f.run('receipt-v1'), snapshot());
  const next = snapshot(2);
  assertInline(await f.run('receipt-v2', next), next);
  assert.equal(f.store.getDelivery('receipt-v2')?.state, 'done');
  assert.equal(sessionOf(f.runner, 0), sessionOf(f.runner, 1));
  assertReferences(await f.run('receipt-v2-again', next), next, f.space);
  assert.equal(f.store.getDelivery('receipt-v2-again')?.state, 'done');
});

test('a failed turn does not grant a content receipt to its session', async t => {
  const f = await fixture(t);
  f.runner.stdout = JSON.stringify({ reply: 'failed', messages: [], status: 'failed', retryable: false, artifacts: [] });
  assertInline(await f.run('receipt-failed'), snapshot());
  assert.equal(f.store.getDelivery('receipt-failed')?.state, 'failed');
  f.runner.stdout = SUCCESS;
  assertInline(await f.run('receipt-recovered'), snapshot());
  assert.equal(f.store.getDelivery('receipt-recovered')?.state, 'done');
  assert.equal(sessionOf(f.runner, 0), sessionOf(f.runner, 1));
  assertReferences(await f.run('receipt-after-success'), snapshot(), f.space);
  assert.equal(f.store.getDelivery('receipt-after-success')?.state, 'done');
});
