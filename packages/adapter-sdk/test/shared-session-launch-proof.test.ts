import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DurableStore } from '../src/sdk/durable-store.js';
import { newGrokSessionId } from '../src/shared-session/grok.js';
import { SharedTuiPointerStore } from '../src/shared-session/native-pointer.js';
import { resolveGrokLaunch } from '../src/shared-session/resume.js';
import { transcriptDirectoryIn } from '../src/shared-session/session.js';
import { freshState } from './shared-session-fixtures.js';
import { grokWorkspace } from './grok-shared-session-fixtures.js';

type Proof = Record<string, unknown>;

async function proof(command: 'launch-proof' | 'resume-proof', harness: string, state: string, workspace: string,
  env: NodeJS.ProcessEnv): Promise<Proof> {
  const child = spawn(process.execPath, [new URL('../src/bin/shared-session.js', import.meta.url).pathname, command,
    '--alias', 'socrates', '--harness', harness, '--state', state, '--workspace', workspace],
  { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const [code] = await once(child, 'close') as [number];
  const parsed = JSON.parse(output) as Proof;
  assert.equal(code, parsed.launchable === true || parsed.resumable === true ? 0 : 1);
  return parsed;
}

async function codexHome(name: string) {
  const { state, home } = await freshState(name);
  const directory = join(state, 'codex'); await mkdir(directory, { mode: 0o700 });
  const rollout = async (id: string) => {
    await mkdir(join(directory, 'sessions', '2026', '10', '25'), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'sessions', '2026', '10', '25', `rollout-2026-10-25T00-00-00-${id}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id, source: 'cli', cwd: '/workspace' } })}\n`, { mode: 0o600 });
  };
  const command = join(state, 'codex-pinned'); const body = '#!/bin/sh\n';
  await writeFile(command, body, { mode: 0o700 });
  const env = { HOME: home, CODEX_HOME: directory, CAUCE_FLEET_OPERATION_ID: randomUUID(), CAUCE_HARNESS_COMMAND: command,
    CAUCE_HARNESS_COMMAND_SHA256: createHash('sha256').update(body).digest('hex') };
  return { state, rollout, launch: () => proof('launch-proof', 'codex', state, '/workspace', env) };
}

test('launch-proof: Codex starts an empty tree, resumes its only own conversation and refuses an ambiguous history', async () => {
  const empty = await codexHome('launch-proof-codex-empty');
  assert.deepEqual(await empty.launch(), { launchable: true, resumed: false });
  const single = await codexHome('launch-proof-codex-single');
  await single.rollout(randomUUID());
  assert.deepEqual(await single.launch(), { launchable: true, resumed: true });
  const two = await codexHome('launch-proof-codex-two');
  await two.rollout(randomUUID()); await two.rollout(randomUUID());
  assert.deepEqual(await two.launch(), { launchable: false, resumed: false });
});

test('launch-proof: a Codex pointer that names a missing rollout blocks even a launch that may start fresh', async () => {
  const pointed = await codexHome('launch-proof-codex-dangling');
  const store = await DurableStore.open(pointed.state);
  await store.setSession('codex:socrates:shared:socrates', { native_id: randomUUID(), initialized: true });
  assert.deepEqual(await pointed.launch(), { launchable: false, resumed: false });
});

test('launch-proof and resume-proof: Claude history without its exact pointer is never launched', async () => {
  const { state, home } = await freshState('launch-proof-claude');
  const configDirectory = join(state, 'claude'); const workspace = join(state, 'projects');
  await mkdir(workspace, { mode: 0o700 }); await mkdir(transcriptDirectoryIn(configDirectory, workspace), { recursive: true, mode: 0o700 });
  const env = { HOME: home, CLAUDE_CONFIG_DIR: configDirectory };
  assert.deepEqual(await proof('launch-proof', 'claude', state, workspace, env), { launchable: true, resumed: false });
  assert.deepEqual(await proof('resume-proof', 'claude', state, workspace, env), { resumable: false, fingerprint: null });
  const id = randomUUID();
  await writeFile(join(transcriptDirectoryIn(configDirectory, workspace), `${id}.jsonl`), '{}\n', { mode: 0o600 });
  await writeFile(join(transcriptDirectoryIn(configDirectory, workspace), `${randomUUID()}.jsonl`), '{}\n', { mode: 0o600 });
  assert.deepEqual(await proof('launch-proof', 'claude', state, workspace, env), { launchable: false, resumed: false });
  assert.deepEqual(await proof('resume-proof', 'claude', state, workspace, env), { resumable: false, fingerprint: null });
  await new SharedTuiPointerStore(state).seed({ alias: 'socrates', harness: 'claude', configDirectory, workspace }, id);
  assert.deepEqual(await proof('launch-proof', 'claude', state, workspace, env), { launchable: true, resumed: true });
  assert.equal((await proof('resume-proof', 'claude', state, workspace, env)).resumable, true);
});

test('resume-proof: the Grok conversation its start would recover counts with the fingerprint of the seeded pointer', async () => {
  const { state, grokHome, sessionLog } = await grokWorkspace('launch-proof-grok', { history: false });
  const workspace = await realpath(await mkdir(join(state, 'projects'), { mode: 0o700 }).then(() => join(state, 'projects')));
  const log = await sessionLog(newGrokSessionId(1_000), encodeURIComponent(workspace));
  await log.append(log.user('canary'));
  await writeFile(join(dirname(log.file), 'summary.json'), JSON.stringify({ info: { id: log.sessionId, cwd: workspace } }));
  const env = { HOME: dirname(grokHome), GROK_HOME: grokHome };
  const before = await proof('resume-proof', 'grok', state, workspace, env);
  assert.equal(before.resumable, true);
  assert.deepEqual(await new SharedTuiPointerStore(state).read({ alias: 'socrates', harness: 'grok', configDirectory: grokHome, workspace }),
    { state: 'absent' });
  assert.deepEqual(await proof('launch-proof', 'grok', state, workspace, env), { launchable: true, resumed: true });
  assert.deepEqual(await resolveGrokLaunch(grokHome, workspace, { alias: 'socrates', stateDirectory: state }),
    { state: 'launch', args: ['--resume', log.sessionId], resumed: true });
  assert.deepEqual(await proof('resume-proof', 'grok', state, workspace, env), before);
  const ambiguous = await grokWorkspace('launch-proof-grok-ambiguous', { history: false });
  const second = join(ambiguous.state, 'projects'); await mkdir(second, { mode: 0o700 });
  for (const at of [3_000, 3_000]) {
    const conversation = await ambiguous.sessionLog(newGrokSessionId(at), encodeURIComponent(await realpath(second)));
    await conversation.append(conversation.user('canary'));
    await writeFile(join(dirname(conversation.file), 'summary.json'),
      JSON.stringify({ info: { id: conversation.sessionId, cwd: await realpath(second) } }));
  }
  assert.deepEqual(await proof('launch-proof', 'grok', ambiguous.state, await realpath(second),
    { HOME: dirname(ambiguous.grokHome), GROK_HOME: ambiguous.grokHome }), { launchable: false, resumed: false });
});
