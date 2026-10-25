import { inputBoxState, turnInFlight } from "../pane.js"; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import type { PaneIdentity } from "../tmux.js";
import { PasteSessionRunnerBase } from "./base.js";

/**
 * What the PANE says about the generation, not the transcript file; every answer fails closed. Full rationale: ./liveness.md
 */
export abstract class PasteSessionLivenessRunner<E> extends PasteSessionRunnerBase<E> {
  /**
   * A generating pane keeps a merged turn alive however quiet the transcript file is; unreadable is false.
   */
  protected async paneStillGenerating(
    identity: PaneIdentity,
    signal: AbortSignal,
  ): Promise<boolean> {
    return turnInFlight(await this.capturedPane(identity, signal));
  }

  /** No turn in flight AND a free, empty prompt. Both, or the generation is not idle. */
  protected async paneIsIdle(identity: PaneIdentity, signal?: AbortSignal): Promise<boolean> {
    const pane = await this.capturedPane(identity, signal);
    if (pane === undefined) return false;
    // A modal, a blank pane or an unsent paste count as occupied: pasting would concatenate.
    return !turnInFlight(pane) && !inputBoxState(pane).occupied;
  }
}
