/**
 * Detección del estado de la caja de entrada y actividad en pantalla para paneles tmux de TUI.
 */

/** Marcas que la TUI de claude deja cuando la caja tiene un pegado sin enviar. */
const PENDING_PASTE_MARKS = ["[Pasted text", "paste again to expand"];

/** Caracteres de cursor de prompt soportados en las distintas TUIs (Claude, Codex). */
const PROMPT_MARKS = ["❯", "›", "»", ">"];

/** Clasificación del estado de disponibilidad de la caja de entrada. */
export type InputBoxKind = "free" | "busy" | "modal";

export interface InputBoxState {
  readonly occupied: boolean;
  readonly kind: InputBoxKind;
  /** Qué se vio, para el detalle del aviso. Ya recortado. */
  readonly evidence: string;
}

/** Reconocimiento de opciones numeradas en diálogos modales de la TUI. */
const MODAL_OPTION = /^\d+\.\s/u;

/** Determina si la caja de entrada está libre, ocupada con texto o bloqueada por un diálogo modal. */
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

/** Patrón indicador de generación activa en la TUI. */
const IN_FLIGHT_MARK = /\besc(?:ape)?\s+to\s+interrupt\b/iu;

/** Determina si la TUI se encuentra actualmente generando una respuesta. */
export function turnInFlight(pane: string | undefined): boolean {
  if (pane === undefined) return false;
  const lines = pane.split(/\r?\n/u).map(stripSgr);
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return lines.slice(Math.max(0, end - IN_FLIGHT_WINDOW), end)
    .some((line) => IN_FLIGHT_MARK.test(line));
}

/** Cuántas líneas alrededor de la caja de entrada cuentan como "franja de estado". */
const IN_FLIGHT_WINDOW = 6;

/**
 * El contenido de la última línea de prompt, ya sin el cursor ni los bordes del recuadro.
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
      // Descarta texto de sugerencia atenuado (placeholder) cuando la caja está vacía.
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
 * Verifica si el texto posterior al cursor contiene únicamente estilos atenuados (dim/placeholder).
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
