import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { emptyAgentProfile } from '@cauce/protocol';
import { deliveryHarnesses } from '../src/bin/shared.js';
import { codexDefinition } from '../src/harnesses/codex.js';
import { claudeDefinition } from '../src/harnesses/claude.js';
import { commandPinsFromEnvironment, type CommandPins } from '../src/sdk/command-pins.js';
import { executionSelection, selectionArguments, selectionForProfile, type ExecutionSelection } from '../src/sdk/execution-selection.js';
import { DurableStore } from '../src/sdk/durable-store.js';
import { SpawnCommandRunner } from '../src/sdk/process-runner.js';
import { runBootstrap } from '../src/sdk/bootstrap-runner.js';
import type { BootstrapDescriptor, BootstrapProfile, BootstrapProof, BootstrapTransport } from '../src/sdk/bootstrap-client.js';
import { cliSharedSessionSpec } from '../src/shared-session/config.js';
import { paneCommandMatches } from '../src/shared-session/session/identity.js';
import { ensureSharedSession } from '../src/shared-session/session.js';
import { FakeTmux } from './shared-session-fixtures.js';

const operationId = '00000000-0000-4000-8000-000000000099';
async function fixture(harness: 'codex' | 'claude', selection: ExecutionSelection) {
  const directory = await mkdtemp(join(tmpdir(), 'execution-selection-')); const command = join(directory, 'provider.mjs'); const calls = join(directory, 'calls.jsonl');
  const source = `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2),wanted=${JSON.stringify(selection)};
if(wanted.modelId!==undefined?args[args.indexOf('--model')+1]!==wanted.modelId:args.includes('--model'))process.exit(23);
if(wanted.reasoningEffort!==undefined&&!args.includes(${JSON.stringify(harness === 'codex' ? `model_reasoning_effort=${selection.reasoningEffort ?? ''}` : selection.reasoningEffort ?? '')}))process.exit(24);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
let prompt='';process.stdin.on('data',data=>prompt+=data);process.stdin.on('end',()=>{
const marker=/CAUCE_BOOTSTRAP_[a-f0-9]{64}/.exec(prompt)?.[0];const reply=marker??'EFFECTIVE_SELECTION';
if(${JSON.stringify(harness)}==='codex'){
 console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000098'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:reply}}));
}else console.log(JSON.stringify({result:reply,is_error:false,session_id:'00000000-0000-4000-8000-000000000098'}));
});\n`;
  await writeFile(command, source, { mode: 0o700 });
  const pins: CommandPins = { command, sha256: createHash('sha256').update(source).digest('hex'), files: {} };
  return { directory, command, calls, pins, runner: new SpawnCommandRunner(), definition: harness === 'codex' ? codexDefinition : claudeDefinition,
    close: async () => { await rm(directory, { recursive: true, force: true }); } };
}
for (const harness of ['codex', 'claude'] as const) test(`${harness}: agent and human deliveries execute the explicit model and effort through the pinned process`, async () => {
  const selected = { modelId: 'test/model', reasoningEffort: harness === 'codex' ? 'xhigh' : 'high' }; const f = await fixture(harness, selected);
  try {
    const store = await DurableStore.open(join(f.directory, 'state'));
    const adapters = deliveryHarnesses({ definition: f.definition, runner: f.runner, store,
      commandOverride: { command: f.command }, commandPins: f.pins, executionSelection: selected }, f.runner);
    for (const adapter of [adapters.harness, adapters.humanHarness]) {
      assert.ok(adapter); assert.equal((await adapter.execute({ prompt: 'Deliver this turn', timeoutMs: 5000, signal: new AbortController().signal })).reply, 'EFFECTIVE_SELECTION');
    }
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.equal(calls.length, 2); for (const args of calls) {
      assert.equal(args[args.indexOf('--model') + 1], selected.modelId);
      assert.ok(selectionArguments(harness, selected).every(argument => args.includes(argument)));
      assert.equal(args.includes('--yolo'), false); assert.equal(args.includes('--dangerously-skip-permissions'), false);
    }
  } finally { await f.close(); }
});
test('no explicit selection preserves the CLI profile and absent environment does not create command pins', async () => {
  const f = await fixture('codex', {});
  try {
    const adapters = deliveryHarnesses({ definition: f.definition, runner: f.runner, store: await DurableStore.open(join(f.directory, 'state')),
      commandOverride: { command: f.command }, executionSelection: {} }, f.runner);
    assert.equal((await adapters.harness.execute({ prompt: 'Profile default', timeoutMs: 5000, signal: new AbortController().signal })).reply, 'EFFECTIVE_SELECTION');
    assert.deepEqual(selectionArguments('codex', {}), []); assert.equal(commandPinsFromEnvironment({}), undefined);
    assert.throws(() => selectionForProfile('codex', 'different', { modelId: 'explicit' }), /durable profile/u);
    assert.throws(() => selectionForProfile('claude', null, {}, 'minimal'), /unsupported/u);
    assert.throws(() => executionSelection('opencode', { modelId: 'unverified' }), /verified/u);
  } finally { await f.close(); }
});
test('bootstrap ACK follows the actual spawned invocation model and effort; a label-only runner cannot ACK', async () => {
  const selected = { modelId: 'test/model', reasoningEffort: 'xhigh' }; const f = await fixture('codex', selected);
  const documents = [{ name: 'AGENTS.md', sha256: 'a'.repeat(64), native_revision: null }];
  const profile: BootstrapProfile = { operation_id: operationId, phase: 'bootstrap', tenant_id: 'Steven', alias: 'selected', runtime_key: 'selected',
    harness_id: 'codex', model_id: selected.modelId, reasoning_effort: selected.reasoningEffort, account_id: 'selected-account', profile_revision: 1, documents,
    contexto: { perfil: emptyAgentProfile('Steven', 'selected'), hechos: { permisos: { ruta: false, lectura: false, control: false, notificacion: false },
      cuotas: [], destinos: [], arnes: { harness: 'codex', home: f.directory, capacidades: [] } } } };
  const nonce = 'b'.repeat(64); const descriptor: BootstrapDescriptor = { ...profile, probe_id: operationId, action: 'verify', nonce,
    claim_token: 'c'.repeat(64), deadline: new Date(Date.now() + 60_000).toISOString(), prompt: `CAUCE_BOOTSTRAP_${nonce}` };
  const abort = new AbortController(); let proof: BootstrapProof | undefined;
  const client: BootstrapTransport = { state: async () => ({ operation_id: operationId, phase: 'bootstrap', status: 'running', enabled: false,
    lifecycle_state: 'verifying', runtime_key: 'selected', profile_revision: 1, account_id: profile.account_id, normal_admitted: false }),
    profile: async () => profile, claim: async () => descriptor, ack: async (_descriptor, value) => { proof = value; abort.abort(); } };
  const options = { operation_id: operationId, phase: 'bootstrap' as const, runtime_key: 'selected', tenant_id: 'Steven', alias: 'selected',
    client, definition: f.definition, runner: f.runner, commandOverride: { command: f.command }, commandPins: f.pins, executionSelection: selected, profile: () => documents };
  try {
    await runBootstrap(options, abort.signal); assert.equal(proof?.model_id, selected.modelId); assert.equal(proof.reasoning_effort, selected.reasoningEffort);
    proof = undefined;
    await assert.rejects(runBootstrap({ ...options, runner: { run: async () => ({ stdout: JSON.stringify({ type: 'item.completed', item: {
      type: 'agent_message', text: `CAUCE_BOOTSTRAP_${nonce}` } }), stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, harnessStarted: true }) } }, new AbortController().signal), /invocation selection/u);
    assert.equal(proof, undefined);
    await assert.rejects(runBootstrap({ ...options, executionSelection: { ...selected, reasoningEffort: 'high' } }, new AbortController().signal), /durable profile/u);
  } finally { await f.close(); }
});
test('a changed executable, conflicting command pin or symlinked parent is rejected before any provider execution', async () => {
  const f = await fixture('codex', { modelId: 'test/model' });
  try {
    const packet = { command: f.command, args: ['exec', '--model', 'test/model'], harness: 'codex' as const, stdin: 'No secrets', timeoutMs: 5000,
      signal: new AbortController().signal, commandPins: f.pins, executionSelection: { modelId: 'test/model' } };
    const redirect = join(f.directory, 'redirect'); await symlink(f.directory, redirect); const redirectedCommand = join(redirect, 'provider.mjs');
    await assert.rejects(f.runner.run({ ...packet, command: redirectedCommand, commandPins: { ...f.pins, command: redirectedCommand } }), /ENOTDIR|ELOOP/u);
    await assert.rejects(f.runner.run({ ...packet, args: [...packet.args, '--model', 'another-model'] }), /ambiguous/u);
    await writeFile(f.command, '#!' + process.execPath + '\nprocess.exit(0);\n');
    await assert.rejects(f.runner.run(packet), /pinned harness file changed/u);
    await assert.rejects(f.runner.run({ ...packet, command: process.execPath }), /differs/u);
    assert.throws(() => commandPinsFromEnvironment({ CAUCE_HARNESS_COMMAND: f.command, CAUCE_HARNESS_COMMAND_SHA256: f.pins.sha256,
      CAUCE_HARNESS_COMMAND_FILES: JSON.stringify({ [f.command]: 'f'.repeat(64) }) }), /file pin/u);
    await assert.rejects(readFile(f.calls), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('shared TUI uses the same explicit arguments and refuses a prior model or executable instead of relabeling it', async () => {
  const selected = { modelId: 'test/model', reasoningEffort: 'xhigh' }; const f = await fixture('codex', selected);
  try {
    const spec = cliSharedSessionSpec('codex', 'selected', f.directory, f.directory, { HOME: f.directory, CAUCE_MODEL_ID: selected.modelId,
      CAUCE_REASONING_EFFORT: selected.reasoningEffort, CAUCE_HARNESS_COMMAND: f.command, CAUCE_HARNESS_COMMAND_SHA256: f.pins.sha256 });
    const expected = `exec ${f.command} --yolo --model test/model -c model_reasoning_effort=xhigh`;
    assert.equal(paneCommandMatches(spec, expected), true);
    assert.equal(paneCommandMatches(spec, expected.replace('test/model', 'old-model')), false);
    assert.equal(paneCommandMatches(spec, expected.replace(f.command, '/other/provider.mjs')), false);
    assert.equal(paneCommandMatches(spec, expected + ' --model old-model'), false);
    const tmux = new FakeTmux(); tmux.sessionExists = false; tmux.windows = [];
    await ensureSharedSession(tmux, spec, { sleep: async () => undefined, readyTimeoutMs: 30 });
    const created = tmux.calls.find(call => call[0] === 'new-session'); assert.ok(created);
    assert.match(created.at(-1) ?? '', /--model test\/model -c model_reasoning_effort=xhigh/u);
    const launched = await f.runner.run({ command: '/bin/bash', args: ['-lc', created.at(-1) ?? ''], harness: 'fake', stdin: 'A shared terminal turn',
      timeoutMs: 5000, signal: new AbortController().signal });
    assert.equal(launched.exitCode, 0);
    assert.ok((JSON.parse((await readFile(f.calls, 'utf8')).trim()) as string[]).includes('--yolo'));
  } finally { await f.close(); }
});

const pinnedPane = { alias: 'selected', harness: 'codex' as const, workspace: '/workspace', command: '/approved/provider.mjs',
  commandPins: { command: '/approved/provider.mjs', sha256: 'a'.repeat(64), files: {} },
  requiredArguments: ['--model', 'approved/model', '-c', 'model_reasoning_effort=xhigh'] };
const approvedPaneCommand = '/approved/provider.mjs --model approved/model -c model_reasoning_effort=xhigh';
for (const [label, command] of [
  ['wrapper argument', `exec /unapproved/wrapper ${approvedPaneCommand}`],
  ['unused payload', `exec /unapproved/provider.mjs --unused ${approvedPaneCommand}`],
  ['shell positional parameter', `bash -lc 'exec /unapproved/provider' 'exec ${approvedPaneCommand}'`],
  ['exec process name', `exec -a /approved/provider.mjs /unapproved/wrapper --model approved/model -c model_reasoning_effort=xhigh`],
  ['env option value', `exec env -u ${approvedPaneCommand}`],
  ['terminated CLI options', `exec /approved/provider.mjs -- --model approved/model -c model_reasoning_effort=xhigh`],
  ['shell comment', `exec /approved/provider.mjs # --model approved/model -c model_reasoning_effort=xhigh`],
  ['second shell command', `exec ${approvedPaneCommand}\n/another/command`],
  ['double quoted literal backslash', 'exec "/approved/provider\\.mjs" --model approved/model -c model_reasoning_effort=xhigh'],
] as const) test(`shared TUI rejects a pinned executable or selection appearing as ${label}`, () => {
  assert.equal(paneCommandMatches(pinnedPane, command), false);
});
test('shared TUI accredits the executable after controlled shell and environment wrappers', () => {
  for (const command of [approvedPaneCommand, `exec ${approvedPaneCommand}`, `exec -- ${approvedPaneCommand}`,
    `exec env HOME='/home/dev' PATH='/usr/bin:/bin' ${approvedPaneCommand}`,
    `/usr/bin/env -- HOME='/home/dev' ${approvedPaneCommand}`,
    `bash -lc 'exec ${approvedPaneCommand}'`, `/bin/bash -lc 'exec env HOME=/home/dev ${approvedPaneCommand}'`]) {
    assert.equal(paneCommandMatches(pinnedPane, command), true, command);
  }
  const interpreter = { ...pinnedPane, command: '/approved/node', commandPins: { ...pinnedPane.commandPins, command: '/approved/node' } };
  assert.equal(paneCommandMatches(interpreter, 'exec /approved/node /approved/bundle.mjs --model approved/model -c model_reasoning_effort=xhigh'), true);
});
