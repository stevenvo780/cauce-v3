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

/** Caracteres con los que la TUI dibuja el cursor de entrada. */
const PROMPT_MARKS = ["❯", ">"];

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
    const line = raw.replace(/^\s*│/u, "").replace(/│\s*$/u, "").trim();
    for (const mark of PROMPT_MARKS) {
      if (line.startsWith(mark)) return line.slice(mark.length).trim();
    }
  }
  return undefined;
}
