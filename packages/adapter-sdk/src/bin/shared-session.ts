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
  // MISMO spec —y sobre todo mismo entorno— que si la sesión la creara el adaptador. El servidor
  // tmux se queda con el entorno del primero que lo crea y descarta el del segundo, así que dos
  // rutinas parecidas darían una TUI distinta según quién ganó la carrera.
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
  // Este temporizador NO se puede `unref()`: aquí no hay otro trabajo pendiente que sostenga
  // el bucle de eventos, y con `unref()` Node termina con código 0 antes de que la TUI arranque.
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
    // Usa exitCode para asegurar que stdout se vacía completamente antes de finalizar.
    process.exitCode = status.present ? 0 : 1;
    return;
  }

  if (options.command === "ensure") {
    // El aviso va a stderr, no al JSON de stdout: quien llama a esto es `cauce <alias>`, un script
    // bash que parsea stdout. Una reanudación que no salió tiene que verse igualmente, porque el
    // panel vuelve en blanco y por fuera eso no se distingue de un panel que nunca tuvo contexto.
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
