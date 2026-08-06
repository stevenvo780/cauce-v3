import type { CommandRunner, HarnessId } from "../sdk/types.js";

/**
 * Los dos harness que tienen sesión compartida real. Y se conducen IGUAL.
 *
 * Ninguno de los dos expone un protocolo que sirva para esto. En claude, `--input-format
 * stream-json` sólo funciona con `--print` (headless, sin TUI), `--tmux` es para worktrees y
 * `--remote-control` es la nube de Anthropic. En codex existe `app-server --listen unix://`, y se
 * probó: el turno entraba, pero el camino traía cuatro piezas propias (servidor, socket, websocket
 * y un handshake de cuatro llamadas) y el 2026-07-31 se quedó colgado en `turn/start` sin que el
 * log del servidor registrara nada. El mismo día se comprobó EN VIVO que pegar en su caja de
 * entrada funciona igual de bien que en claude —`send-keys -l` + Enter, respuesta en el panel—, y
 * que su rollout `.jsonl` trae el turno con un `turn_id` tipado.
 *
 * Así que hay UN solo mecanismo: pegar en la caja de la TUI y cosechar del registro que el propio
 * harness escribe. Lo único que cambia entre los dos es ese registro, y eso vive detrás de
 * `TranscriptReader`.
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
  /** La sesión existe pero no hay TUI viva del harness dentro. */
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
  /**
   * El pegado no entró: tmux lo rechazó, o la TUI nunca registró el turno.
   *
   * Se conserva el nombre porque ya está en el log durable y en los avisos que el dueño leyó. Lo
   * que significa hoy es "el pedido NO llegó a la caja de entrada", y por eso es seguro caer al
   * camino de siempre: si no llegó, no corrió nada que se pueda duplicar.
   */
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
   * En los dos se detecta igual: el turno cae en OTRO registro que el del turno anterior sin que
   * el proceso se reinicie —medido en claude: `pane_pid` idéntico antes y después, así que el
   * heurístico de PID NO lo ve jamás—. En codex, `/new` abre un rollout nuevo con otro session_id.
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
  | "context_compacted"
  /**
   * El pegado se FUNDIÓ con un turno que ya estaba corriendo, y el sobre se correlacionó por el
   * registro en vez de por la cadena de turnos.
   *
   * `fellBack: false`: el turno pasó por la terminal del dueño, se ejecutó entero y su respuesta es
   * la que vuelve. Lo que no se pudo probar es la ascendencia, porque nunca hubo un turno propio del
   * que descender: cuando el panel está ocupado, claude ENCOLA el pegado y lo funde en el turno en
   * curso (`queue-operation enqueue` y, unos segundos después, `remove`).
   *
   * Se avisa porque la respuesta contesta a la vez lo que el dueño estaba pidiendo y lo que pidió el
   * bus, y porque hasta el 2026-08-06 este caso MATABA la entrega: la correlación no enganchaba
   * jamás, a los 300 s exactos salía `timedOut` con "Harness exceeded its execution deadline" y sin
   * reintento. Medido en la entrega `6c7cb0c4` (janus -> kratos): 301 s de ejecución, y el
   * entregable completo ya escrito con su sobre emitido 96 s ANTES de que la declararan muerta.
   */
  | "turn_merged";

/**
 * De dónde sale el sobre en un harness concreto. Es lo ÚNICO que los diferencia.
 *
 * El pegado, el arbitraje de la caja, la detección de reinicios, los avisos y la ambigüedad del
 * turno ya inyectado son idénticos para los dos, y por eso viven una sola vez en
 * `PasteSessionRunner`. Lo que cambia es el fichero que escribe cada TUI y cómo se correlaciona en
 * él el turno que acabamos de pegar:
 *
 *  - claude: `.jsonl` por proyecto, correlación por texto exacto y DESCENDENCIA de uuid.
 *  - codex: rollout por fecha, correlación por texto exacto y `turn_id` tipado.
 *
 * Ninguna implementación puede leer la PANTALLA: el sobre sale del registro o no sale. Una pantalla
 * de 100 columnas parte un sobre largo y no se puede recomponer.
 */
export interface TranscriptSlice<E> {
  /** Lo que hace falta para correlacionar. Puede ser el fichero entero si el harness lo exige. */
  readonly entries: readonly E[];
  /** Sólo lo escrito después del corte, que es lo que pudo pasar durante este turno. */
  readonly appended: readonly E[];
}

/** El turno que creó nuestro pegado, ya identificado dentro del registro. */
export interface InjectedTurn {
  /** Con qué se sigue el turno: el uuid de la entrada en claude, el `turn_id` en codex. */
  readonly key: string;
  /** Identidad de la conversación, para detectar un vaciado y para el `session_id` del resultado. */
  readonly sessionId?: string;
}

/**
 * Cómo terminó el turno, cuando ya se puede afirmar que terminó.
 *
 * `failed` existe para que una interrupción del dueño (Esc en la TUI de codex) no se pague con
 * media hora de silencio: sin esto el turno agota el presupuesto y sale `timedOut`, que el
 * adaptador trata como AMBIGUO y no reintenta. Con esto se dice lo que pasó.
 */
export type TurnOutcome =
  | { readonly kind: "answer"; readonly text: string; readonly sessionId?: string }
  | { readonly kind: "failed"; readonly detail: string };

/** Una compactación ocurrida durante el turno, con un id estable para no repetir el aviso. */
export interface CompactionNotice {
  readonly id: string;
  readonly detail: string;
}

export interface TranscriptReader<E> {
  /** Los ficheros del registro. Recursivo si el harness los reparte en carpetas. */
  files(): Promise<readonly string[]>;
  /** Lee desde `offset`; `entries` es lo que hace falta para correlacionar, `appended` sólo lo nuevo. */
  read(file: string, offset: number): Promise<TranscriptSlice<E>>;
  /** La entrada que creó ESTE turno, identificada por el texto exacto que se pegó. */
  findInjected(file: string, entries: readonly E[], promptText: string): InjectedTurn | undefined;
  /** El desenlace de ese turno, o `undefined` mientras siga corriendo. */
  findAnswer(entries: readonly E[], key: string): TurnOutcome | undefined;
  /**
   * EL SOBRE, cuando la ascendencia no lo puede probar. La red que impide tirar trabajo terminado.
   *
   * `findInjected` + `findAnswer` correlacionan por ascendencia, y eso tiene un supuesto que no
   * siempre se cumple: que el pegado abrió un turno PROPIO. Cuando el panel está ocupado, claude
   * encola el pegado y lo funde en el turno en curso; entonces esa entrada de usuario no existe
   * nunca y la correlación no puede enganchar jamás por mucho que se espere. Pero el turno corre, y
   * al terminar escribe el sobre.
   *
   * Por eso la regla del runner es: la ascendencia es un DESEMPATE, el sobre es la PRUEBA. Si el
   * sobre apareció después del pegado, la entrega no muere.
   *
   * Se le pasa siempre y sólo lo escrito DESPUÉS del pegado —o, cuando el turno propio sí se
   * localizó pero su cadena de padres está rota, `desde` acota a partir de él— así que un sobre
   * anterior no se puede colar. Ausente = este registro no sabe reconocer un sobre, y el runner se
   * comporta como antes.
   */
  findEnvelope?(entries: readonly E[], desde?: string): TurnOutcome | undefined;
  compactions(appended: readonly E[]): readonly CompactionNotice[];
  /**
   * ¿Arrancó ALGÚN turno en lo nuevo? Ausente = este registro no lo sabe decir.
   *
   * Es lo que separa "el pegado no llegó a la caja" (no corrió nada: degradar es seguro) de "corrió
   * algo que no supe correlacionar" (ambiguo: reejecutar duplicaría efectos externos). Sin esta
   * pregunta las dos son la misma espera muda hasta el plazo.
   */
  startedTurn?(appended: readonly E[]): boolean;
  /** El resultado con la forma NATIVA del harness, que parsea el mismo `parse` de siempre. */
  stdout(text: string, sessionId: string | undefined): string;
}

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
