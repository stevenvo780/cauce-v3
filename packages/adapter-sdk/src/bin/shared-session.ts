#!/usr/bin/env node
import { homedir } from "node:os";
import { CliTmux } from "../shared-session/tmux.js";
import { ensureSharedSession, sharedSessionStatus } from "../shared-session/session.js";
import { cliSharedSessionSpec } from "../shared-session/config.js";
import { readDegradations } from "../shared-session/degradation-log.js";
import { TUI_WINDOW, isSharedSessionHarness, sessionName } from "../shared-session/types.js";
import type { SharedSessionSpec } from "../shared-session/session.js";

/**
 * CLI para inspeccionar y asegurar el estado de la sesión compartida.
 */

interface Options {
  readonly command: string;
  readonly alias: string;
  readonly harness: string;
  readonly workspace: string;
  readonly stateDirectory?: string;
}

function usage(): never {
  process.stderr.write(
    "uso: shared-session.js <ensure|status|degradations> --alias A --harness claude|codex"
    + " [--workspace /workspace] [--state DIR]\n",
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
  return {
    command,
    alias,
    harness,
    workspace: values.get("workspace") ?? "/workspace",
    ...(stateDirectory === undefined ? {} : { stateDirectory }),
  };
}

function spec(options: Options, home: string): SharedSessionSpec {
  if (!isSharedSessionHarness(
    options.harness as Parameters<typeof isSharedSessionHarness>[0],
  )) {
    process.stderr.write(`el harness '${options.harness}' no tiene sesión compartida\n`);
    process.exit(3);
  }
  // SAME spec — and above all same environment — as if the adapter created the session. The tmux
  // server keeps the environment of the first creator and discards the second's, so two
  // similar routines would yield a different TUI depending on who won the race.
  return cliSharedSessionSpec(
    options.harness as "claude" | "codex",
    options.alias,
    options.workspace,
    home,
  );
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const home = process.env.HOME ?? homedir();
  const tmux = new CliTmux();
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

  const sessionSpec = spec(options, home);
  if (options.command === "status") {
    const status = await sharedSessionStatus(tmux, sessionSpec);
    process.stdout.write(`${JSON.stringify(status)}\n`);
    // Use exitCode so stdout is fully drained before the process exits.
    process.exitCode = status.present ? 0 : 1;
    return;
  }

  if (options.command === "ensure") {
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

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
