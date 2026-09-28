import type { SharedSessionHarness } from "./types.js";

/**
 * How each shared TUI behaves at the few points where the paste runner has to act on it.
 *
 * Everything else (paste, barrier, quarantine, harvest) is identical for every harness; what
 * differs is measured behavior of the real binary, so it lives in data, not in ternaries spread
 * over the runner. The switch is exhaustive: a new shared harness does not compile until it
 * declares its own row.
 */
export interface TuiProfile {
  /** tmux key that cancels an in-flight turn. */
  readonly interruptKey: "Escape" | "C-c";
  /**
   * Send the interrupt ONLY while the pane shows a turn in flight.
   *
   * grok 1.0.41: C-c during a turn cancels it; C-c on an idle TUI arms "press again to quit" and a
   * second one within ~1 s kills the TUI. So it can never be sent blind.
   */
  readonly interruptOnlyWhileGenerating: boolean;
  /**
   * Take the input box only when no turn is in flight.
   *
   * claude merges a paste into the running turn; grok QUEUES it and runs it later as its own turn
   * (`[ui].follow_up_behavior = "queue"`). Pasting over a busy grok would leave the bus prompt
   * waiting behind the owner's turn with its MCP emission already open, so grok waits for idle.
   */
  readonly pasteOnlyWhenIdle: boolean;
  /** The command that clears the conversation in this TUI, for the owner-facing notice. */
  readonly clearCommand: string;
}

export function tuiProfile(harness: SharedSessionHarness): TuiProfile {
  switch (harness) {
    case "claude":
      return {
        interruptKey: "Escape",
        interruptOnlyWhileGenerating: false,
        pasteOnlyWhenIdle: false,
        clearCommand: "/clear",
      };
    case "codex":
      return {
        interruptKey: "Escape",
        interruptOnlyWhileGenerating: false,
        pasteOnlyWhenIdle: false,
        clearCommand: "/new",
      };
    case "grok":
      return {
        interruptKey: "C-c",
        interruptOnlyWhileGenerating: true,
        pasteOnlyWhenIdle: true,
        clearCommand: "/new",
      };
    // Muse 1.4.0: `esc to interrupt` on the working line. A paste over a running turn is queued as a
    // steer ("Queued input") and runs later as its own run, so it waits for idle like grok.
    // `/clear` starts a fresh session (a NEW id), which the native witness then follows.
    case "muse":
      return {
        interruptKey: "Escape",
        interruptOnlyWhileGenerating: true,
        pasteOnlyWhenIdle: true,
        clearCommand: "/clear",
      };
  }
}
