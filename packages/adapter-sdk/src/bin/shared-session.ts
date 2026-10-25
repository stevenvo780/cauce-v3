#!/usr/bin/env node
import { homedir } from "node:os";
import { createHash } from 'node:crypto';
import { CliTmux, type TmuxController } from "../shared-session/tmux.js";
import { ensureSharedSession, sharedSessionStatus } from "../shared-session/session.js";
import { cliSharedSessionSpec, harnessConfigDirectory } from "../shared-session/config.js";
import { SharedTuiPointerStore } from "../shared-session/native-pointer.js";
import { prepareMuseProfile } from '../shared-session/muse-profile.js';
import { exactConversationIsSecure } from "../shared-session/resume.js";
import { readDegradations } from "../shared-session/degradation-log.js";
import { TUI_WINDOW, isSharedSessionHarness, sessionName } from "../shared-session/types.js";
import type { SharedSessionSpec } from "../shared-session/session.js";
import { applySessionRecovery, previewSessionRecovery } from '../shared-session/recovery.js';
import { assertCommandPins } from '../sdk/command-pins.js';

/**
 * CLI to inspect and ensure the state of the shared session.
 */

interface Options {
  readonly command: string;
  readonly alias: string;
  readonly harness: string;
  readonly workspace: string;
  readonly stateDirectory?: string;
  readonly nativeId?: string;
  readonly expectedFingerprint?: string;
  readonly force?: boolean;
  readonly expiresAt?: number;
}

function usage(): never {
  process.stderr.write(
    "uso: shared-session.js <ensure|status|degradations|seed|resume-proof|recovery-preview|recovery-apply> --alias A --harness claude|codex|grok|muse"
    + " [--workspace /workspace] [--state DIR] [--native-id ID] [--expected-fingerprint SHA256] [--force 0|1] [--expires-at UNIX_MS]\n",
  );
  process.exit(2);
}

function parse(argv: readonly string[]): Options {
  const command = argv[0];
  if (command === undefined) usage();
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) usage();
    values.set(key.slice(2), value);
  }
  const alias = values.get("alias");
  const harness = values.get("harness");
  if (alias === undefined || harness === undefined) usage();
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(alias)) usage();
  const stateDirectory = values.get("state");
  const nativeId = values.get("native-id");
  const expectedFingerprint = values.get('expected-fingerprint');
  const force = values.get('force');
  const expiration = values.get('expires-at');
  const expiresAt = expiration === undefined ? undefined : Number(expiration);
  if (expectedFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(expectedFingerprint)) usage();
  if (force !== undefined && force !== '0' && force !== '1') usage();
  if (expiration !== undefined && (expiresAt === undefined || !/^[0-9]+$/u.test(expiration)
    || !Number.isSafeInteger(expiresAt))) usage();
  return {
    command,
    alias,
    harness,
    workspace: values.get("workspace") ?? "/workspace",
    ...(stateDirectory === undefined ? {} : { stateDirectory }),
    ...(nativeId === undefined ? {} : { nativeId }),
    ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
    ...(force === undefined ? {} : { force: force === '1' }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function spec(options: Options, home: string, environment: NodeJS.ProcessEnv = process.env): SharedSessionSpec {
  const harness = options.harness;
  if (!isSharedSessionHarness(harness)) {
    process.stderr.write(`el harness '${options.harness}' no tiene sesión compartida\n`);
    process.exit(3);
  }
  // SAME spec — and above all same environment — as if the adapter created the session. The tmux
  // server keeps the environment of the first creator and discards the second's, so two
  // similar routines would yield a different TUI depending on who won the race.
  return cliSharedSessionSpec(
    harness,
    options.alias,
    options.workspace,
    home,
    environment,
    options.stateDirectory,
  );
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const home = process.env.HOME ?? homedir();
  if (options.command === 'resume-proof') {
    const sessionSpec = spec(options, home, { ...process.env, CAUCE_SHARED_SESSION_REQUIRE_RESUME: '1' });
    await assertCommandPins(sessionSpec.command ?? sessionSpec.harness, sessionSpec.commandPins);
    const plan = await sessionSpec.resume?.resolveLaunch?.();
    const resumable = plan?.state === 'launch' && plan.resumed;
    const fingerprint = resumable ? createHash('sha256').update(JSON.stringify({
      alias: options.alias, harness: sessionSpec.harness, state: options.stateDirectory,
      workspace: sessionSpec.workspace, args: plan.args,
    })).digest('hex') : null;
    process.stdout.write(`${JSON.stringify({ resumable, fingerprint })}\n`);
    process.exitCode = resumable ? 0 : 1;
    return;
  }
  const recovery = options.command.startsWith('recovery-');
  const tmux = new CliTmux(undefined, process.env, recovery ? 1000 : 10_000);
  // This timer MUST NOT be `unref()`-ed: there is no other pending work keeping the event
  // loop alive here, and with `unref()` Node exits with code 0 before the TUI starts.
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolveSleep) => {
      setTimeout(resolveSleep, ms);
    });

  if (options.command === "degradations") {
    const stateDirectory = options.stateDirectory;
    if (stateDirectory === undefined) usage();
    for (const record of await readDegradations(stateDirectory)) {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    }
    return;
  }

  if (recovery && !isSharedSessionHarness(options.harness)) {
    process.stdout.write(`${JSON.stringify({ type: 'session', state: 'unsupported', resumable: false,
      fingerprint: null, reason: 'Este harness no admite recuperar una sesión compartida por este mecanismo.' })}\n`);
    process.exitCode = 1;
    return;
  }
  const sessionSpec = spec(options, home);
  if (options.command === 'recovery-preview' || options.command === 'recovery-apply') {
    if (options.stateDirectory === undefined) usage();
    const input = { spec: sessionSpec, namespace: options.alias, stateDirectory: options.stateDirectory,
      configDirectory: harnessConfigDirectory(sessionSpec.harness, home, process.env, sessionSpec.alias) };
    if (options.command === 'recovery-apply' && (options.expectedFingerprint === undefined || options.force === undefined)) usage();
    const expiresAt = options.expiresAt ?? Date.now() + 6500;
    if (expiresAt <= Date.now() || expiresAt > Date.now() + 8000) {
      process.stdout.write(`${JSON.stringify({ type: 'session', state: 'failed', resumable: false,
        fingerprint: null, reason: 'La autorización venció antes de ejecutar la recuperación.' })}\n`);
      process.exitCode = 1;
      return;
    }
    const signal = AbortSignal.timeout(Math.min(6500, Math.max(1, expiresAt - Date.now())));
    const boundedTmux: TmuxController = { run: (args, stdin, control) => {
      if (Date.now() >= expiresAt) return Promise.reject(new Error('Recovery authorization expired'));
      return tmux.run(args, stdin,
        { ...control, signal: control?.signal === undefined ? signal : AbortSignal.any([signal, control.signal]) });
    } };
    const result = options.command === 'recovery-preview' ? await previewSessionRecovery(boundedTmux, input)
      : await applySessionRecovery(boundedTmux, input, options.expectedFingerprint ?? '', options.force ?? false,
        { sleep, signal, readyTimeoutMs: 3500, recoveryExpiresAt: expiresAt });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = ['present', 'absent', 'resumed', 'recreated'].includes(result.state) ? 0 : 1;
    return;
  }
  if (options.command === "status") {
    const status = await sharedSessionStatus(tmux, sessionSpec);
    process.stdout.write(`${JSON.stringify(status)}\n`);
    // Use exitCode so stdout is fully drained before the process exits.
    process.exitCode = status.present ? 0 : 1;
    return;
  }

  if (options.command === "seed") {
    await seed(options, sessionSpec, home);
    return;
  }

  if (options.command === "ensure") {
    if (sessionSpec.harness === 'muse') await prepareMuseProfile(sessionSpec.environment ?? {});
    // Notice goes to stderr, not stdout JSON: invoked by `cauce <alias>` parsing stdout.
    const result = await ensureSharedSession(tmux, sessionSpec, {
      sleep,
      log: (detail: string): void => {
        process.stderr.write(`${detail}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify({
      ...result,
      session: sessionName(options.alias),
      window: TUI_WINDOW,
    })}\n`);
    process.exitCode = result.ready ? 0 : 1;
    return;
  }

  usage();
}

async function seed(options: Options, sessionSpec: SharedSessionSpec, home: string): Promise<void> {
  const harness = sessionSpec.harness; // Migration: names the canonical conversation, never replaces one.
  if (options.stateDirectory === undefined || options.nativeId === undefined) usage();
  if (harness === "codex") {
    process.stderr.write("codex reanuda con resume --last; no tiene puntero que sembrar\n");
    process.exit(3);
  }
  const binding = {
    alias: options.alias,
    harness,
    configDirectory: harnessConfigDirectory(harness, home, process.env, options.alias),
    workspace: options.workspace,
  };
  const secure = await exactConversationIsSecure(harness, binding, options.nativeId);
  const result = secure
    ? await new SharedTuiPointerStore(options.stateDirectory).seed(binding, options.nativeId)
    : "unverified";
  process.stdout.write(`${JSON.stringify({ result, alias: options.alias, harness, native_id: options.nativeId })}\n`);
  process.exitCode = result === "written" || result === "unchanged" ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
