import { inputBoxState, turnInFlight } from "../pane.js"; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import {
  clearCurrentPaneQuarantine,
  paneGenerationKey,
  paneIdentityStillCurrent,
  samePaneIdentity,
  type PaneIdentity,
} from "../tmux.js";
import { PasteSessionRunnerBase } from "./base.js";
import { readQuarantineMarker } from "./persistence.js";
import { beforeDeadline } from "./runtime.js";

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

  /**
   * Lifts the quarantine of a generation that is STILL alive once it proves idle: the same
   * generation, no "generating" band, a free empty prompt. It never resends the delivery that
   * armed the quarantine (it already ended ambiguous); it only releases the pane for the next one.
   * Any unreadable capture, foreign marker, unarmed pending or uncredited tmux clear keeps it.
   */
  protected async healCurrentQuarantine(
    identity: PaneIdentity,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!await this.paneIsIdle(identity, signal)) return;
    if (signal?.aborted === true) return;
    if (!await paneIdentityStillCurrent(this.options.tmux, identity, this.tmuxControl(signal))) {
      return;
    }
    const generation = paneGenerationKey(identity);
    const mine = new Set<string>();
    for (const [correlationId, held] of [...this.heldQuarantines]) {
      if (!samePaneIdentity(held.identity, identity)) continue;
      mine.add(correlationId);
      if (held.file === undefined) {
        this.heldQuarantines.delete(correlationId);
        continue;
      }
      const marker = await beforeDeadline(
        readQuarantineMarker(held.file),
        this.quarantineDeadline(),
      );
      if (!marker.completed || marker.value === undefined) return;
      if (marker.value.state === "unreadable") return;
      if (marker.value.state === "present" && marker.value.value !== generation) continue;
      const cleared = await beforeDeadline(
        this.quarantinePersistence().clear(held.file),
        this.quarantineDeadline(),
      );
      if (!cleared.completed || cleared.value !== true) return;
      this.heldQuarantines.delete(correlationId);
    }
    if (!await this.releaseDurableQuarantine(identity, generation, mine)) return;
    if (!await clearCurrentPaneQuarantine(this.options.tmux, identity, this.tmuxControl(signal))) {
      return;
    }
    this.forgetLocalQuarantine(identity);
    this.options.onNotice?.(
      "la cuarentena de la generación viva se levantó sola: el panel no está generando y su caja"
        + " de entrada está libre, así que el turno que la armó terminó",
    );
  }

  /**
   * Removes the on-disk marks of this generation, or none at all: a pending this process did not
   * arm is only discharged by `reconcileTerminalPending`, and it is checked before the canonical
   * marker so the barrier is never half-cleared.
   */
  private async releaseDurableQuarantine(
    identity: PaneIdentity,
    generation: string,
    mine: ReadonlySet<string>,
  ): Promise<boolean> {
    const quarantineFile = this.options.quarantineFile;
    if (quarantineFile === undefined) return true;
    const sidecars = await this.pendingQuarantineSidecars(quarantineFile);
    if (sidecars === undefined) return false;
    for (const sidecar of sidecars) {
      if (mine.has(sidecar.correlationId)) continue;
      const marker = await beforeDeadline(
        readQuarantineMarker(sidecar.file),
        this.quarantineDeadline(),
      );
      if (!marker.completed || marker.value === undefined) return false;
      if (marker.value.state === "unreadable") return false;
      if (marker.value.state === "present" && marker.value.value === generation) return false;
    }
    const canonical = await beforeDeadline(
      readQuarantineMarker(quarantineFile),
      this.quarantineDeadline(),
    );
    if (!canonical.completed || canonical.value === undefined) return false;
    if (canonical.value.state === "unreadable") return false;
    if (canonical.value.state === "present" && canonical.value.value === generation) {
      const cleared = await beforeDeadline(
        this.quarantinePersistence().clear(quarantineFile),
        this.quarantineDeadline(),
      );
      if (!cleared.completed || cleared.value !== true) return false;
    }
    // Canonical + sidecars + half-written `.tmp`: anything crediting this generation keeps it.
    const remaining = await beforeDeadline(
      this.quarantinePersistence().inspect(quarantineFile, identity),
      this.quarantineDeadline(),
    );
    if (!remaining.completed) return false;
    return remaining.value === "absent" || remaining.value === "stale";
  }
}
