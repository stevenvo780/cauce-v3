/**
 * Detection of input box state and on-screen activity for tmux TUI panes.
 */

/** Marks that the claude TUI leaves when the box holds an unsent paste. */
const PENDING_PASTE_MARKS = ["[Pasted text", "paste again to expand"];

/** Prompt cursor characters supported across TUIs (Claude, Codex). */
const PROMPT_MARKS = ["❯", "›", "»", ">"];

/** Input box availability classification. */
export type InputBoxKind = "free" | "busy" | "modal";

export interface InputBoxState {
  readonly occupied: boolean;
  readonly kind: InputBoxKind;
  /** What was seen, for the notice detail. Already trimmed. */
  readonly evidence: string;
}

/** Recognition of numbered options in TUI modal dialogs. */
const MODAL_OPTION = /^\d+\.\s/u;

/** Determines whether the input box is free, busy with text, or blocked by a modal dialog. */
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

/** Pattern that indicates the TUI is actively generating. */
const IN_FLIGHT_MARK = /\besc(?:ape)?\s+to\s+interrupt\b/iu;

/** Determines whether the TUI is currently generating a reply. */
export function turnInFlight(pane: string | undefined): boolean {
  if (pane === undefined) return false;
  const lines = pane.split(/\r?\n/u).map(stripSgr);
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return lines.slice(Math.max(0, end - IN_FLIGHT_WINDOW), end)
    .some((line) => IN_FLIGHT_MARK.test(line));
}

/** How many lines around the input box count as the "status band". */
const IN_FLIGHT_WINDOW = 6;

/**
 * The contents of the last prompt line, with the cursor and box borders removed.
 */
function lastPromptLine(lines: readonly string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const raw = lines[index];
    if (raw === undefined) continue;
    // The input box can wrap the line in vertical borders.
    const line = stripSgr(raw).replace(/^\s*│/u, "").replace(/│\s*$/u, "").trim();
    for (const mark of PROMPT_MARKS) {
      if (!line.startsWith(mark)) continue;
      const content = line.slice(mark.length).trim();
      // Discards dim suggestion text (placeholder) when the box is empty.
      if (content !== "" && isEntirelyDim(raw, mark)) return "";
      return content;
    }
  }
  return undefined;
}

/** Strips SGR codes so the text can be compared. */
function stripSgr(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

/**
 * Checks whether the text after the cursor contains only dim (placeholder) styles.
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
