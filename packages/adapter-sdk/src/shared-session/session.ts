import {
  capturePane,
  hasSession,
  killSession,
  panePid,
  repairLegacyDegradedWindow,
  type TmuxController,
} from "./tmux.js";
import { inputBoxState } from "./pane.js";
import {
  LEGACY_DEGRADED_WINDOW,
  TUI_WINDOW,
  sessionName,
  type ResumeSpec,
  type SharedSessionHarness,
} from "./types.js";

/**
 * Cómo se levanta y cómo se mira la sesión compartida de un alias. UNA sola implementación.
 *
 * El dueño ya se quejó de tener sistemas compitiendo ("unifica tanto CLI"), así que `cauce <alias>`
 * y el adaptador no tienen dos rutinas parecidas: las dos llaman a lo de acá. El CLI lo alcanza
 * ejecutando `dist/src/bin/shared-session.js` dentro del contenedor, que es el mismo código que el
 * adaptador llama en proceso.
 */

export interface SharedSessionSpec {
  readonly alias: string;
  readonly harness: SharedSessionHarness;
  /** Directorio de trabajo de la TUI. Es también lo que determina el directorio de transcripts. */
  readonly workspace: string;
  /** Binario del harness. Se separa para poder apuntarlo a un doble en las pruebas. */
  readonly command?: string;
  /**
   * Variables que la TUI tiene que ver SÍ O SÍ, vaya quien vaya a crear la sesión.
   *
   * Se aplican en el ARGV del panel (`env K=V … exec …`) y no por el entorno del proceso que llama
   * a tmux. La diferencia es total y está medida: el servidor tmux se queda con el entorno del
   * PRIMER cliente que lo crea y DESCARTA el de los siguientes. Prueba en `ws-prizma` el
   * 2026-07-30, socket aislado: el cliente A creó el servidor con `MARCA=servidor-A`, el cliente B
   * creó otra sesión con `MARCA=cliente-B`, y los paneles de AMBAS sesiones vieron `servidor-A`.
   *
   * Consecuencia real: cualquier variable que ponga el supervisor es INERTE si el dueño abrió su
   * terminal primero. Ya hay una víctima comprobada: `supervisor.sh` exporta
   * `TERM=xterm-256color` con el comentario «sin él la TUI se dibuja rota para el dueño», y el
   * servidor tmux de socrates no tiene `TERM` en absoluto. Como los dos creadores —el adaptador y
   * `cauce <alias>`— pasan por aquí, el argv es el único punto que tmux no puede descartar.
   */
  readonly environment?: Readonly<Record<string, string>>;
  /**
   * Cómo se REANUDA la conversación anterior al crear el panel. Ausente = arrancar siempre pelado.
   *
   * Ausente es lo que hacía el código hasta el 2026-08-06, y lo que le costó a kant 38 MB de
   * conversación. Ver `ResumeSpec`.
   */
  readonly resume?: ResumeSpec;
}

export interface EnsureOptions {
  readonly sleep: (ms: number) => Promise<void>;
  /** Cuánto se espera a que la TUI esté lista tras crearla. */
  readonly readyTimeoutMs?: number;
  /** Ancho/alto con que nace la sesión sin clientes enganchados. */
  readonly width?: number;
  readonly height?: number;
  /**
   * Dónde se cuenta lo que pasó con la reanudación.
   *
   * No es decorativo: si el `resume` falla, el panel del dueño vuelve en blanco y desde fuera eso
   * es indistinguible de un panel que nunca tuvo contexto. Sin esta línea, la única señal de que
   * la conversación se perdió sería que el agente contesta raro.
   */
  readonly log?: (detail: string) => void;
}

export interface EnsureResult {
  readonly ready: boolean;
  /** True si esta llamada tuvo que crear la sesión (no existía). */
  readonly created: boolean;
  /** PID del proceso del panel de la TUI, cuando se pudo leer. */
  readonly pid?: string;
  readonly detail: string;
  /**
   * Qué falló exactamente, para que el aviso que lee el dueño no mienta.
   *
   * "no hay sesión" y "la sesión está pero la TUI no responde" se arreglan de formas distintas, y
   * deducirlo de si hubo que crearla daba la etiqueta equivocada en el caso más frecuente: sesión
   * viva con la TUI muerta dentro.
   */
  readonly failure?: "session_absent" | "tui_absent";
  /**
   * True cuando esta llamada creó el panel REANUDANDO la conversación anterior.
   *
   * Sólo tiene sentido junto a `created: true`. Lo necesita quien avisa al dueño: "hubo que crear
   * la sesión" significa cosas opuestas según si la conversación volvió entera o empezó de cero, y
   * decir lo segundo cuando pasó lo primero es la clase de mentira que ya se pagó dos veces.
   */
  readonly resumed?: boolean;
}

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 1_000;

export function tuiTarget(alias: string): string {
  return `${sessionName(alias)}:${TUI_WINDOW}`;
}

/**
 * El directorio donde `claude` guarda los transcripts de un workspace.
 *
 * La regla la fija claude: sustituye cada `/` del cwd por `-`, así que `/workspace` da
 * `-workspace`. Se replica acá porque el adaptador tiene que leer ESE directorio y no hay ninguna
 * bandera que lo revele.
 */
export function transcriptDirectory(home: string, workspace: string): string {
  return transcriptDirectoryIn(`${home}/.claude`, workspace);
}

/**
 * Igual, pero a partir del directorio de configuración EXACTO con el que va a correr la TUI.
 *
 * Existe porque el sitio donde `claude` escribe los transcripts y el sitio donde el adaptador los
 * lee TIENEN que ser el mismo por construcción. Si alguien exporta `CLAUDE_CONFIG_DIR`, el panel lo
 * respeta (se lo pasamos en su argv) y la cosecha tiene que mirar allí, no en `~/.claude`. Derivar
 * los dos del mismo valor hace imposible que se separen.
 */
export function transcriptDirectoryIn(configDirectory: string, workspace: string): string {
  const slug = workspace.replace(/\/+$/u, "").replace(/\//gu, "-");
  const root = configDirectory.replace(/\/+$/u, "");
  return `${root}/projects/${slug === "" ? "-" : slug}`;
}

/**
 * Levanta la sesión si no está, y no toca nada si ya está.
 *
 * La TUI se lanza con `bash -lc` a propósito: tiene que arrancar con el MISMO entorno que cuando
 * el dueño la abre a mano (perfil, `$CODEX_HOME`, `PATH` del contenedor). El adaptador corre bajo
 * `env -i` con una lista corta de variables, y heredar eso a pelo daría una TUI distinta de la que
 * el dueño conoce.
 *
 * Y cuando hay que crearla, nace REANUDANDO la conversación anterior si la había. Rehacer el panel
 * no puede costarle al alias su memoria: el 2026-08-06 le costó a kant 38 MB. Las dos redes que
 * protegen eso están comentadas donde ocurren; la regla que las ordena es que un panel sin contexto
 * es malo y uno que no arranca es peor, porque un alias mudo es el fallo más caro de la flota.
 */
export async function ensureSharedSession(
  tmux: TmuxController,
  spec: SharedSessionSpec,
  options: EnsureOptions,
): Promise<EnsureResult> {
  const session = sessionName(spec.alias);
  const target = tuiTarget(spec.alias);
  if (await hasSession(tmux, session)) {
    let pid = await panePid(tmux, target);
    if (pid === undefined
      && await repairLegacyDegradedWindow(tmux, session, TUI_WINDOW, LEGACY_DEGRADED_WINDOW)) {
      // La sesión estaba enclavada por el renombrado de una versión anterior: la ventana existía
      // pero con otro nombre, así que el adaptador la daba por muerta en cada entrega, para
      // siempre. Devolverle el nombre la resucita sin tocar la conversación del dueño.
      pid = await panePid(tmux, target);
    }
    if (pid === undefined) {
      return {
        ready: false, created: false, failure: "tui_absent",
        detail: `la sesión ${session} existe pero no tiene panel de TUI`,
      };
    }
    return { ready: true, created: false, pid, detail: `sesión ${session} ya abierta` };
  }

  // PRIMERA red: no se intenta reanudar lo que no existe.
  //
  // `codex resume --last` y `claude --continue` fallan de formas distintas cuando no hay nada que
  // reanudar —codex 0.145.0 abre una conversación nueva y sigue vivo; claude 2.1.223 escribe «No
  // conversation found to continue» y sale 1, matando el panel—, así que no se puede confiar en
  // que el harness aguante. Preguntar antes cuesta leer la cabecera de un fichero.
  if (await hasResumableConversation(spec, options)) {
    const attempt = await startTui(tmux, spec, options, spec.resume?.args);
    if (attempt.ready) {
      return {
        ready: true, created: true, resumed: true, pid: attempt.pid,
        detail: `sesión ${session} creada REANUDANDO la conversación anterior`,
      };
    }
    // SEGUNDA red: si el panel no quedó EN PIE, se rehace en blanco.
    //
    // La condición es que el panel esté MUERTO, no que haya tardado: una conversación grande puede
    // tardar en dibujarse —la de kant pesaba 38 MB— y matar un panel que estaba reanudando bien
    // sería cometer con las manos el mismo borrado que esto viene a evitar. Un panel vivo aunque
    // lento se deja en paz y se reporta como siempre.
    if (!attempt.paneGone) return { ...attempt.result, created: true };
    options.log?.(
      `la reanudación de ${spec.alias} no dejó la TUI en pie (${attempt.result.detail});`
      + " se rehace el panel EN BLANCO y la conversación anterior no vuelve",
    );
    await killSession(tmux, session);
  }

  const attempt = await startTui(tmux, spec, options, undefined);
  if (!attempt.ready) {
    return {
      ...attempt.result,
      created: attempt.result.failure === "session_absent" ? false : true,
    };
  }
  return { ready: true, created: true, pid: attempt.pid, detail: `sesión ${session} creada` };
}

/**
 * ¿Hay conversación previa Y forma de pedirla?
 *
 * Falla cerrado hacia el comportamiento de siempre: si el detector revienta —directorio ilegible,
 * permisos, un rollout corrupto— se arranca en blanco, que es exactamente lo que hacía el código
 * antes de esto. Lo que NO puede pasar es que una excepción de un detector se lleve por delante el
 * arranque del panel entero y deje al alias mudo.
 */
async function hasResumableConversation(
  spec: SharedSessionSpec,
  options: EnsureOptions,
): Promise<boolean> {
  const resume = spec.resume;
  if (resume === undefined || resume.args.length === 0) return false;
  try {
    return await resume.hasPreviousConversation();
  } catch (error: unknown) {
    options.log?.(
      `no se pudo comprobar si ${spec.alias} tenía conversación previa`
      + ` (${error instanceof Error ? error.message : String(error)}); se arranca en blanco`,
    );
    return false;
  }
}

/**
 * Un intento de arranque, con lo que hace falta para decidir si se puede reintentar.
 *
 * `paneGone` es la pregunta que separa "esto se puede rehacer" de "esto hay que dejarlo quieto":
 * sólo se vuelve a intentar sobre un panel que YA no existe, nunca sobre uno vivo.
 */
type StartAttempt =
  | { readonly ready: true; readonly pid: string }
  | { readonly ready: false; readonly paneGone: boolean; readonly result: EnsureResult };

async function startTui(
  tmux: TmuxController,
  spec: SharedSessionSpec,
  options: EnsureOptions,
  resumeArguments: readonly string[] | undefined,
): Promise<StartAttempt> {
  const target = tuiTarget(spec.alias);
  const created = await createSession(tmux, spec, options, resumeArguments);
  if (!created.ok) {
    return {
      ready: false, paneGone: true,
      result: { ready: false, created: false, failure: "session_absent", detail: created.detail },
    };
  }

  const waited = await waitForTui(tmux, target, options);
  const pid = await panePid(tmux, target);
  // Sin PID no hay panel, y sin panel no hay TUI: nunca "listo".
  //
  // Esto era un éxito silencioso medido, no una hipótesis. Cuando la ventana de la TUI moría al
  // nacer, `waitForTui` llegaba a ver el panel un instante, devolvía `true`, y `ensure` contestaba
  // `ready:true` sobre una sesión sin TUI dentro. El adaptador y `cauce <alias>` daban por buena
  // una sesión compartida inexistente: exactamente el fallo que este trabajo existe para eliminar.
  if (pid === undefined) {
    return {
      ready: false, paneGone: true,
      result: {
        ready: false, created: true, failure: "tui_absent",
        detail: `la TUI de ${spec.alias} se creó y desapareció antes de poder usarla`,
      },
    };
  }
  if (waited !== "ready") {
    return {
      ready: false, paneGone: false,
      result: {
        ready: false, created: true, pid, failure: "tui_absent",
        detail: `la TUI de ${spec.alias} no llegó a estar lista`,
      },
    };
  }
  return { ready: true, pid };
}

/**
 * El prefijo `env K=V …` que fija el entorno del panel, ya escapado para `bash -lc`.
 *
 * Devuelve un error en vez de descartar en silencio una variable con nombre inválido: una TUI que
 * arranca con menos entorno del que se le pidió es exactamente la clase de degradación muda que
 * este mecanismo existe para eliminar.
 */
export function paneEnvironmentPrefix(
  environment: Readonly<Record<string, string>> | undefined,
): { ok: true; prefix: string } | { ok: false; detail: string } {
  const entries = Object.entries(environment ?? {});
  if (entries.length === 0) return { ok: true, prefix: "" };
  const parts: string[] = [];
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      return { ok: false, detail: `nombre de variable inválido para la sesión compartida: ${name}` };
    }
    parts.push(`${name}=${shellQuote(value)}`);
  }
  return { ok: true, prefix: `env ${parts.join(" ")} ` };
}

/** Comillas simples, que en POSIX no interpretan NADA. El valor nunca toca el parser del shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/**
 * Los argumentos de reanudación, ya listos para pegarlos detrás del binario.
 *
 * Van SIN comillas y con una lista blanca estrecha, no por miedo al shell sino porque un argumento
 * raro acá sólo puede venir de un error de programación: los únicos valores legítimos son
 * `resume --last` y `--continue`. Falla cerrado —se arranca en blanco— en vez de mandarle al shell
 * algo que nadie escribió a propósito.
 */
export function resumeArgumentSuffix(
  args: readonly string[] | undefined,
): { ok: true; suffix: string } | { ok: false; detail: string } {
  if (args === undefined || args.length === 0) return { ok: true, suffix: "" };
  for (const argument of args) {
    if (!/^[A-Za-z0-9-][A-Za-z0-9_.:@=+-]*$/u.test(argument)) {
      return { ok: false, detail: `argumento de reanudación inválido: ${argument}` };
    }
  }
  return { ok: true, suffix: ` ${args.join(" ")}` };
}

async function createSession(
  tmux: TmuxController,
  spec: SharedSessionSpec,
  options: EnsureOptions,
  resumeArguments?: readonly string[],
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const session = sessionName(spec.alias);
  const command = spec.command ?? spec.harness;
  const width = String(options.width ?? 200);
  const height = String(options.height ?? 50);
  const environment = paneEnvironmentPrefix(spec.environment);
  if (!environment.ok) return { ok: false, detail: environment.detail };
  const env = environment.prefix;
  // La reanudación es un subcomando del HARNESS, así que va pegada al binario y NO al prefijo
  // `env K=V`: `env` se comería `--continue` como si fuera suyo.
  const resume = resumeArgumentSuffix(resumeArguments);
  if (!resume.ok) return { ok: false, detail: resume.detail };

  // Una ventana, un proceso: el binario del harness tal cual, igual que si lo abriera el dueño.
  //
  // codex tenía además una ventana `servidor` con `app-server --listen unix://` y arrancaba la TUI
  // con `--remote`. Se retiró entera: el turno ya no entra por ese protocolo sino por la caja de
  // entrada, así que el servidor, el socket, la espera a que aceptara y la ventana extra eran
  // cuatro piezas que sólo podían fallar. Y fallaron: el 2026-07-31 `turn/start` se quedó colgado
  // sin que el log del servidor registrara nada.
  const result = await tmux.run([
    "new-session", "-d", "-s", session, "-n", TUI_WINDOW,
    "-c", spec.workspace, "-x", width, "-y", height,
    "bash", "-lc", `exec ${env}${command}${resume.suffix}`,
  ]);
  return result.exitCode === 0 ? { ok: true } : { ok: false, detail: tmuxError(result.stderr) };
}

function tmuxError(stderr: string): string {
  const detail = stderr.trim().split(/\r?\n/u)[0] ?? "";
  return detail === "" ? "tmux rechazó la creación de la sesión" : detail;
}

/**
 * Espera a que la caja de entrada exista y esté vacía.
 *
 * No es un `sleep` fijo porque el arranque medido de claude va de 15 a 30 s y varía con la carga
 * del contenedor: un pegado que llega antes de que el lector de entrada esté listo se PIERDE sin
 * error —comprobado— y el turno se quedaría esperando una respuesta que nunca se pidió.
 *
 * Vale igual para codex desde que `inputBoxState` reconoce su cursor `›` y trata como VACÍO el
 * texto fantasma atenuado que dibuja cuando la caja está libre. Antes de eso, la caja de codex
 * parecía ocupada para siempre y todo turno degradaba a los 90 s.
 *
 * Distingue TRES desenlaces, y el del medio es nuevo: un panel MUERTO no se puede esperar. Antes
 * sólo se miraba la caja, y un panel que salía al instante —lo que hace `claude --continue` cuando
 * no hay nada que continuar— dejaba a `capturePane` devolviendo `undefined`, que `inputBoxState`
 * llama «ocupado». El resultado era esperar el plazo ENTERO (90 s por defecto) delante de una
 * sesión que ya no existía, y sólo después declararla ausente. Con la reanudación eso además
 * retrasaría 90 s el arranque en blanco de un alias que se quedó sin panel.
 */
async function waitForTui(
  tmux: TmuxController,
  target: string,
  options: EnsureOptions,
): Promise<"ready" | "gone" | "timeout"> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  for (;;) {
    const pane = await capturePane(tmux, target, { styled: true });
    if (!inputBoxState(pane).occupied) return "ready";
    // Se pregunta por el panel sólo cuando la caja NO estaba libre: si estaba libre hay TUI viva y
    // preguntar sobraría. Así el sondeo caro se paga únicamente mientras la TUI arranca.
    if (await panePid(tmux, target) === undefined) return "gone";
    if (Date.now() >= deadline) return "timeout";
    await options.sleep(READY_POLL_MS);
  }
}

export interface SharedSessionStatus {
  readonly alias: string;
  readonly harness: SharedSessionHarness;
  readonly session: string;
  readonly present: boolean;
  readonly pid?: string;
}

export async function sharedSessionStatus(
  tmux: TmuxController,
  spec: SharedSessionSpec,
): Promise<SharedSessionStatus> {
  const session = sessionName(spec.alias);
  const present = await hasSession(tmux, session);
  const pid = present ? await panePid(tmux, tuiTarget(spec.alias)) : undefined;
  return {
    alias: spec.alias,
    harness: spec.harness,
    session,
    present,
    ...(pid === undefined ? {} : { pid }),
  };
}
