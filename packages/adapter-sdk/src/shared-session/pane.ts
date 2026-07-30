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

export interface InputBoxState {
  readonly occupied: boolean;
  /** Qué se vio, para el detalle del aviso. Ya recortado. */
  readonly evidence: string;
}

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
    return { occupied: true, evidence: "no se pudo capturar el panel" };
  }
  const lines = pane.split(/\r?\n/u);

  for (const mark of PENDING_PASTE_MARKS) {
    if (lines.some((line) => line.includes(mark))) {
      return { occupied: true, evidence: `hay un pegado sin enviar (${mark})` };
    }
  }

  const promptLine = lastPromptLine(lines);
  if (promptLine === undefined) {
    return { occupied: true, evidence: "no se encontró la caja de entrada en el panel" };
  }
  if (promptLine.length === 0) return { occupied: false, evidence: "" };
  return {
    occupied: true,
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
