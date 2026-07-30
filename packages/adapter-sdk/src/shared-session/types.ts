import type { CommandRunner, HarnessId } from "../sdk/types.js";

/**
 * Los dos harness que tienen sesión compartida real, y NO son intercambiables.
 *
 * `claude` no expone ningún protocolo local: `--input-format stream-json` sólo funciona con
 * `--print` (headless, sin TUI), `--tmux` es para worktrees y `--remote-control` es la nube de
 * Anthropic. Se conduce su TUI real por tmux y el sobre se cosecha del transcript `.jsonl`.
 *
 * `codex` sí tiene demonio de primera parte (`app-server --listen unix://`), así que el turno del
 * bus entra por protocolo y el sobre llega como campo tipado.
 *
 * La respuesta distinta por harness no es una inconsistencia: es la consecuencia de que uno tenga
 * API local y el otro no.
 */
export type SharedSessionHarness = Extract<HarnessId, "claude" | "codex">;

export function isSharedSessionHarness(harness: HarnessId): harness is SharedSessionHarness {
  return harness === "claude" || harness === "codex";
}

/**
 * Por qué un turno del bus NO pudo pasar por la sesión compartida.
 *
 * Cada valor nombra un fallo distinto porque el dueño tiene que poder distinguirlos sin leer
 * código: "no hay sesión" se arregla abriendo `cauce <alias>`, "la caja estaba ocupada" se
 * arregla soltando la línea a medio escribir, y "no pude hablar con el mecanismo" es un
 * incidente.
 */
export type DegradationReason =
  /** No existe la sesión tmux, o no se pudo crear. */
  | "session_absent"
  /** La sesión existe pero no hay TUI viva del harness dentro (o el hilo de codex no está cargado). */
  | "tui_absent"
  /** El dueño tenía texto a medio escribir en la caja y nunca la soltó dentro del plazo. */
  | "input_busy"
  /**
   * La TUI está esperando que el dueño conteste un DIÁLOGO, no que suelte una línea.
   *
   * Se separa de `input_busy` porque la acción del dueño es distinta y opuesta: ante `input_busy`
   * hay que borrar lo tecleado, ante esto hay que CONTESTAR el diálogo (confiar en la carpeta,
   * elegir modelo, aprobar un permiso). Medido el 2026-07-30 con claude 2.1.220: los tres modales
   * probados dejan la caja "ocupada", así que el mecanismo ya fallaba cerrado — lo que mentía era
   * el mensaje que leía el dueño.
   */
  | "modal_blocking"
  /** El mecanismo está pero no habla: socket que no responde, handshake rechazado. */
  | "handshake_failed"
  /**
   * La TUI se reinició entre dos turnos del bus y la conversación empezó de cero.
   *
   * Es uno de los valores con `fellBack: false`: el turno SÍ pasó por la terminal, pero el
   * contexto anterior ya no está. Se avisa igual porque desde afuera "compartida y vacía" es
   * indistinguible de "compartida y con la conversación entera", y esa confusión es exactamente
   * la que el dueño lleva tres intentos padeciendo. La causa medida es que `claude` se
   * auto-actualiza y se relanza solo.
   */
  | "context_reset"
  /**
   * No había sesión compartida y el adaptador tuvo que CREARLA para servir este turno.
   *
   * `fellBack: false`: el turno pasa por una terminal real, pero por una terminal RECIÉN NACIDA y
   * vacía, que el dueño no estaba mirando. Medido el 2026-07-30: borrada la sesión, la entrega se
   * respondió en 75,9 s con `exitCode 0` y CERO avisos, porque `ensure` ya devolvía `created:true`
   * y el runner lo descartaba. Un contexto compartido que se resucita en silencio es exactamente
   * el éxito silencioso que este trabajo existe para eliminar.
   */
  | "session_created"
  /**
   * El dueño vació el contexto a propósito: `/clear` en claude, `/new` en codex.
   *
   * `fellBack: false` y NO se bloquea la inyección: vaciar es una acción deliberada y degradar
   * castigaría al dueño por hacer justo lo que quería (además, el camino de siempre también
   * arrancaría sin contexto). Lo que no puede pasar es que el remitente siga creyendo que habla
   * con el mismo hilo.
   *
   * En claude se detecta porque el `.jsonl` activo cambia de `sessionId` sin que el proceso se
   * reinicie —medido: `pane_pid` idéntico antes y después, así que el heurístico de PID NO lo ve
   * jamás—. En codex, porque `thread/loaded/list` empieza a devolver un hilo más.
   */
  | "context_cleared"
  /**
   * La terminal compactó su contexto: lo anterior quedó RESUMIDO, no íntegro.
   *
   * Distinto de `context_cleared` porque nadie lo pidió y la pérdida es parcial: es degradación de
   * calidad, no de identidad. Por eso el aviso lleva las cifras que el propio evento trae
   * (`preTokens`→`postTokens`) y va también al panel: el dueño es el único que puede compensar
   * volviendo a pegar lo importante.
   */
  | "context_compacted";

export interface SharedSessionDegradation {
  readonly reason: DegradationReason;
  /** Texto corto y ya saneado. Llega al dueño por Telegram y al log durable. */
  readonly detail: string;
  readonly occurredAt: string;
  /**
   * `true` cuando el turno se sirvió por el camino de siempre en vez de por la sesión compartida.
   *
   * Separa "no compartimos nada" de "compartimos, pero perdimos la memoria": son incidentes
   * distintos y el aviso que lee el dueño dice cosas distintas en cada caso.
   */
  readonly fellBack: boolean;
}

/**
 * Un runner que ADEMÁS declara si el turno pasó de verdad por la sesión compartida.
 *
 * `takeDegradation()` se consume una sola vez por turno, inmediatamente después de `run()`. Es el
 * mecanismo que impide el fallo del intento anterior: allí el turno del bus se iba por el camino
 * de siempre y nadie se enteraba porque nada en el resultado decía que la sesión compartida no
 * había participado. Acá esa información viaja pegada al resultado y termina dentro del "reply".
 */
export interface SharedSessionRunner extends CommandRunner {
  takeDegradation(): SharedSessionDegradation | undefined;
}

export function isSharedSessionRunner(runner: CommandRunner): runner is SharedSessionRunner {
  return typeof (runner as Partial<SharedSessionRunner>).takeDegradation === "function";
}

/** Nombre de la sesión tmux de un alias. Estable: lo usan el adaptador y `cauce <alias>`. */
export function sessionName(alias: string): string {
  return `cauce-${alias}`;
}

/**
 * Socket tmux propio de Cauce.
 *
 * Deliberadamente NO es el socket por defecto: la flota ya tiene sesiones tmux levantadas por el
 * cron de jarvis (`tmux new-session -d -s <alias>`) y mezclarlas haría que apagar una cosa apague
 * la otra.
 */
export const TMUX_SOCKET = "cauce";

/** Ventana donde vive la TUI que ve el dueño. */
export const TUI_WINDOW = "agente";

/**
 * El nombre con el que una versión anterior RENOMBRABA la ventana al degradar.
 *
 * Se conserva sólo para poder DESHACERLO. Aquel renombrado se auto-enclavaba: `tuiTarget()` busca
 * `cauce-<alias>:agente`, así que en cuanto el primer aviso renombraba la ventana, `windowExists`
 * dejaba de encontrarla, `panePid` devolvía `undefined` y TODAS las entregas siguientes degradaban
 * `tui_absent` en 0,2 s —para siempre, con la TUI viva y sana delante— diciéndole además al dueño
 * la mentira «la sesión existe pero no tiene panel de TUI». Verificado de punta a punta el
 * 2026-07-30. Hoy no se renombra nada; ver `announceDegradation`.
 */
export const LEGACY_DEGRADED_WINDOW = "⚠ CAUCE-DEGRADADO";

/** Ventana donde vive el app-server de codex. Sólo existe para el harness codex. */
export const SERVER_WINDOW = "servidor";
