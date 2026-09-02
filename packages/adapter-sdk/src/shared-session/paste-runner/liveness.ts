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
 * What the PANE says about the generation, as opposed to what the transcript file says.
 *
 * Both answers this layer gives come from one capture read with the same detectors the arbiter
 * uses before pasting, and both fail closed: a capture that could not be taken is never evidence
 * of life and never evidence of health.
 */
export abstract class PasteSessionLivenessRunner<E> extends PasteSessionRunnerBase<E> {
  /**
   * The pane is still generating, so a merged turn is alive however quiet the transcript is.
   *
   * `lastActivityAt` only sees the transcript FILE grow, and one uninterrupted extended-thinking
   * or tool block writes nothing for longer than the silence window. Silence on disk is not
   * death. An unreadable capture returns false, so a dead pane still falls through to the release
   * path: the genuinely lost paste must keep coming out as ambiguous.
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
    // A modal, a blank pane or an unsent `[Pasted text …]` all count as occupied: any of them
    // could be OUR lost paste still sitting in the box, and pasting would concatenate onto it.
    return !turnInFlight(pane) && !inputBoxState(pane).occupied;
  }

  /**
   * Lifts the quarantine of a generation that is STILL alive and proves it is healthy.
   *
   * Until now a quarantine only lifted when the pane generation CHANGED (`stale`), i.e. when a
   * person respawned the TUI. Inside one live generation it was permanent, so every delivery after
   * it came out as `session_identity_unverified` and the shared conversation stopped receiving
   * anything. That is what stranded heraclito for hours.
   *
   * The evidence demanded is direct and current: the SAME generation is still there, it is not
   * painting its "generating" band, and its input box is a free, empty prompt. Together they say
   * no turn is in flight, which is the only thing the quarantine was protecting against.
   *
   * It CANNOT execute a delivery twice. The one that armed this quarantine already ended AMBIGUOUS
   * and is never resent from here; the invariant "No degrade — that would execute twice" governs
   * that delivery's own turn in `harvest` and is untouched. What is released is the pane, for the
   * NEXT delivery.
   *
   * Fail-closed at every step: an unreadable capture, a marker of another generation, a marker
   * that cannot be read or times out, a pending this process did not arm, or a tmux clear that
   * does not credit its postcondition — each of them preserves the quarantine.
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
   * Removes the on-disk marks of this generation, or none at all.
   *
   * A pending of THIS generation that this process did not arm belongs to a commit whose terminal
   * boundary nobody observed —typically an adapter that died mid-turn— and only the envelope proof
   * of `reconcileTerminalPending` discharges it. It is checked BEFORE the canonical marker is
   * touched: clearing half of the barrier would leave the generation with no barrier at all.
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
    // Aggregates canonical + sidecars + half-written `.tmp`: anything still crediting this
    // generation keeps the quarantine, whatever the individual reads above said.
    const remaining = await beforeDeadline(
      this.quarantinePersistence().inspect(quarantineFile, identity),
      this.quarantineDeadline(),
    );
    if (!remaining.completed) return false;
    return remaining.value === "absent" || remaining.value === "stale";
  }
}
