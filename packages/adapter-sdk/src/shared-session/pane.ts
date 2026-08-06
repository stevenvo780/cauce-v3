/**
 * Arbitraje de la caja de entrada, y sólo eso.
 *
 * Este módulo lee la PANTALLA, que es exactamente lo que la salida (b) hacía y por lo que quedó
 * descartada. La diferencia no es de método sino de qué se decide con lo leído:
 *
 *  - (b) sacaba EL SOBRE de la pantalla. Imposible de garantizar: el wrapping parte el JSON, el
 *    scrollback no existe (claude vive en pantalla alterna, `history_size=0`) y el eco del pedido
 *    contiene otra copia del JSON, así que el raspador no distinguía pregunta de respuesta.
 *  - acá la pantalla sólo responde "¿el dueño tiene algo a medio escribir?". Si la heurística se
 *    equivoca no se corrompe ningún resultado: en el peor caso se espera de más y se degrada con
 *    aviso, o se pisa una línea a medio escribir — molesto, nunca silencioso.
 *
 * El sobre NUNCA sale de acá. Sale del transcript.
 */

/** Marcas que la TUI de claude deja cuando la caja tiene un pegado sin enviar. */
const PENDING_PASTE_MARKS = ["[Pasted text", "paste again to expand"];

/**
 * Caracteres con los que la TUI dibuja el cursor de entrada.
 *
 * `❯` es el de claude y `›` (U+203A) el de codex. Sin el de codex el barrido de abajo
 * hacia arriba pasaba de largo la caja real y enganchaba el banner `>_ OpenAI Codex (vX)` del
 * propio programa, que empieza por `>` y nunca cambia: la caja quedaba "ocupada" para siempre y
 * TODO turno degradaba a los 90 s. Medido en el panel vivo de socrates el 2026-07-31.
 *
 * `»` (U+00BB) es el MISMO cursor de codex redibujado a partir de codex-cli 0.145.0. Sin él el
 * barrido no encuentra ninguna caja, y un panel con contenido pero sin caja se declara «diálogo a
 * pantalla completa»: el turno degrada con `modal_blocking` inventando un modal que no existe, el
 * adaptador suelta el panel del dueño y contesta por el camino de respaldo. El dueño deja de ver a
 * su agente sin que nada falle, y reiniciar no lo arregla porque el glifo sigue siendo el mismo.
 * Medido con volcado hexadecimal el 2026-08-05 en el panel vivo de kant (`c2 bb 20` = `» `), contra
 * `e2 80 ba 20` (`› `) en los alias que todavía corren 0.144.x.
 */
const PROMPT_MARKS = ["❯", "›", "»", ">"];

/**
 * Por qué no se puede inyectar ahora mismo. La distinción NO cambia la decisión —en los tres casos
 * se espera y, si no se libera, se degrada— pero sí cambia lo que hay que hacer para arreglarlo,
 * que es lo único que el dueño lee.
 *
 *  - `busy`: hay una línea a medio escribir. Se resuelve sola en segundos, o borrándola.
 *  - `modal`: la TUI está esperando una RESPUESTA a un diálogo (confiar en la carpeta, elegir
 *    modelo, aprobar un permiso). No se resuelve sola: hay que contestarlo. Medido el 2026-07-30
 *    con claude 2.1.220, los tres modales probados dejaban la caja "ocupada" y el aviso decía
 *    «soltá la línea a medio escribir», que es exactamente lo que NO había que hacer.
 */
export type InputBoxKind = "free" | "busy" | "modal";

export interface InputBoxState {
  readonly occupied: boolean;
  readonly kind: InputBoxKind;
  /** Qué se vio, para el detalle del aviso. Ya recortado. */
  readonly evidence: string;
}

/**
 * Cómo se reconoce un diálogo: la línea de prompt es una OPCIÓN NUMERADA.
 *
 * Medido: `❯ 1. Yes, I trust this folder` (confianza de carpeta) y `❯ 2. Opus (1M context) ✔`
 * (`/model`). No es infalible —el dueño podría teclear literalmente "1. algo"— y no hace falta que
 * lo sea: equivocarse acá sólo cambia el TEXTO del aviso, nunca si se inyecta o no.
 */
const MODAL_OPTION = /^\d+\.\s/u;

/**
 * ¿Hay texto del dueño esperando en la caja?
 *
 * La colisión que esto evita está medida: con una línea a medio escribir, inyectar dejó
 * `❯ estoy escribiendo algo a mediasMENSAJE DEL BUS que llega en medio`. Hay UNA sola caja de
 * entrada y el bus no puede escribir en ella sin permiso.
 *
 * Un panel que no se pudo capturar cuenta como ocupado. Fallar cerrado acá es correcto: preferimos
 * degradar con aviso a pisar lo que el dueño estaba escribiendo.
 */
export function inputBoxState(pane: string | undefined): InputBoxState {
  if (pane === undefined) {
    return { occupied: true, kind: "busy", evidence: "no se pudo capturar el panel" };
  }
  const lines = pane.split(/\r?\n/u);

  for (const mark of PENDING_PASTE_MARKS) {
    if (lines.some((line) => line.includes(mark))) {
      return { occupied: true, kind: "busy", evidence: `hay un pegado sin enviar (${mark})` };
    }
  }

  const promptLine = lastPromptLine(lines);
  if (promptLine === undefined) {
    // Un panel EN BLANCO es una TUI que todavía no dibujó nada, no un diálogo: llamarlo modal
    // mandaría al dueño a contestar algo que no existe. Un panel con contenido pero SIN caja sí es
    // un diálogo a pantalla completa — medido con `/config`, que la tapa entera.
    if (pane.trim().length === 0) {
      return { occupied: true, kind: "busy", evidence: "el panel está en blanco" };
    }
    return {
      occupied: true,
      kind: "modal",
      evidence: "no se encontró la caja de entrada en el panel (hay un diálogo a pantalla completa)",
    };
  }
  if (promptLine.length === 0) return { occupied: false, kind: "free", evidence: "" };
  if (MODAL_OPTION.test(promptLine)) {
    return {
      occupied: true,
      kind: "modal",
      evidence: `la TUI está esperando una respuesta a un diálogo (${promptLine.slice(0, 60)})`,
    };
  }
  return {
    occupied: true,
    kind: "busy",
    evidence: `hay texto sin enviar en la caja (${promptLine.slice(0, 60)})`,
  };
}

/**
 * El contenido de la última línea de prompt, ya sin el cursor ni los bordes del recuadro.
 *
 * Se recorre de abajo hacia arriba porque la caja de entrada es lo último que dibuja la TUI; por
 * encima está la conversación, donde un `>` cualquiera del texto no significa nada.
 */
function lastPromptLine(lines: readonly string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const raw = lines[index];
    if (raw === undefined) continue;
    // El recuadro de la caja puede envolver la línea en bordes verticales.
    const line = stripSgr(raw).replace(/^\s*│/u, "").replace(/│\s*$/u, "").trim();
    for (const mark of PROMPT_MARKS) {
      if (!line.startsWith(mark)) continue;
      const content = line.slice(mark.length).trim();
      // El texto FANTASMA de codex (la sugerencia de ejemplo que dibuja cuando la caja está
      // vacía) viene atenuado; lo que el dueño teclea de verdad, nunca. Verificado el 2026-07-31
      // contra el panel vivo de socrates: `› Find and fix a bug in @filename` con SGR
      // ['1','0','2','0'] — el 2 es el dim. Si la línea no trae estilos (captura sin `-e`) esto
      // no se activa nunca y el comportamiento queda idéntico al anterior.
      if (content !== "" && isEntirelyDim(raw, mark)) return "";
      return content;
    }
  }
  return undefined;
}

/** Quita los códigos SGR para poder comparar el texto. */
function stripSgr(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

/**
 * ¿Todo lo que sigue a la marca del cursor está atenuado?
 *
 * Se mira SÓLO la línea del cursor y SÓLO cuando la captura trae estilos, así que no puede
 * tragarse texto real: en claude el texto sin enviar se dibuja normal. La alternativa que se
 * descartó —tratar como vacío todo lo dim del panel— sí se lo comía, y está medida.
 */
function isEntirelyDim(raw: string, mark: string): boolean {
  const at = raw.indexOf(mark);
  if (at < 0) return false;
  const tail = raw.slice(at + mark.length);
  // eslint-disable-next-line no-control-regex
  const segments = tail.split(/\u001b\[([0-9;]*)m/gu);
  let dim = false;
  let vioTextoNoAtenuado = false;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg === undefined) continue;
    if (i % 2 === 1) {
      const codes = seg.split(";").filter((c) => c !== "");
      if (codes.length === 0 || codes.includes("0")) dim = false;
      if (codes.includes("2")) dim = true;
      continue;
    }
    if (seg.trim() !== "" && !dim) vioTextoNoAtenuado = true;
  }
  return !vioTextoNoAtenuado;
}
