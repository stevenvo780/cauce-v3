#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { CliTmux } from "../shared-session/tmux.js";
import { ensureSharedSession, sharedSessionStatus } from "../shared-session/session.js";
import { appServerSocketPath, runtimeDirectory } from "../shared-session/config.js";
import { readDegradations } from "../shared-session/degradation-log.js";
import { TUI_WINDOW, isSharedSessionHarness, sessionName } from "../shared-session/types.js";
import type { SharedSessionSpec } from "../shared-session/session.js";

/**
 * La cara de línea de comandos de la sesión compartida. UNA sola implementación, dos llamadores.
 *
 * `cauce <alias>` corre esto DENTRO del contenedor por `docker exec`, y el adaptador llama a las
 * mismas funciones en proceso. No hay dos rutinas parecidas que se puedan desincronizar: el dueño
 * ya pidió expresamente que se dejara de multiplicar CLIs.
 *
 * Salida en JSON por stdout para `status`, texto para el resto: quien lo llama es un script bash.
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
  const harness = options.harness as "claude" | "codex";
  return {
    alias: options.alias,
    harness,
    workspace: options.workspace,
    ...(harness === "codex" ? { socketPath: appServerSocketPath(home, options.alias) } : {}),
  };
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const home = process.env.HOME ?? homedir();
  const tmux = new CliTmux();
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolveSleep) => {
      const timer = setTimeout(resolveSleep, ms);
      timer.unref();
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
    process.exit(status.present ? 0 : 1);
  }

  if (options.command === "ensure") {
    // El directorio de runtime lo crea quien enciende, no el arranque del contenedor: así el
    // socket del app-server tiene dueño y permisos correctos sin depender de la imagen.
    await mkdir(runtimeDirectory(home, options.alias), { recursive: true, mode: 0o700 });
    const result = await ensureSharedSession(tmux, sessionSpec, { sleep });
    process.stdout.write(`${JSON.stringify({
      ...result,
      session: sessionName(options.alias),
      window: TUI_WINDOW,
    })}\n`);
    process.exit(result.ready ? 0 : 1);
  }

  usage();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
