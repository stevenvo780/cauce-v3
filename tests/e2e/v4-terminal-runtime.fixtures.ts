import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isTerminalMode, type TerminalMode } from '../../services/gateway/src/terminal/types.js';
import type { RealPtyFixtureOptions } from './real-pty-agent.fixtures.js';

const execute = promisify(execFile);

function boundedSeconds(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const seconds = value ?? fallback;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > maximum) throw new Error(`invalid fixture ${name}`);
  return seconds;
}

export function realPtyRuntimeOptions(options: RealPtyFixtureOptions) {
  const owner = options.owner ?? 'real-pty-agent';
  const resourcePrefix = options.resourcePrefix ?? (options.owner ? `zz-canary-${owner}` : 'cauce-real-pty');
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(owner) || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(resourcePrefix)) {
    throw new Error('invalid real PTY fixture resource ownership');
  }
  const modes: readonly TerminalMode[] = options.modes ?? (options.tui ? ['shell', 'harness', 'harness_rw'] : ['shell']);
  if (modes.some((mode) => !isTerminalMode(mode)) || new Set(modes).size !== modes.length) throw new Error('invalid real PTY fixture modes');
  const sessionTtlSeconds = boundedSeconds(options.sessionTtlSeconds, 900, 3_600, 'sessionTtlSeconds');
  const sessionMaxTotalSeconds = boundedSeconds(options.sessionMaxTotalSeconds, 1_800, 14_400, 'sessionMaxTotalSeconds');
  if (sessionMaxTotalSeconds < sessionTtlSeconds) throw new Error('fixture session total must cover its TTL');
  const controlHoldSeconds = boundedSeconds(options.controlHoldSeconds, Math.min(900, sessionMaxTotalSeconds), sessionMaxTotalSeconds, 'controlHoldSeconds');
  const idleTimeoutSeconds = boundedSeconds(options.idleTimeoutSeconds, 600, 86_400, 'idleTimeoutSeconds');
  const maxSessionsPerOperator = boundedSeconds(options.maxSessionsPerOperator, 2, 100, 'maxSessionsPerOperator');
  return { owner, resourcePrefix, modes, sessionTtlSeconds, sessionMaxTotalSeconds,
    controlHoldSeconds, idleTimeoutSeconds, maxSessionsPerOperator };
}

export async function stageTerminalRuntime(buildContext: string, tui: boolean): Promise<void> {
  if (!tui) return;
  await writeFile(join(buildContext, 'codex'), `#!/bin/sh
set -eu
case "$*" in
  'login --device-auth')
    printf 'CAUCE-E2E-CODEX-LOGIN\\n'
    printf 'AUTHENTICATED\\n' > /tmp/cauce-e2e-login-state
    ;;
  'login status'|'auth status')
    if test -f /tmp/cauce-e2e-login-state; then
      printf 'CAUCE-E2E-CODEX-AUTHENTICATED\\n'
    else
      printf 'CAUCE-E2E-CODEX-NOT-AUTHENTICATED\\n'
      exit 1
    fi
    ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
}

export async function initializeTerminalTmux(container: string, socket: string, alias: string): Promise<void> {
  const session = `cauce-${alias}`;
  const target = `${session}:agente`;
  const tmux = ['exec', '--user', 'node', '--env', 'TERM=xterm-256color', container, '/usr/bin/tmux', '-L', socket];
  await execute('docker', [...tmux, 'new-session', '-d', '-s', session, '-n', 'agente', '-x', '100', '-y', '30', '/bin/sh -i'], { timeout: 15_000 });
  await execute('docker', [...tmux, 'set-option', '-t', session, '@cauce_alias', alias], { timeout: 15_000 });
  await execute('docker', [...tmux, 'set-option', '-t', session, '@cauce_harness', 'codex'], { timeout: 15_000 });
  await execute('docker', [...tmux, 'send-keys', '-t', target, '-l', "printf 'CAUCE-E2E-TMUX-READY\\n'"], { timeout: 15_000 });
  await execute('docker', [...tmux, 'send-keys', '-t', target, 'Enter'], { timeout: 15_000 });
}
