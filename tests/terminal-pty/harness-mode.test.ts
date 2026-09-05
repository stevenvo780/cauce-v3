/**
 * The tmux window name is ONE contract shared by two languages, and nothing in the tree checks
 * that they still agree: the adapter-sdk creates the window (its `TUI_WINDOW`), and the Python
 * pty-agent has to attach to that exact window or the console can never show the harness.
 *
 * The name is imported here, never retyped, and the argv is asked of the Python agent itself
 * instead of being re-implemented in TypeScript, so a change on either side breaks this file.
 * The negative control creates the same session under the name the fleet never emits and pins
 * the fail-closed exit 77: a bare non-zero would also match a plain tty error and prove nothing.
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { TUI_WINDOW } from '@cauce/adapter-sdk';

const ALIAS = 'claude';
const HARNESS = 'claude';
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const AGENT_DIR = fileURLToPath(new URL('../../ops/pty-agent', import.meta.url));

const which = (tool: string): string | null => {
  const found = spawnSync('command', ['-v', tool], { encoding: 'utf8', shell: true });
  const path = found.stdout.trim().split('\n')[0] ?? '';
  return found.status === 0 && path.startsWith('/') ? path : null;
};

const TMUX = which('tmux');
const SCRIPT = which('script');
if (TMUX === null) {
  console.log('harness-mode.test.ts: SKIPPED — no tmux on PATH, the harness window cannot be created');
}

const sockets: string[] = [];
const socketPaths = new Map<string, string>();
const socket = (suffix: string): string => {
  const name = `cauce-test-${String(process.pid)}-${randomUUID().slice(0, 8)}-${suffix}`;
  sockets.push(name);
  return name;
};

/** The argv the Python agent builds, asked of the agent itself; never rebuilt here. */
const agentArgv = (socketName: string): string[] => {
  const program = [
    'import json,sys',
    'sys.path.insert(0, sys.argv[1])',
    'import cauce_pty_agent as agent',
    'bundle = {"tmux_tui": {"path": sys.argv[2], "socket": sys.argv[3]},'
    + ' "alias": sys.argv[4], "harness": sys.argv[5]}',
    'print(json.dumps(agent.resolve_tmux_tui_command(bundle)))'
  ].join('\n');
  const raw = execFileSync(
    'python3',
    ['-c', program, AGENT_DIR, TMUX ?? '', socketName, ALIAS, HARNESS],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
  );
  const argv: unknown = JSON.parse(raw);
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== 'string')) {
    throw new Error(`the pty-agent did not resolve a tmux command: ${raw}`);
  }
  return argv as string[];
};

const command = (argv: string[]): string => {
  const [head] = argv;
  if (head === undefined) throw new Error('the pty-agent resolved an empty tmux command');
  return head;
};

/** The session exactly as packages/adapter-sdk/src/shared-session/session.ts creates it. */
const createSession = (socketName: string, windowName: string): string => {
  const tmux = TMUX ?? '';
  const sessionId = execFileSync(tmux, [
    '-L', socketName, 'new-session', '-d', '-P', '-F', '#{session_id}',
    '-s', `cauce-${ALIAS}`, '-n', windowName, 'sleep', '60'
  ], { encoding: 'utf8' }).trim();
  execFileSync(tmux, ['-L', socketName, 'set-option', '-t', sessionId, '@cauce_alias', ALIAS]);
  execFileSync(tmux, ['-L', socketName, 'set-option', '-t', sessionId, '@cauce_harness', HARNESS]);
  socketPaths.set(socketName, execFileSync(
    tmux, ['-L', socketName, 'display-message', '-p', '#{socket_path}'], { encoding: 'utf8' }
  ).trim());
  return sessionId;
};

const quote = (argv: string[]): string =>
  argv.map((item) => `'${item.replaceAll("'", `'\\''`)}'`).join(' ');

/** True as soon as tmux lists a client for the session; false if the client dies or never attaches. */
const attached = async (socketName: string, client: ChildProcess): Promise<boolean> => {
  for (let attempt = 0; attempt < 200 && client.exitCode === null; attempt += 1) {
    const clients = spawnSync(TMUX ?? 'tmux', ['-L', socketName, 'list-clients', '-t', `cauce-${ALIAS}`], {
      encoding: 'utf8'
    });
    if (clients.status === 0 && clients.stdout.trim() !== '') return true;
    await new Promise((resume) => { setTimeout(resume, 50); });
  }
  return false;
};

const suite = TMUX === null ? describe.skip : describe;

suite('the pty-agent attaches to the window the adapter-sdk creates', () => {
  afterAll(() => {
    for (const name of sockets) {
      spawnSync(TMUX ?? 'tmux', ['-L', name, 'kill-server'], { stdio: 'ignore' });
      const path = socketPaths.get(name);
      if (path !== undefined) rmSync(path, { force: true });
    }
  });

  it('targets the window name the adapter-sdk produces', () => {
    const argv = agentArgv('cauce');
    expect(argv).toContain(`cauce-${ALIAS}:${TUI_WINDOW}`);
    expect(argv).toContain(`attach-session -r -f ignore-size -t cauce-${ALIAS}:${TUI_WINDOW}`);
  });

  it('reaches attach-session on the real session instead of the fail-closed branch', () => {
    const name = socket('ok');
    createSession(name, TUI_WINDOW);
    const argv = agentArgv(name);
    const done = spawnSync(command(argv), argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // Headless: tmux got as far as attaching and only then failed for want of a terminal.
    expect(done.status).not.toBe(77);
    expect(done.stderr).toMatch(/open terminal failed|not a terminal/);
  });

  (SCRIPT === null ? it.skip : it)('attaches under a real pty and detaches clean', async () => {
    const name = socket('pty');
    createSession(name, TUI_WINDOW);
    const argv = agentArgv(name);
    const client = spawn(SCRIPT ?? 'script', ['-qec', quote(argv), '/dev/null'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color' }
    });
    // The listener is armed before the wait so an early exit cannot be missed. Detaching on a
    // timer would either race a slow attach or hang until the suite timeout; wait for tmux to
    // report the client instead, which is the very fact under test.
    const exited = new Promise<number | null>((resolve) => { client.on('exit', resolve); });
    expect(await attached(name, client)).toBe(true);
    spawnSync(TMUX ?? 'tmux', ['-L', name, 'detach-client', '-s', `cauce-${ALIAS}`], { stdio: 'ignore' });
    expect(await exited).toBe(0);
  });

  it('refuses a window named tui with exactly 77 and no diagnostics', () => {
    const name = socket('legacy');
    createSession(name, 'tui');
    const argv = agentArgv(name);
    const refused = spawnSync(command(argv), argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(refused.status).toBe(77);
    expect(refused.stderr).toBe('');
  });
});
