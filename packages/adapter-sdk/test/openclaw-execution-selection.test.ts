import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { executionSelection, projectSelectionArguments, selectionArguments } from '../src/sdk/execution-selection.js';
import { OpenClawApiRunner } from '../src/sdk/openclaw-api-runner.js';
import { childEnvironment, SpawnCommandRunner } from '../src/sdk/process-runner.js';

const bridge = fileURLToPath(new URL('../bridge/openclaw-stdin-bridge.mjs', import.meta.url));
async function modules(directory: string): Promise<void> {
  await writeFile(join(directory, 'runtime-fixture.js'), 'export const defaultRuntime={};\n');
  await writeFile(join(directory, 'agent-via-gateway-fixture.js'), `
export async function agentCliCommand(options) {
  return {result:{payloads:[{text:JSON.stringify({reply:JSON.stringify({model:options.model,thinking:options.thinking,
    agent:options.agent,sessionKey:options.sessionKey,deliver:options.deliver,local:options.local,state:process.env.OPENCLAW_STATE_DIR,
    agentDir:process.env.OPENCLAW_AGENT_DIR,workspace:process.env.CAUCE_OPENCLAW_WORKSPACE}),messages:[],status:'done',retryable:false,artifacts:[]})}]}};
}\n`);
}
test('OpenClaw selected model and effort reach the native bridge request and exact isolated profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openclaw-selection-'));
  try {
    await modules(directory);
    const selection = { modelId: 'anthropic/test-model', reasoningEffort: 'high' };
    const result = await new SpawnCommandRunner().run({ command: process.execPath,
      args: [bridge, '--session-key', 'agent:test-agent:isolated', ...selectionArguments('openclaw', selection)],
      executionSelection: selection, harness: 'openclaw', stdin: 'private prompt', timeoutMs: 5000,
      signal: new AbortController().signal, env: { CAUCE_OPENCLAW_DIST_DIR: directory,
        CAUCE_OPENCLAW_AGENT_ID: 'test-agent', CAUCE_OPENCLAW_LOCAL: '1', OPENCLAW_STATE_DIR: join(directory, 'state'),
        OPENCLAW_AGENT_DIR: join(directory, 'state/agents/test-agent/agent'), CAUCE_OPENCLAW_WORKSPACE: join(directory, 'workspace') } });
    assert.equal(result.exitCode, 0, result.stderr);
    const envelope = JSON.parse(result.stdout) as { result: { result: { payloads: { text: string }[] } } };
    const structured = JSON.parse(envelope.result.result.payloads[0]?.text ?? '{}') as { reply: string };
    assert.deepEqual(JSON.parse(structured.reply), { model: selection.modelId, thinking: selection.reasoningEffort,
      agent: 'test-agent', sessionKey: 'agent:test-agent:isolated', deliver: false, local: true, state: join(directory, 'state'),
      agentDir: join(directory, 'state/agents/test-agent/agent'), workspace: join(directory, 'workspace') });
    assert.ok(result.invocationWitness);
    assert.equal(result.invocationWitness.modelId, selection.modelId);
    assert.equal(result.invocationWitness.reasoningEffort, selection.reasoningEffort);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('OpenClaw leaves the selected model to its configured default only when that default carries the fallback chain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openclaw-selection-fallback-'));
  try {
    await modules(directory);
    const selection = { modelId: 'xai/grok-4.7', reasoningEffort: 'high' };
    const chain = { primary: 'xai/grok-4.7', fallbacks: ['muse-cli/muse-spark-1.3'] };
    const cases: [Record<string, unknown>, string | undefined][] = [
      [{ agents: { defaults: { model: chain }, list: [{ id: 'test-agent' }] } }, undefined],
      [{ agents: { defaults: { model: chain }, list: [{ id: 'test-agent', model: 'xai/grok-4.7' }] } }, selection.modelId],
      [{ agents: { defaults: { model: { ...chain, primary: 'xai/other' } }, list: [{ id: 'test-agent' }] } }, selection.modelId],
      [{ agents: { defaults: { model: { ...chain, fallbacks: [] } }, list: [{ id: 'test-agent' }] } }, selection.modelId],
    ];
    for (const [config, model] of cases) {
      await writeFile(join(directory, 'openclaw.json'), JSON.stringify(config));
      const result = await new SpawnCommandRunner().run({ command: process.execPath,
        args: [bridge, '--session-key', 'agent:test-agent:isolated', ...selectionArguments('openclaw', selection)],
        executionSelection: selection, harness: 'openclaw', stdin: 'private prompt', timeoutMs: 5000,
        signal: new AbortController().signal, env: { CAUCE_OPENCLAW_DIST_DIR: directory, CAUCE_OPENCLAW_AGENT_ID: 'test-agent',
          CAUCE_OPENCLAW_LOCAL: '1', OPENCLAW_CONFIG_PATH: join(directory, 'openclaw.json') } });
      assert.equal(result.exitCode, 0, result.stderr);
      const envelope = JSON.parse(result.stdout) as { result: { result: { payloads: { text: string }[] } } };
      const reply = JSON.parse((JSON.parse(envelope.result.result.payloads[0]?.text ?? '{}') as { reply: string }).reply) as { model?: string; thinking?: string };
      assert.equal(reply.model, model);
      assert.equal(reply.thinking, selection.reasoningEffort);
      assert.equal(result.invocationWitness?.modelId, selection.modelId);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('OpenClaw model and thinking cannot be duplicated or silently projected into another flag', () => {
  assert.deepEqual(selectionArguments('openclaw', { modelId: 'test/model', reasoningEffort: 'xhigh' }),
    ['--model', 'test/model', '--thinking', 'xhigh']);
  for (const arguments_ of [['--model=another'], ['-m', 'another'], ['--thinking', 'low'], ['--thinking=low']]) {
    assert.throws(() => projectSelectionArguments('openclaw', arguments_, { modelId: 'test/model', reasoningEffort: 'high' }), /conflict/u);
  }
  assert.throws(() => executionSelection('openclaw', { reasoningEffort: 'ultra' }), /unsupported/u);
});
test('raw bridge rejects invalid and duplicate selection before native execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openclaw-selection-negative-'));
  try {
    await modules(directory);
    for (const args of [['--model', 'good/model', '--model=other/model'], ['--thinking', 'ultra'], ['--model']]) {
      const result = await new SpawnCommandRunner().run({ command: process.execPath, args: [bridge, ...args], harness: 'openclaw',
        stdin: 'private prompt', timeoutMs: 5000, signal: new AbortController().signal,
        env: { CAUCE_OPENCLAW_DIST_DIR: directory } });
      assert.notEqual(result.exitCode, 0);
      assert.doesNotMatch(result.stderr, /<<cauce:harness-started>>/u);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('only approved OpenClaw profile paths cross the child environment boundary', () => {
  const env = childEnvironment(undefined, undefined, { OPENCLAW_HOME: '/profiles/isolated', OPENCLAW_STATE_DIR: '/profiles/isolated', OPENCLAW_AGENT_DIR: '/profiles/isolated/agent',
    CAUCE_OPENCLAW_WORKSPACE: '/workspace/isolated', CAUCE_OPENCLAW_AGENT_ID: 'main', CAUCE_OPENCLAW_LOCAL: '1', OPENCLAW_AUTH_TOKEN: 'secret',
    TMPDIR: '/profiles/isolated/tmp', NODE_COMPILE_CACHE: '/profiles/isolated/tmp/node-compile-cache' });
  assert.equal(env.OPENCLAW_STATE_DIR, '/profiles/isolated');
  assert.equal(env.OPENCLAW_HOME, '/profiles/isolated');
  assert.equal(env.OPENCLAW_AGENT_DIR, '/profiles/isolated/agent');
  assert.equal(env.CAUCE_OPENCLAW_AGENT_ID, 'main');
  assert.equal(env.CAUCE_OPENCLAW_WORKSPACE, '/workspace/isolated');
  assert.equal(env.CAUCE_OPENCLAW_LOCAL, '1');
  assert.equal(env.TMPDIR, '/profiles/isolated/tmp');
  assert.equal(env.NODE_COMPILE_CACHE, '/profiles/isolated/tmp/node-compile-cache');
  assert.equal(env.OPENCLAW_AUTH_TOKEN, undefined);
});
test('OpenClaw loopback API rejects unsupported explicit selection before reading credentials or dispatch', async () => {
  const runner = new OpenClawApiRunner({ endpoint: 'http://127.0.0.1:1/v1/chat/completions', tokenFile: '/nonexistent/credentials' });
  await assert.rejects(runner.run({ command: 'unused', args: [], harness: 'openclaw', stdin: 'private prompt', timeoutMs: 5000,
    signal: new AbortController().signal, executionSelection: { modelId: 'test/model', reasoningEffort: 'high' } }),
  { code: 'OPENCLAW_API_SELECTION_UNSUPPORTED' });
});
async function blockingModules(directory: string, withReset: boolean): Promise<void> {
  await writeFile(join(directory, 'runtime-fixture.js'), 'export const defaultRuntime={};\n');
  await writeFile(join(directory, 'agent-via-gateway-fixture.js'), `
import { appendFileSync } from 'node:fs';
const advice = 'Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.';
export async function agentCliCommand(options) {
  appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))}, JSON.stringify({ message: options.message, sessionKey: options.sessionKey }) + '\\n');
  if (!options.message.startsWith('[Cauce]')) {
    return { payloads: [{ text: advice, isError: true }], meta: { livenessState: 'blocked', error: { kind: 'compaction_failure', message: 'timed out' } } };
  }
  return { payloads: [{ text: JSON.stringify({ reply: 'recuperado', messages: [], status: 'done', retryable: false, artifacts: [] }) }] };
}\n`);
  if (withReset) await writeFile(join(directory, 'sessions.runtime-fixture.js'), `
import { writeFileSync } from 'node:fs';
export async function performGatewaySessionReset(params) {
  writeFileSync(${JSON.stringify(join(directory, 'reset.json'))}, JSON.stringify(params));
  return { ok: true, key: params.key, entry: { sessionId: 'fresh' } };
}\n`);
}
async function runBlocked(directory: string) {
  return new SpawnCommandRunner().run({ command: process.execPath, args: [bridge, '--session-key', 'room-7'],
    harness: 'openclaw', stdin: 'despliega Praxis Pro', timeoutMs: 5000, signal: new AbortController().signal,
    env: { CAUCE_OPENCLAW_DIST_DIR: directory, CAUCE_OPENCLAW_AGENT_ID: 'operador', CAUCE_OPENCLAW_LOCAL: '1' } });
}
test('a session OpenClaw gave up on for its context is reset once and the same message retried in a fresh one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openclaw-context-reset-'));
  try {
    await blockingModules(directory, true);
    const result = await runBlocked(directory);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'reset.json'), 'utf8')),
      { key: 'agent:operador:room-7', agentId: 'operador', reason: 'new', commandSource: 'cauce:context-overflow' });
    const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { message: string; sessionKey: string });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.message, 'despliega Praxis Pro');
    assert.match(calls[1]?.message ?? '', /^\[Cauce\] Tu sesión anterior se llenó[\s\S]*\n\ndespliega Praxis Pro$/u);
    assert.equal(calls[1]?.sessionKey, 'room-7');
    const envelope = JSON.parse(result.stdout) as { result: { payloads: { text: string }[] } };
    assert.equal((JSON.parse(envelope.result.payloads[0]?.text ?? '{}') as { reply: string }).reply, 'recuperado');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('without OpenClaw reset service a context-blocked turn is reported once, never looped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openclaw-context-noreset-'));
  try {
    await blockingModules(directory, false);
    const result = await runBlocked(directory);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal((await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').length, 1);
    const envelope = JSON.parse(result.stdout) as { result: { meta: { error: { kind: string } } } };
    assert.equal(envelope.result.meta.error.kind, 'compaction_failure');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
