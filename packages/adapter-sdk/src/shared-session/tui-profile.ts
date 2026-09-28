import type { SharedSessionHarness } from "./types.js";

/** How each shared TUI behaves at the few points the paste runner acts on it: everything else (paste, barrier, quarantine, harvest) is identical across harnesses, but measured binary behavior lives here as data, not scattered ternaries; the switch is exhaustive, so a new harness must add its own row to compile. */
export interface TuiProfile {
  /** tmux key that cancels an in-flight turn. */
  readonly interruptKey: "Escape" | "C-c";
  /** Send the interrupt ONLY while the pane shows a turn in flight: grok 1.0.41 arms "press again to quit" on C-c when idle (a second C-c within ~1 s kills the TUI), so it must never be sent blind. */
  readonly interruptOnlyWhileGenerating: boolean;
  /** Take the input box only when no turn is in flight: claude merges a paste into the running turn, but grok QUEUES it as its own turn (`[ui].follow_up_behavior = "queue"`), leaving the bus prompt waiting behind the owner's turn with its MCP emission already open unless grok waits for idle. */
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
    // Muse 1.4.0: `esc to interrupt` on the working line; a paste over a running turn is queued as a steer ("Queued input") and runs later like grok, and `/clear` starts a fresh session (a NEW id) that the native witness then follows.
    case "muse":
      return {
        interruptKey: "Escape",
        interruptOnlyWhileGenerating: true,
        pasteOnlyWhenIdle: true,
        clearCommand: "/clear",
      };
  }
}
