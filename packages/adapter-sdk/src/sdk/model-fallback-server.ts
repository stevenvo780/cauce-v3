import { spawn, type ChildProcess } from 'node:child_process';
import type { AdapterLogger, HarnessDefinition } from './types.js';

/** Only the Muse profile crosses into the bridge server: never the adapter's Cauce credentials. */
const SERVER_ENVIRONMENT = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'MUSE_NO_AUTO_UPDATE', 'CAUCE_MUSE_CLI_COMMAND', 'CAUCE_MUSE_CLI_SHA256', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const;

export interface FallbackSupervision { readonly initialMs: number; readonly maximumMs: number; readonly stableMs: number; readonly killMs: number }
const SUPERVISION: FallbackSupervision = { initialMs: 1_000, maximumMs: 60_000, stableMs: 300_000, killMs: 3_000 };

/**
 * The agent that serves a model fallback shares the socket directory's uid: its own turns never get shell or write
 * tools (no `--yolo`), so they cannot stop the server, bind another listener or plant a link in its place.
 */
export function fallbackServerDefinition(definition: HarnessDefinition): HarnessDefinition {
  if (definition.id !== 'muse') throw new Error('only a Muse agent serves a model fallback');
  return { ...definition, baseArgs: ['exec', '--json', '--trust-workspace', '--disable-web-tools', '--disable-reminders',
    '--no-foreign-personal-context', '--disable-write', '--disable-shell'] };
}

/** The executor's exact argv for the paired bridge server (`CAUCE_MODEL_FALLBACK_SERVE`), or none. */
export function modelFallbackCommand(environment: NodeJS.ProcessEnv = process.env): readonly string[] | undefined {
  const raw = environment.CAUCE_MODEL_FALLBACK_SERVE;
  if (raw === undefined) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length < 2 || value.length > 16
    || !value.every((item): item is string => typeof item === 'string' && item.length <= 4096 && !item.includes('\0'))
    || !value[0]?.startsWith('/')) throw new Error('model fallback server command is invalid');
  return value;
}

/** Keeps the bridge server running beside this adapter, restarted with backoff, and stops it with the adapter. */
export function superviseModelFallback(command: readonly string[], logger: AdapterLogger, signal: AbortSignal,
  supervision: FallbackSupervision = SUPERVISION, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [executable, ...args] = command;
  if (executable === undefined) return Promise.reject(new Error('model fallback server command is invalid'));
  const env = Object.fromEntries(SERVER_ENVIRONMENT.flatMap(name => environment[name] === undefined ? [] : [[name, environment[name]]]));
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let delay = supervision.initialMs;
    const start = (): void => {
      if (signal.aborted) { resolve(); return; }
      const startedAt = Date.now();
      const current = spawn(executable, args, { env, stdio: ['ignore', 'ignore', 'inherit'] });
      child = current;
      let ended = false;
      const restart = (detail: string): void => {
        if (ended) return;
        ended = true;
        child = undefined;
        if (signal.aborted) { resolve(); return; }
        if (Date.now() - startedAt >= supervision.stableMs) delay = supervision.initialMs;
        logger({ event: 'model_fallback_server_exited', harness: 'muse', reason: detail, elapsed_ms: Date.now() - startedAt });
        timer = setTimeout(start, delay);
        delay = Math.min(delay * 2, supervision.maximumMs);
      };
      current.once('error', (error) => { restart(error.message); });
      current.once('close', (code, exitSignal) => { restart(exitSignal === null ? `exit ${String(code)}` : `signal ${exitSignal}`); });
    };
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      const running = child;
      if (running === undefined) { resolve(); return; }
      running.kill('SIGTERM');
      setTimeout(() => { running.kill('SIGKILL'); }, supervision.killMs).unref();
    }, { once: true });
    start();
  });
}
