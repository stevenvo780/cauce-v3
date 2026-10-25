import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { HarnessAdapter, claudeDefinition } from '../../packages/adapter-sdk/src/harnesses/index.js';
import { DurableStore } from '../../packages/adapter-sdk/src/sdk/durable-store.js';
import { PasteSessionRunner } from '../../packages/adapter-sdk/src/shared-session/paste-runner.js';
import { ensureSharedSession, transcriptDirectoryIn } from '../../packages/adapter-sdk/src/shared-session/session.js';
import { claudeTranscript } from '../../packages/adapter-sdk/src/shared-session/transcript.js';
import { CliTmux, capturePane, paneIdentity } from '../../packages/adapter-sdk/src/shared-session/tmux.js';

export const CORRELATION_MS = 600;
export const QUIET_MS = 250;
export const SILENT_WORK_MS = 1_800;
export const RECEIPTS = join(process.cwd(), '.delegados/v4/recibos/t2-turnos-muertos-1025');

type Scenario = 'silent' | 'idle-live' | 'lost' | 'spinner' | 'correlated-hang' | 'late' | 'api-error';
export interface TuiState { submits: number; submittedAt: number; finishedAt?: number; paints: number }

const TUI = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const [scenario] = process.argv.slice(2);
const { T2_TRANSCRIPT: transcript, T2_STATE_FILE: stateFile } = process.env;
const sessionId = crypto.randomUUID();
let buffer = '';
let pasted = '';
let sequence = 0;
let paints = 0;
let submittedAt = 0;
let finishedAt;
let draft = '';
let generating = false;
let lastReply = '';
function state() {
  fs.writeFileSync(stateFile, JSON.stringify({ submits: sequence, submittedAt, finishedAt, paints }));
}
function screen(nextGenerating = generating) {
  generating = nextGenerating;
  const content = (draft + buffer).replace(/\x1b\[(?:200|201)~/gu, '').replace(/\r\n?/gu, '\n')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/gu, '�');
  const lines = content.split('\n');
  const header = generating ? '✻ Working… (esc to interrupt)' : 'Controlled TUI ready' + (lastReply ? '\r\n' + lastReply : '');
  const rule = '─'.repeat(Math.max(3, (process.stdout.columns || 80) - 1));
  const composer = lines.map((line, index) => (index ? '  ' : '❯ ') + line).join('\r\n');
  const cursor = '\x1b[' + (header.split('\r\n').length + lines.length + 1) + ';' + (lines.at(-1).length + 3) + 'H';
  process.stdout.write('\x1b[2J\x1b[H' + header + '\r\n' + rule + '\r\n' + composer + '\r\n' + rule + cursor);
}
function entry(type, uuid, parentUuid, content) {
  return { type, uuid, parentUuid, isSidechain: false, sessionId,
    ...(type === 'user' ? { promptSource: 'typed' } : {}),
    message: type === 'user' ? { role: 'user', content }
      : { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: content }] } };
}
function append(value) { fs.appendFileSync(transcript, JSON.stringify(value) + '\n'); }
function submit() {
  if (!pasted) return;
  sequence += 1;
  submittedAt = Date.now();
  const prompt = pasted;
  pasted = '';
  draft = '';
  const id = /"cauce_correlation_id":"([a-f0-9]{64})"/u.exec(prompt)?.[1];
  if (!id) throw new Error('Controlled TUI did not receive correlated bracketed paste');
  const userId = crypto.randomUUID();
  if (['correlated-hang', 'idle-live', 'late', 'api-error'].includes(scenario) || sequence > 1) {
    append(entry('user', userId, null, prompt));
  }
  if (scenario === 'api-error') {
    const error = entry('assistant', crypto.randomUUID(), userId, 'PRIVATE_PROVIDER_ERROR');
    error.isApiErrorMessage = true;
    error.message.stop_reason = 'stop_sequence';
    append(error);
    screen(false);
    state();
    return;
  }
  if (scenario === 'lost') { screen(false); state(); return; }
  screen(scenario !== 'idle-live' && scenario !== 'correlated-hang');
  state();
  const spinner = scenario === 'spinner' ? setInterval(() => { paints += 1; screen(true); state(); }, 40) : undefined;
  if (scenario === 'spinner' || scenario === 'correlated-hang') return;
  setTimeout(() => {
    clearInterval(spinner);
    const reply = sequence > 1 ? 'next turn completed' : scenario === 'late' ? 'late turn completed' : 'silent turn completed';
    append(entry('assistant', crypto.randomUUID(), userId, JSON.stringify({
      reply, messages: [], status: 'done', retryable: false, artifacts: [], cauce_correlation_id: id,
    })));
    finishedAt = Date.now();
    lastReply = reply;
    screen(false);
    state();
  }, sequence > 1 ? 80 : scenario === 'late' ? 2_200 : 1_800);
}
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdout.write('\x1b[?2004h');
screen(false);
state();
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.length > 0) {
    if (buffer.startsWith('\x1b[200~')) {
      const end = buffer.indexOf('\x1b[201~');
      if (end < 0) { screen(); return; }
      pasted = buffer.slice(6, end).replace(/\r\n?/gu, '\n');
      draft += pasted;
      buffer = buffer.slice(end + 6);
      screen();
      continue;
    }
    if (buffer.startsWith('\x1b') && buffer.length < 6) { screen(); return; }
    const character = buffer[0];
    buffer = buffer.slice(1);
    if (character === '\r' || character === '\n') submit();
    else {
      if (character === '\x7f') draft = draft.slice(0, -1);
      else if (character === '\x15') draft = '';
      else draft += character;
      if (pasted) pasted = draft;
    }
  }
  screen();
});
`;

export async function startControlledTui(scenario: Scenario) {
  assert.match(process.env.HOME ?? '', /^\/tmp\/cauce-e2e-home-/u,
    'Run the real TUI suite with scripts/e2e-lab.sh');
  const directory = await mkdtemp(join(tmpdir(), 'zz-canary-t2-turnos-muertos-'));
  const alias = `zz-canary-${scenario}`;
  const socket = `zz-canary-t2-${randomUUID()}`;
  const tmux = new CliTmux(socket, { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
  const config = join(directory, 'config');
  const transcriptDirectory = transcriptDirectoryIn(config, directory);
  const transcript = join(transcriptDirectory, `${randomUUID()}.jsonl`);
  const stateFile = join(directory, 'tui-state.json');
  const command = join(directory, 'claude');
  await mkdir(transcriptDirectory, { recursive: true });
  await writeFile(transcript, '');
  await writeFile(command, TUI, { mode: 0o700 });
  const harnessArguments = [scenario];
  const environment = { T2_TRANSCRIPT: transcript, T2_STATE_FILE: stateFile };
  const notices: string[] = [];
  const store = await DurableStore.open(join(directory, 'store'));
  const runner = new PasteSessionRunner({ alias, harness: 'claude', command, workspace: directory,
    harnessArguments, environment, transcript: claudeTranscript(config, directory), tmux, sleep: delay,
    correlationTimeoutMs: CORRELATION_MS, quietTimeoutMs: QUIET_MS,
    acquireTimeoutMs: 3_000, readyTimeoutMs: 5_000, settleMs: 20, pollMs: 40,
    quarantineFile: join(directory, 'quarantine'), onNotice: detail => { notices.push(detail); },
  });
  const adapter = new HarnessAdapter({ definition: claudeDefinition, runner, store,
    sessionNamespace: alias, sharedSession: { alias, harness: 'claude', stateDirectory: directory },
  });
  const cleanup = async (): Promise<void> => {
    await tmux.run(['kill-server']);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const ready = await ensureSharedSession(tmux, { alias, harness: 'claude', command,
      workspace: directory, harnessArguments, environment }, { sleep: delay, readyTimeoutMs: 5_000 });
    if (!ready.ready) {
      const panes = await tmux.run(['list-panes', '-a', '-F',
        '#{session_id}\t#{session_name}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_start_command}\t#{@cauce_creation_nonce}']);
      await receipt('startup-failure', { scenario, ready, panes });
    }
    assert.equal(ready.ready, true, ready.detail);
    const identity = await paneIdentity(tmux, `=cauce-${alias}:agente`);
    assert.ok(identity, 'The controlled TUI must have a real tmux pane identity');
    return { directory, tmux, runner, adapter, notices, identity, transcript, stateFile, cleanup,
      state: async (): Promise<TuiState> => JSON.parse(await readFile(stateFile, 'utf8')) as TuiState,
      pane: (): Promise<string | undefined> => capturePane(tmux, identity.paneId),
      execute: (timeoutMs: number) => adapter.execute({ prompt: 'Synthetic timeout canary',
        timeoutMs, timeoutKind: 'no-progress', sessionKey: 'synthetic-timeout-canary',
        signal: new AbortController().signal }),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function waitForState(fixture: Awaited<ReturnType<typeof startControlledTui>>,
  condition: (state: TuiState) => boolean): Promise<TuiState> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const state = await fixture.state();
      if (condition(state)) return state;
    } catch { /* The controlled TUI replaces its state during the read. */ }
    await delay(30);
  }
  throw new Error('Controlled TUI did not reach its expected state');
}

export async function receipt(name: string, evidence: Record<string, unknown>): Promise<void> {
  await mkdir(RECEIPTS, { recursive: true });
  await writeFile(join(RECEIPTS, `tmux-${name}.json`), `${JSON.stringify({
    recordedAt: new Date().toISOString(), terminal: 'real tmux in docker-lab',
    correlationMs: CORRELATION_MS, quietMs: QUIET_MS, ...evidence,
  }, null, 2)}\n`);
}
