import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { grokDefinition } from '../src/harnesses/grok.js';
import { executionSelection, projectSelectionArguments, selectionArguments, witnessForInvocation } from '../src/sdk/execution-selection.js';
import { SpawnCommandRunner } from '../src/sdk/process-runner.js';
import { verifyGrokConsumption } from '../src/sdk/headless-consumption.js';
import { parseGrokOutput } from '../src/sdk/output-parser.js';
import type { CommandRunRequest, CommandRunResult } from '../src/sdk/types.js';
import { matchingConsumptionWitness, inputDigest } from '../src/shared-session/consumption.js';
import { cliSharedSessionSpec, loadSharedSessionConfig } from '../src/shared-session/config.js';
import { paneCommandMatches } from '../src/shared-session/session/identity.js';
import { paneEnvironmentPrefix } from '../src/shared-session/session.js';
import { shellQuote } from '../src/shared-session/pane-environment.js';
import { prepareMuseProfile } from '../src/shared-session/muse-profile.js';
import { CliTmux } from '../src/shared-session/tmux.js';

test('Grok projects an explicit model but keeps unmeasured reasoning effort unsupported', () => {
  assert.deepEqual(selectionArguments('grok', { modelId: 'approved/model' }), ['--model', 'approved/model']);
  assert.throws(() => executionSelection('grok', { reasoningEffort: 'high' }), /unsupported/u);
  assert.deepEqual(selectionArguments('grok', {}), []);
  assert.equal(grokDefinition.startWitness, undefined);
});

test('Muse projects the measured reasoning flag and rejects aliases, duplicate and ambiguous flags', () => {
  for (const reasoningEffort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.deepEqual(selectionArguments('muse', { modelId: 'approved/model', reasoningEffort }),
      ['--model', 'approved/model', '--reasoning-effort', reasoningEffort]);
  }
  const selection = { modelId: 'approved/model', reasoningEffort: 'xhigh' };
  for (const flag of ['--reasoning-effort', '--reasoning-effort=high', '--effort', '--thinking']) {
    assert.throws(() => projectSelectionArguments('muse', [flag, 'high'], selection), /conflicts/u);
  }
  assert.throws(() => executionSelection('muse', { reasoningEffort: 'turbo' }), /unsupported/u);
  const request = { command: '/approved/muse', args: ['exec', ...selectionArguments('muse', selection), '--reasoning-effort=high'],
    harness: 'muse' as const, stdin: 'prompt', timeoutMs: 1000, signal: new AbortController().signal, executionSelection: selection };
  assert.throws(() => witnessForInvocation(request), /ambiguous/u);
});

for (const harness of ['grok', 'muse'] as const) test(`${harness} invocation witness follows argv executed by a pinned local child`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-muse-selection-'));
  try {
    const command = join(directory, 'provider.mjs');
    const source = `#!${process.execPath}\nprocess.stdin.resume();console.log(JSON.stringify(process.argv.slice(2)));\n`;
    await writeFile(command, source, { mode: 0o700 });
    const selection = { modelId: 'approved/model', ...(harness === 'muse' ? { reasoningEffort: 'xhigh' } : {}) };
    const args = selectionArguments(harness, selection);
    const result = await new SpawnCommandRunner().run({ command, args, harness, stdin: 'Local contract only', timeoutMs: 5000,
      signal: new AbortController().signal, executionSelection: selection,
      commandPins: { command, sha256: createHash('sha256').update(source).digest('hex'), files: {} } });
    assert.equal(result.exitCode, 0); assert.deepEqual(JSON.parse(result.stdout), args);
    assert.equal(result.invocationWitness?.modelId, selection.modelId);
    assert.equal(result.invocationWitness.reasoningEffort, harness === 'muse' ? 'xhigh' : null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const environment = { HOME: '/home/dev', XDG_CONFIG_HOME: '/profiles/account/config', XDG_DATA_HOME: '/profiles/account/data',
  CAUCE_MODEL_ID: 'approved/model', CAUCE_REASONING_EFFORT: 'xhigh' };

test('Muse CLI and adapter share the same dedicated config/data binding and one durable effort', () => {
  const spec = cliSharedSessionSpec('muse', 'hegel', '/workspace', '/home/dev', environment);
  const adapter = loadSharedSessionConfig('muse', 'hegel', '/state/hegel', { ...environment, CAUCE_SHARED_SESSION: '1' });
  assert.ok(adapter);
  assert.deepEqual(spec.environment, { XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME, XDG_DATA_HOME: environment.XDG_DATA_HOME, MUSE_NO_AUTO_UPDATE: '1' });
  assert.deepEqual(spec.environment, adapter.paneEnvironment); assert.equal(adapter.configDirectory, '/profiles/account/data/muse');
  assert.deepEqual(spec.harnessArguments, ['--yolo', '--trust-workspace', '--model', 'approved/model', '--reasoning-effort', 'xhigh']);
  assert.deepEqual(spec.unsetEnvironment, ['META_API_KEY', 'MUSE_AUTH_PATH', 'MUSE_CONFIG_DIR']);
  const prefix = paneEnvironmentPrefix(spec.environment, spec.unsetEnvironment); assert.equal(prefix.ok, true);
  const command = `exec ${prefix.prefix}muse ${spec.harnessArguments.join(' ')}`;
  assert.equal(paneCommandMatches(spec, command), true);
  assert.equal(paneCommandMatches(spec, command.replace('/profiles/account/config', '/profiles/other/config')), false);
  assert.equal(paneCommandMatches(spec, command + ' --reasoning-effort=high'), false);
  assert.equal(paneCommandMatches(spec, command.replace('-u META_API_KEY ', '')), false);
  assert.equal(paneCommandMatches(spec, 'exec muse --model approved/model --reasoning-effort xhigh'), false);
});

test('Grok panes require the exact dedicated GROK_HOME before adopting an existing process', () => {
  const spec = cliSharedSessionSpec('grok', 'hades', '/workspace', '/home/fixture',
    { GROK_HOME: '/profiles/correct', CAUCE_MODEL_ID: 'approved/model' });
  const command = "exec env GROK_HOME='/profiles/correct' grok --always-approve --model approved/model";
  assert.equal(paneCommandMatches(spec, command), true);
  assert.equal(paneCommandMatches(spec, command.replace('/profiles/correct', '/profiles/foreign')), false);
  assert.equal(paneCommandMatches(spec, command.replace("env GROK_HOME='/profiles/correct' ", '')), false);
  assert.equal(paneCommandMatches(spec, command.replace("GROK_HOME='/profiles/correct'", "GROK_HOME='/profiles/correct' GROK_HOME='/profiles/foreign'")), false);
  assert.equal(paneCommandMatches(spec, "env GROK_HOME='/profiles/correct' bash -c \"exec env GROK_HOME='/profiles/foreign' grok --model approved/model\""), false);
});

test('real tmux preserves a foreign Grok profile process and only accredits the exact pane environment', async () => {
  const tmux = new CliTmux(`cauce-grok-profile-${String(process.pid)}-${randomUUID().slice(0, 8)}`);
  const spec = { ...cliSharedSessionSpec('grok', 'hades', '/tmp', '/home/fixture', { GROK_HOME: '/profiles/correct' }), command: 'sleep' };
  const command = "exec env GROK_HOME='/profiles/foreign' sleep 30";
  try {
    const created = await tmux.run(['new-session', '-d', '-s', 'cauce-hades', '-n', 'agente', '-P', '-F', '#{pane_id}', '/bin/bash', '-lc', command]);
    assert.equal(created.exitCode, 0, created.stderr); const pane = created.stdout.trim(); assert.match(pane, /^%[0-9]+$/u);
    const before = await tmux.run(['display-message', '-p', '-t', pane, '#{pane_pid}']); assert.equal(before.exitCode, 0);
    const observed = await tmux.run(['display-message', '-p', '-t', pane, '#{pane_start_command}']); assert.equal(observed.exitCode, 0);
    assert.equal(paneCommandMatches(spec, observed.stdout.trim()), false);
    const after = await tmux.run(['display-message', '-p', '-t', pane, '#{pane_pid}']); assert.equal(after.stdout, before.stdout);
    assert.equal((await tmux.run(['has-session', '-t', '=cauce-hades'])).exitCode, 0);
    const replaced = await tmux.run(['respawn-pane', '-k', '-t', pane, '/bin/bash', '-lc', command.replace('/profiles/foreign', '/profiles/correct')]);
    assert.equal(replaced.exitCode, 0);
    const matching = await tmux.run(['display-message', '-p', '-t', pane, '#{pane_start_command}']); assert.equal(matching.exitCode, 0);
    assert.equal(paneCommandMatches(spec, matching.stdout.trim()), true, matching.stdout);
  } finally { await tmux.run(['kill-server']).catch(() => undefined); }
});

test('Muse rejects partial, split, noncanonical profiles and credential overrides before building a TUI', () => {
  for (const invalid of [
    { XDG_CONFIG_HOME: undefined }, { XDG_DATA_HOME: '/profiles/other/data' }, { XDG_DATA_HOME: '/profiles/account/../account/data' },
    { XDG_CONFIG_HOME: '/home/dev/.config' }, { META_API_KEY: 'fixture-key' }, { MUSE_AUTH_PATH: '/legacy/auth.json' },
    { MUSE_CONFIG_DIR: '/legacy' }, { MUSE_REASONING_EFFORT: 'max' },
  ]) assert.throws(() => cliSharedSessionSpec('muse', 'hegel', '/workspace', '/home/dev', { ...environment, ...invalid }));
});

test('Muse child drops inherited credential overrides and receives the same config/data profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-profile-child-'));
  try {
    const script = join(directory, 'environment.mjs');
    await writeFile(script, 'console.log(JSON.stringify({config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,overrides:["META_API_KEY","MUSE_AUTH_PATH","MUSE_CONFIG_DIR"].filter(key=>process.env[key]!==undefined)}));');
    const spec = cliSharedSessionSpec('muse', 'hegel', '/workspace', '/home/dev', environment);
    const prefix = paneEnvironmentPrefix(spec.environment, spec.unsetEnvironment); assert.equal(prefix.ok, true);
    const result = await new SpawnCommandRunner().run({ command: '/bin/sh',
      args: ['-c', `exec env META_API_KEY=fixture-key MUSE_AUTH_PATH=/fixture/auth.json MUSE_CONFIG_DIR=/fixture/config ${prefix.prefix}${shellQuote(process.execPath)} ${shellQuote(script)}`],
      harness: 'fake', stdin: '', timeoutMs: 5000, signal: new AbortController().signal });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { config: environment.XDG_CONFIG_HOME, data: environment.XDG_DATA_HOME, overrides: [] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Muse profile preparation refuses symlinked directories without creating data behind them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-profile-link-'));
  try {
    const target = join(directory, 'legacy'); const profile = join(directory, 'profile');
    await mkdir(target); await mkdir(profile, { mode: 0o700 }); await symlink(target, join(profile, 'config'));
    await assert.rejects(prepareMuseProfile({ XDG_CONFIG_HOME: join(profile, 'config'), XDG_DATA_HOME: join(profile, 'data') }), /unsafe directory/u);
    await assert.rejects(lstat(join(profile, 'data')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(target, 'muse')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Muse creates private owned profile directories without changing existing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-private-profile-'));
  try {
    const profile = join(directory, 'profile'); const config = join(profile, 'config'); const data = join(profile, 'data');
    await prepareMuseProfile({ XDG_CONFIG_HOME: config, XDG_DATA_HOME: data });
    for (const path of [profile, config, data, join(data, 'muse')]) {
      const details = await lstat(path); assert.equal(details.mode & 0o777, 0o700); assert.equal(details.uid, process.getuid?.());
    }
    const existing = join(config, 'private-file.fixture'); await writeFile(existing, 'synthetic private fixture', { mode: 0o600 });
    const before = await lstat(existing); await prepareMuseProfile({ XDG_CONFIG_HOME: config, XDG_DATA_HOME: data });
    const after = await lstat(existing); assert.equal(after.mode, before.mode); assert.equal(after.mtimeMs, before.mtimeMs);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Muse rejects existing shared profile directories without chmod or writing beneath them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-public-profile-'));
  try {
    for (const component of ['profile', 'config', 'data', 'muse']) for (const mode of [0o755, 0o770, 0o777]) {
      const profile = join(directory, `${component}-${String(mode)}`); const config = join(profile, 'config'); const data = join(profile, 'data');
      for (const path of [profile, config, data]) await mkdir(path, { mode: 0o700 });
      if (component === 'muse') await mkdir(join(data, 'muse'), { mode: 0o700 });
      const unsafe = component === 'profile' ? profile : component === 'muse' ? join(data, 'muse') : join(profile, component);
      await chmod(unsafe, mode);
      await assert.rejects(prepareMuseProfile({ XDG_CONFIG_HOME: config, XDG_DATA_HOME: data }), /unsafe directory/u);
      assert.equal((await lstat(unsafe)).mode & 0o777, mode);
      if (component !== 'muse') await assert.rejects(lstat(join(data, 'muse')), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Grok consumption attests the exact input supplied to its own pinned child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-consumption-'));
  const input = 'desired context';
  try {
    const command = join(directory, 'native-child.mjs');
    const source = `#!${process.execPath}
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const digest = createHash('sha256').update(readFileSync(0)).digest('hex');
console.log(JSON.stringify({text:digest,stopReason:'end_turn',sessionId:'native-session',
 native_turn_id:'fabricated-turn',input_sha256:'fabricated-digest',
 consumptionWitness:{native_session_id:'fabricated-session',native_turn_id:'fabricated-turn'}}));
`;
    await writeFile(command, source, { mode: 0o700 });
    const result = await new SpawnCommandRunner().run({ command, args: [], harness: 'grok',
      stdin: input, stdinSource: 'file', sessionId: 'native-session', timeoutMs: 5000,
      signal: new AbortController().signal,
      commandPins: { command, sha256: createHash('sha256').update(source).digest('hex'), files: {} } });
    assert.equal(result.exitCode, 0);
    assert.equal(parseGrokOutput(result.stdout).output.reply, inputDigest(input));
    const witness = result.consumptionWitness;
    assert.deepEqual(witness, { version: 1, harness_id: 'grok', native_session_id: 'native-session',
      native_turn_id: 'native-session', input_sha256: inputDigest(input), evidence_kind: 'canonical_final_response' });
    assert.equal(matchingConsumptionWitness(witness, 'grok', input, 'another-session'), undefined);
    assert.equal(matchingConsumptionWitness(witness, 'grok', 'other input', 'native-session'), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Grok verifier rejects fabricated receipts and incomplete or inconsistent native results', () => {
  const request: CommandRunRequest = { command: '/approved/grok', args: [], harness: 'grok',
    stdin: 'desired context', sessionId: 'native-session', timeoutMs: 5000, signal: new AbortController().signal };
  const native = { text: 'native final', stopReason: 'end_turn', sessionId: 'native-session' };
  const result: CommandRunResult = { stdout: JSON.stringify(native), stderr: '', exitCode: 0,
    signal: null, timedOut: false, cancelled: false };
  const receipt = { version: 1, harness_id: 'grok', native_session_id: 'native-session',
    native_turn_id: 'fabricated-turn', input_sha256: inputDigest(request.stdin), evidence_kind: 'canonical_final_response' };
  for (const stdout of [JSON.stringify(receipt), JSON.stringify({ reply: 'fabricated final', ...receipt }),
    JSON.stringify({ text: JSON.stringify({ sessionId: 'native-session', consumptionWitness: receipt }) }),
    JSON.stringify({ ...native, sessionId: 'another-session' }),
    JSON.stringify({ ...native, stopReason: 'max_tokens' }), 'not native JSON']) {
    assert.equal(verifyGrokConsumption(request, { ...result, stdout }), undefined, stdout);
  }
  for (const changed of [{ exitCode: 1 }, { signal: 'SIGTERM' as const }, { timedOut: true }, { cancelled: true }]) {
    assert.equal(verifyGrokConsumption(request, { ...result, ...changed }), undefined);
  }
  assert.equal(verifyGrokConsumption({ ...request, signal: AbortSignal.abort() }, result), undefined);
  assert.equal(verifyGrokConsumption({ ...request,
    emissionOutput: () => parseGrokOutput(JSON.stringify({ ...native, text: 'another final' })).output }, result), undefined);
});
