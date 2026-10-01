/**
 * Detection of input box state and on-screen activity for tmux TUI panes.
 */

/** Marks that the claude TUI leaves when the box holds an unsent paste. */
const PENDING_PASTE_MARKS = ["[Pasted text", "paste again to expand"];

/** Prompt cursor characters supported across TUIs (Claude, Codex, Grok). */
const PROMPT_MARKS = ["❯", "›", "»", ">"];

/** Input box availability classification. */
type InputBoxKind = "free" | "busy" | "modal";

interface InputBoxState {
  readonly occupied: boolean;
  readonly kind: InputBoxKind;
  /** What was seen, for the notice detail. Already trimmed. */
  readonly evidence: string;
  readonly thinking?: true; // codex's «extra thought» notice closes itself: a turn in flight
  readonly unfocused?: true; // grok's box without focus: what it shows is not what focus would reveal
}

const THINKING_NOTICE = /^\d+\.\s+Dismiss and keep waiting\b/iu; // the menu option itself, not words in scrollback

/** Recognition of numbered options in TUI modal dialogs. */
const MODAL_OPTION = /^\d+\.\s/u;

/** Determines whether the input box is free, busy with text, or blocked by a modal dialog. */
export function inputBoxState(pane: string | undefined): InputBoxState {
  if (pane === undefined) {
    return { occupied: true, kind: "busy", evidence: "no se pudo capturar el panel" };
  }
  const lines = pane.split(/\r?\n/u);
  if (grokPromptUnfocused(pane)) {
    return { occupied: true, kind: "busy", unfocused: true, evidence: "la caja de grok no tiene el foco (Space:prompt)" };
  }

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
    if (THINKING_NOTICE.test(promptLine)) {
      return { occupied: true, kind: "busy", thinking: true, evidence: "la TUI está pensando (aviso de codex que se cierra solo)" };
    }
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

const IN_FLIGHT_MARKS: readonly RegExp[] = [
  /\besc(?:ape)?\s+to\s+interrupt\b/iu,
  /\bctrl\+b\b[^\n]*\bto\s+run\s+in\s+background\b/iu,
  /↓\s*[\d.]+\s*k?\s+tokens\b/iu,
  // grok 1.0.41 spinner (`⠸ Thinking… 0.7s ⇣2.42k [stop]`); only read when its footer is not on screen.
  /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s.*….*\[stop\][\s█▐▌]*$/u,
];

function inFlightMark(line: string): boolean {
  return IN_FLIGHT_MARKS.some((mark) => mark.test(line));
}

const GROK_UNFOCUSED = /(?:^|\s)Space:prompt(?:\s|$)/u; // grok 1.0.41 with the scrollback focused (Tab, a click)

/** grok's LAST line (`…Ctrl+x:shortcuts`/`…press again to quit`): on screen it alone decides (`Ctrl+c:cancel`). */
function grokFooterState(lastLine: string): "in_flight" | "idle" | undefined {
  const footer = /\bCtrl\+x:shortcuts\b/u.test(lastLine)
    || /\bCtrl\+c:press again to quit\b/u.test(lastLine)
    || GROK_UNFOCUSED.test(lastLine);
  if (!footer) return undefined;
  return /\bCtrl\+c:cancel\b/u.test(lastLine) ? "in_flight" : "idle";
}

/** Determines whether the TUI is currently generating a reply. */
export function turnInFlight(pane: string | undefined): boolean {
  if (pane === undefined) return false;
  const lines = pane.split(/\r?\n/u).map(stripSgr);
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  const footer = end > 0 ? grokFooterState(lines[end - 1] ?? "") : undefined;
  if (footer !== undefined) return footer === "in_flight";
  return lines.slice(Math.max(0, end - IN_FLIGHT_WINDOW), end)
    .some((line) => inFlightMark(line));
}

const IN_FLIGHT_WINDOW = 12;

export function pastedChipKb(pane: string | undefined): number | undefined { // KB of a box holding ONLY a paste chip (`[Pasted: 13 KB]`).
  const chip = /^\[Pasted: ([\d.]+) ?KB\]$/u.exec(pane === undefined ? "" : lastPromptLine(pane.split(/\r?\n/u)) ?? "");
  return chip?.[1] === undefined ? undefined : Number(chip[1]);
}

export function grokPromptUnfocused(pane: string | undefined): boolean { // The box then shows a grey «Build anything» or the owner's text in plain 256 colors (reads as typed); Space focuses without inserting (measured).
  if (pane === undefined) return false;
  const lines = pane.split(/\r?\n/u).map(stripSgr);
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return end > 0 && GROK_UNFOCUSED.test(lines[end - 1] ?? "");
}

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
