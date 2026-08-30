import type { CommandRunRequest, CommandRunResult } from "../../sdk/types.js"; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import { signalAborted } from "../../runtime-state.js";
import { inspectExactPane, interruptPane, samePaneProcess, type PaneIdentity } from "../tmux.js";
import type { CommittedRunResult, PendingQuarantine } from "./contracts.js";
import { PasteSessionRunnerBase } from "./base.js";
import {
  beforeAbort,
  beforeDeadline,
  DEFAULT_CANCEL_DRAIN_TIMEOUT_MS,
  DEFAULT_CORRELATION_TIMEOUT_MS,
  DEFAULT_INJECT_TIMEOUT_MS,
  DEFAULT_MERGED_GRACE_MS,
  DEFAULT_POLL_MS,
  DEFAULT_QUIET_MS,
  fileSize,
  LIVENESS_EVERY,
  postEnterCancelled,
  result,
  turnBudgetMs,
} from "./runtime.js";

export abstract class PasteSessionHarvestRunner<E> extends PasteSessionRunnerBase<E> {
  /**
   * Extracts the envelope from the harness's structured transcript.
   */
  protected async harvest(
    request: CommandRunRequest,
    baseline: ReadonlyMap<string, number>,
    identity: PaneIdentity,
    generating: boolean,
    promptText: string,
    correlationId: string,
    pending: PendingQuarantine,
  ): Promise<CommittedRunResult> {
    const port = this.options.transcript;
    let activeIdentity = identity;
    const budget = turnBudgetMs(request.timeoutMs, this.options.turnTimeoutMs);
    const deadline = Date.now() + budget;
    const injectTimeoutMs = this.options.injectTimeoutMs ?? DEFAULT_INJECT_TIMEOUT_MS;
    const injectDeadline = Date.now() + injectTimeoutMs;
    const correlationDeadline = Date.now()
      + (this.options.correlationTimeoutMs ?? DEFAULT_CORRELATION_TIMEOUT_MS);
    const quietMs = this.options.quietTimeoutMs ?? DEFAULT_QUIET_MS;
    const mergedCeiling = correlationDeadline
      + (this.options.mergedGraceMs ?? DEFAULT_MERGED_GRACE_MS);
    let injected: { file: string; key: string; sessionId?: string } | undefined;
    let started = false;
    // Last time the transcript grew; distinguishes "paste was lost" (nothing writes)
    // from "paste merged with an in-flight turn" (terminal writes the whole time). See DEFAULT_QUIET_MS.
    let lastActivityAt = Date.now();
    // Long-conversation transcripts weigh megabytes and a turn may run for an hour;
    // re-reading the whole file every poll would cost more than the turn itself, so we only read on growth.
    let lastSize = -1;
    let probe = 0;
    // Timestamp is fixed by the EVENT, not by the next poll — a slow transcript read
    // cannot start counting the deadline only when it finishes.
    let cancelObservedAt = request.signal.aborted ? Date.now() : undefined;
    const observeCancellation = (): void => {
      cancelObservedAt ??= Date.now();
    };
    request.signal.addEventListener("abort", observeCancellation, { once: true });

    try {
      for (;;) {
        if (cancelObservedAt !== undefined) {
          return await this.drainCancelledTurn(
            activeIdentity,
            cancelObservedAt,
            baseline,
            injected,
            promptText,
            correlationId,
            pending,
          );
        }
        if (probe % LIVENESS_EVERY === 0) {
          const observed = await inspectExactPane(
            this.options.tmux,
            activeIdentity.paneId,
            this.tmuxControl(request.signal),
          );
          if (signalAborted(request.signal)) continue;
          if (observed.state === "unreadable") {
            return {
              result: await this.ambiguousCommittedState(
                activeIdentity,
                "tmux dejó de acreditar la generación mientras el turno estaba en marcha",
                false,
                pending,
              ),
              terminalBoundary: false,
            };
          }
          if (observed.state === "absent"
            || !samePaneProcess(observed.identity, activeIdentity)) {
            return {
              result: result({
                exitCode: 1,
                stderr: "la generación exacta desapareció o cambió mientras el turno estaba en"
                  + " marcha; el estado de finalización es desconocido",
              }),
              terminalBoundary: true,
            };
          }
          // A rename does not replace the conversation nor the process; the next preflight will
          // re-demand the canonical names before injecting a new turn.
          activeIdentity = observed.identity;
        }
        probe += 1;

        if (injected === undefined) {
          const scanned = await beforeAbort(
            () => this.locateInjectedTurn(baseline, promptText, correlationId),
            request.signal,
          );
          if (scanned.aborted) continue;
          const scan = scanned.value;
          started = started || scan.started;
          if (scan.activity) lastActivityAt = Date.now();
          injected = scan.injected;
          if (injected !== undefined) {
            const noted = await beforeAbort(
              () => this.noteTranscriptIdentity(injected?.sessionId),
              request.signal,
            );
            if (noted.aborted) continue;
          }
          // If the paste merged with an in-flight turn, recover the envelope written after the paste.
          const envelope = scan.envelope;
          if (injected === undefined && envelope !== undefined) {
            const harvested = await beforeAbort(
              () => this.harvested(envelope, undefined, generating),
              request.signal,
            );
            if (harvested.aborted) continue;
            return { result: harvested.value, terminalBoundary: true };
          }
        }
        let injectedGrew = false;
        const injectedTurn = injected;
        if (injectedTurn !== undefined) {
          const grew = await beforeAbort(
            () => this.grew(injectedTurn.file, lastSize),
            request.signal,
          );
          if (grew.aborted) continue;
          injectedGrew = grew.value;
        }
        if (injectedTurn !== undefined && injectedGrew) {
          const measured = await beforeAbort(() => fileSize(injectedTurn.file), request.signal);
          if (measured.aborted) continue;
          lastSize = measured.value;
          lastActivityAt = Date.now();
          const read = await beforeAbort(
            () => port.read(injectedTurn.file, baseline.get(injectedTurn.file) ?? 0),
            request.signal,
          );
          if (read.aborted) continue;
          const slice = read.value;
          const noted = await beforeAbort(
            () => this.noteCompactions(slice.appended),
            request.signal,
          );
          if (noted.aborted) continue;
          const outcome = port.findAnswer(slice.entries, injectedTurn.key);
          if (request.signal.aborted) continue;
          if (outcome?.kind === "failed") {
            // The turn DID enter the terminal and ended badly. Do not retry on the default path:
            // it may have run tools before failing.
            return {
              result: result({ exitCode: 1, stderr: outcome.detail }),
              terminalBoundary: true,
            };
          }
          if (outcome !== undefined) {
            return {
              result: result({
                exitCode: 0,
                stdout: port.stdout(outcome.text, outcome.sessionId ?? injectedTurn.sessionId),
              }),
              terminalBoundary: true,
            };
          }
          // Localized turn but no ancestry arriving: the other way of holding the lock until the
          // full budget waiting for an envelope already written. Scoped to our entry, so
          // a pre-paste envelope cannot sneak in.
          const rescue = port.findEnvelope?.(slice.entries, correlationId, injectedTurn.key);
          if (signalAborted(request.signal)) continue;
          if (rescue !== undefined) {
            const harvested = await beforeAbort(
              () => this.harvested(rescue, injectedTurn.sessionId, generating),
              request.signal,
            );
            if (harvested.aborted) continue;
            return { result: harvested.value, terminalBoundary: true };
          }
        }

        if (injected === undefined && !started && port.startedTurn !== undefined
          && Date.now() >= injectDeadline) {
          return {
            result: await this.quarantineTimedOut(
              activeIdentity,
              `la TUI no registró un turno correlacionado en ${String(Math.round(injectTimeoutMs / 1000))}`
                + " s después de aceptar paste+Enter",
              pending,
            ),
            terminalBoundary: false,
          };
        }

        // Safety net for harnesses that cannot declare `startedTurn` (claude): the paste never
        // appeared in the transcript. No degrade — that would execute twice — the delivery
        // ends AMBIGUOUS and the generation is quarantined so the queue only progresses via
        // the isolated transport or on a new generation.
        // Also requires SILENCE: while the transcript keeps growing, what is ahead is an
        // in-flight turn that swallowed it; killing it is throwing work away.
        if (injected === undefined && !started && Date.now() >= correlationDeadline
          && (Date.now() - lastActivityAt >= quietMs || Date.now() >= mergedCeiling)) {
          // Last sweep before giving up on it: if the envelope arrived, the delivery does not die.
          const rescued = await beforeAbort(
            () => this.lastEnvelope(baseline, injected, correlationId),
            request.signal,
          );
          if (rescued.aborted) continue;
          const rescuedEnvelope = rescued.value;
          if (rescuedEnvelope !== undefined) {
            const harvested = await beforeAbort(
              () => this.harvested(rescuedEnvelope, undefined, generating),
              request.signal,
            );
            if (harvested.aborted) continue;
            return { result: harvested.value, terminalBoundary: true };
          }
          return {
            result: await this.quarantineTimedOut(
              activeIdentity,
              "accepted paste+Enter never reached a correlated boundary in the transcript",
              pending,
            ),
            terminalBoundary: false,
          };
        }

        if (Date.now() >= deadline) {
          // Final sweep before declaring it dead: if the envelope arrived, the delivery does not die.
          const rescued = await beforeAbort(
            () => this.lastEnvelope(baseline, injected, correlationId),
            request.signal,
          );
          if (rescued.aborted) continue;
          const rescuedEnvelope = rescued.value;
          if (rescuedEnvelope !== undefined) {
            const harvested = await beforeAbort(
              () => this.harvested(rescuedEnvelope, injected?.sessionId, generating),
              request.signal,
            );
            if (harvested.aborted) continue;
            return { result: harvested.value, terminalBoundary: true };
          }
          // Already injected: the turn may have run tools and caused external effects.
          // `timedOut` makes the adapter treat it as AMBIGUOUS and not retry alone.
          return {
            result: await this.quarantineTimedOut(
              activeIdentity,
              "budget ended with no correlated outcome for the already-injected turn",
              pending,
            ),
            terminalBoundary: false,
          };
        }
        const slept = await beforeAbort(
          () => this.options.sleep(this.options.pollMs ?? DEFAULT_POLL_MS),
          request.signal,
        );
        if (slept.aborted) continue;
      }
    } finally {
      request.signal.removeEventListener("abort", observeCancellation);
    }
  }

  /**
   * Cancels an already-committed turn without releasing the queue over a TUI still occupied.
   *
   * Every wait uses the deadline set by the abort event. A logical rename is followed by
   * session/pane/PID; a respawn is not. If no terminal boundary appears, the generation is marked
   * in tmux+disk or killed exactly, so it never ends up blindly reusable.
   */
  protected async drainCancelledTurn(
    identity: PaneIdentity,
    observedAt: number,
    baseline: ReadonlyMap<string, number>,
    injected: { file: string; key: string; sessionId?: string } | undefined,
    promptText: string,
    correlationId: string,
    pending: PendingQuarantine,
  ): Promise<CommittedRunResult> {
    const drainMs = Math.max(1, this.options.cancelDrainTimeoutMs
      ?? DEFAULT_CANCEL_DRAIN_TIMEOUT_MS);
    const deadline = observedAt + drainMs;
    let activeIdentity = identity;
    let correlatedTurn = injected;
    let interruptDelivered = false;

    for (;;) {
      if (Date.now() >= deadline) return this.quarantineCancelled(activeIdentity, pending);
      const inspected = await inspectExactPane(
        this.options.tmux,
        activeIdentity.paneId,
        this.tmuxControlUntil(deadline),
      );
      if (inspected.state === "unreadable") {
        return this.quarantineCancelled(activeIdentity, pending);
      }
      if (inspected.state === "absent"
        || !samePaneProcess(inspected.identity, activeIdentity)) {
        return {
          result: postEnterCancelled(
            "la generación exacta del pane terminó o fue reemplazada tras la cancelación",
          ),
          terminalBoundary: true,
        };
      }
      activeIdentity = inspected.identity;

      if (!interruptDelivered) {
        const interrupted = await interruptPane(
          this.options.tmux,
          activeIdentity,
          this.tmuxControlUntil(deadline),
        );
        if (interrupted === "ambiguous") {
          return this.quarantineCancelled(activeIdentity, pending);
        }
        interruptDelivered = interrupted === "applied";
      }

      const terminal = await beforeDeadline(
        this.cancelledTranscriptBoundary(
          baseline,
          correlatedTurn,
          promptText,
          correlationId,
        ),
        deadline,
      );
      if (!terminal.completed || terminal.value === undefined) {
        return this.quarantineCancelled(activeIdentity, pending);
      }
      correlatedTurn = terminal.value.injected;
      if (terminal.value.state === "terminal") {
        return {
          result: postEnterCancelled(
            "el transcript confirmó el límite terminal del turno correlacionado tras la cancelación",
          ),
          terminalBoundary: true,
        };
      }

      const revalidated = await inspectExactPane(
        this.options.tmux,
        activeIdentity.paneId,
        this.tmuxControlUntil(deadline),
      );
      if (revalidated.state === "unreadable") {
        return this.quarantineCancelled(activeIdentity, pending);
      }
      if (revalidated.state === "absent"
        || !samePaneProcess(revalidated.identity, activeIdentity)) {
        return {
          result: postEnterCancelled(
            "la generación exacta del pane terminó o fue reemplazada tras la cancelación",
          ),
          terminalBoundary: true,
        };
      }
      activeIdentity = revalidated.identity;
      if (Date.now() >= deadline) return this.quarantineCancelled(activeIdentity, pending);
      const slept = await beforeDeadline(
        this.options.sleep(this.options.pollMs ?? DEFAULT_POLL_MS),
        deadline,
      );
      if (!slept.completed) return this.quarantineCancelled(activeIdentity, pending);
    }
  }

  /** Only an outcome tied to this delivery's prompt/nonce makes the generation reusable. */
  protected async cancelledTranscriptBoundary(
    baseline: ReadonlyMap<string, number>,
    injected: { file: string; key: string; sessionId?: string } | undefined,
    promptText: string,
    correlationId: string,
  ): Promise<{
    readonly state: "terminal" | "pending" | "unreadable";
    readonly injected?: { file: string; key: string; sessionId?: string };
  }> {
    try {
      let correlated = injected;
      if (correlated === undefined) {
        const located = await this.locateInjectedTurn(baseline, promptText, correlationId);
        if (located.envelope !== undefined) return { state: "terminal" };
        correlated = located.injected;
      }
      if (correlated === undefined) return { state: "pending" };
      const slice = await this.options.transcript.read(
        correlated.file,
        baseline.get(correlated.file) ?? 0,
      );
      const outcome = this.options.transcript.findAnswer(slice.entries, correlated.key)
        ?? this.options.transcript.findEnvelope?.(
          slice.entries,
          correlationId,
          correlated.key,
        );
      return outcome === undefined
        ? { state: "pending", injected: correlated }
        : { state: "terminal", injected: correlated };
    } catch {
      return injected === undefined
        ? { state: "unreadable" }
        : { state: "unreadable", injected };
    }
  }

  protected async quarantineCancelled(
    identity: PaneIdentity,
    pending: PendingQuarantine,
  ): Promise<CommittedRunResult> {
    const quarantineDetail = await this.quarantine(identity, pending);
    return {
      result: postEnterCancelled(
        "la TUI no alcanzó un límite terminal dentro del plazo de cancelación; "
          + quarantineDetail,
      ),
      terminalBoundary: false,
    };
  }

  protected async quarantineTimedOut(
    identity: PaneIdentity,
    detail: string,
    pending: PendingQuarantine,
  ): Promise<CommandRunResult> {
    const quarantineDetail = await this.quarantine(identity, pending);
    return result({
      timedOut: true,
      stderr: `${detail}; ${quarantineDetail}`,
    });
  }

  protected async grew(file: string, lastSize: number): Promise<boolean> {
    return await fileSize(file) > lastSize;
  }

}
