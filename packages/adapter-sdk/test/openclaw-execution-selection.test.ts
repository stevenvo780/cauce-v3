import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    CAUCE_OPENCLAW_WORKSPACE: '/workspace/isolated', CAUCE_OPENCLAW_AGENT_ID: 'main', CAUCE_OPENCLAW_LOCAL: '1', OPENCLAW_AUTH_TOKEN: 'secret' });
  assert.equal(env.OPENCLAW_STATE_DIR, '/profiles/isolated');
  assert.equal(env.OPENCLAW_HOME, '/profiles/isolated');
  assert.equal(env.OPENCLAW_AGENT_DIR, '/profiles/isolated/agent');
  assert.equal(env.CAUCE_OPENCLAW_AGENT_ID, 'main');
  assert.equal(env.CAUCE_OPENCLAW_WORKSPACE, '/workspace/isolated');
  assert.equal(env.CAUCE_OPENCLAW_LOCAL, '1');
  assert.equal(env.OPENCLAW_AUTH_TOKEN, undefined);
});
test('OpenClaw loopback API rejects unsupported explicit selection before reading credentials or dispatch', async () => {
  const runner = new OpenClawApiRunner({ endpoint: 'http://127.0.0.1:1/v1/chat/completions', tokenFile: '/nonexistent/credentials' });
  await assert.rejects(runner.run({ command: 'unused', args: [], harness: 'openclaw', stdin: 'private prompt', timeoutMs: 5000,
    signal: new AbortController().signal, executionSelection: { modelId: 'test/model', reasoningEffort: 'high' } }),
  { code: 'OPENCLAW_API_SELECTION_UNSUPPORTED' });
});
