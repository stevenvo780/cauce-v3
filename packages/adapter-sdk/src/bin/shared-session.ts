#!/usr/bin/env node
import { homedir } from "node:os";
import { CliTmux } from "../shared-session/tmux.js";
import { ensureSharedSession, sharedSessionStatus } from "../shared-session/session.js";
import { cliSharedSessionSpec } from "../shared-session/config.js";
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
  // OJO: este temporizador NO se puede `unref()`.
  //
  // En el adaptador da igual —su bucle de eventos lo sostiene el websocket del bus— pero acá el
  // único trabajo pendiente ES la espera. Con `unref()`, en cuanto `ensureSharedSession` se
  // dormía a esperar a que la TUI dibujara su caja, Node se quedaba sin nada que lo mantuviera
  // vivo y TERMINABA SOLO, con código 0 y sin escribir una línea.
  //
  // Medido en ws-prizma el 2026-07-30: `ensure` de codex salía 0 en silencio y sin la ventana de
  // la TUI. `cauce socrates` lo leía como éxito y anunciaba COMPARTIDA sobre una sesión que no lo
  // era. Un `unref()` de una línea producía exactamente el fallo silencioso que este trabajo
  // existe para eliminar.
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
    // `process.exit()` descarta lo que quede pendiente en stdout cuando stdout es una tubería, y
    // acá SIEMPRE lo es: `cauce <alias>` llama a esto por `docker exec`. Medido en ws-prizma: el
    // JSON se perdía entero y el CLI mostraba «sin detalle» justo cuando el dueño necesitaba
    // saber qué había fallado. Con `exitCode` el proceso termina solo, ya vaciada la tubería.
    process.exitCode = status.present ? 0 : 1;
    return;
  }

  if (options.command === "ensure") {
    const result = await ensureSharedSession(tmux, sessionSpec, { sleep });
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
