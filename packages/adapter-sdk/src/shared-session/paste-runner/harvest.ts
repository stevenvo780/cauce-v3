import type { CommandRunRequest, CommandRunResult } from "../../sdk/types.js"; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import { signalAborted } from "../../runtime-state.js";
import {
  capturePane,
  inspectExactPane,
  interruptPane,
  samePaneProcess,
  type PaneIdentity,
} from "../tmux.js";
import { turnInFlight } from "../pane.js";
import { tuiProfile } from "../tui-profile.js";
import type { TurnOutcome } from "../types.js";
import type { CommittedRunResult, PendingQuarantine } from "./contracts.js";
import { PasteSessionLivenessRunner } from "./liveness.js";
import {
  beforeAbort,
  beforeDeadline,
  DEFAULT_BACKGROUND_WAIT_MS,
  DEFAULT_CANCEL_DRAIN_TIMEOUT_MS,
  DEFAULT_CORRELATION_TIMEOUT_MS,
  DEFAULT_INJECT_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  DEFAULT_QUIET_MS,
  fileSize,
  LIVENESS_EVERY,
  postEnterCancelled,
  result,
  turnBudgetMs,
} from "./runtime.js";

export type WakeCommit =
  | { readonly state: "entered" | "not_pasted" }
  | { readonly state: "ambiguous" | "barrier_ambiguous"; readonly detail: string; readonly forceTerminate: boolean };

export abstract class PasteSessionHarvestRunner<E> extends PasteSessionLivenessRunner<E> {
  /** Wakes pasted for the delivery being harvested; codex only logs one once its turn starts. */
  protected wakesSentThisDelivery = 0;
  /** Pastes `text` as a new turn of the SAME conversation (codex: wake a root that closed silent after delegating). */
  protected abstract wakeTurn(identity: PaneIdentity, text: string, signal: AbortSignal): Promise<WakeCommit>;

  /** Extracts the envelope from the harness's structured transcript. */
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
    const noProgress = request.timeoutKind === "no-progress";
    const injectTimeoutMs = this.options.injectTimeoutMs ?? DEFAULT_INJECT_TIMEOUT_MS;
    const injectDeadline = Date.now() + injectTimeoutMs;
    const correlationDeadline = Date.now()
      + (this.options.correlationTimeoutMs ?? DEFAULT_CORRELATION_TIMEOUT_MS);
    const quietMs = this.options.quietTimeoutMs ?? DEFAULT_QUIET_MS;
    let injected: { file: string; key: string; sessionId?: string } | undefined;
    let started = false;
    // Last time the transcript grew; distinguishes "paste was lost" (nothing writes) from "paste merged with an in-flight turn" (terminal writes the whole time). See DEFAULT_QUIET_MS.
    let lastActivityAt = Date.now();
    let lastTranscriptGrowthAt = lastActivityAt; // the pane's spinner is not progress: a frozen TUI keeps painting it
    // Sizes seen on the previous poll: `scan.activity` compares against the PRE-paste baseline, so activity has to be growth since the last poll, or it would stay true forever once anything wrote.
    const seenSizes = new Map(baseline);
    // Long-conversation transcripts weigh megabytes and a turn may run for an hour, so we only re-read the whole file on growth — re-reading every poll would cost more than the turn itself.
    let lastSize = -1;
    let probe = 0;
    // Timestamp is fixed by the EVENT, not by the next poll, so a slow transcript read cannot start counting the deadline only when it finishes.
    let lingering: { readonly outcome: TurnOutcome; readonly progress: string } | undefined; // No silence cut then.
    let pendingWake: string | undefined;
    let wakeOutcome: TurnOutcome | undefined; // What the chain says if it cannot be woken.
    let wakesSent = 0;
    this.wakesSentThisDelivery = 0;
    let wakeBlockedNoted = false;
    let lingeringSince = 0;
    const backgroundWaitMs = Math.max(0, this.options.backgroundWaitMs ?? DEFAULT_BACKGROUND_WAIT_MS);
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
          // A rename does not replace the conversation nor the process; the next preflight will re-demand the canonical names before injecting a new turn.
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
          if (scan.activity) {
            const moved = await beforeAbort(() => this.transcriptMoved(seenSizes), request.signal);
            if (moved.aborted) continue;
            if (moved.value) lastActivityAt = lastTranscriptGrowthAt = Date.now();
          }
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
          lastActivityAt = lastTranscriptGrowthAt = Date.now();
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
          if (outcome !== undefined) {
            return { result: this.settledResult(outcome, injectedTurn.sessionId, request), terminalBoundary: true };
          }
          const pendingWork = port.lingering?.(slice.entries, injectedTurn.key);
          if (pendingWork !== undefined && lingering?.progress !== pendingWork.progress) {
            lingeringSince = Date.now();
          }
          lingering = pendingWork;
          const wake = lingering === undefined ? port.wakePrompt?.(slice.entries, injectedTurn.key) : undefined;
          pendingWake = wake !== undefined && wake.wakes === wakesSent ? wake.text : undefined;
          wakeOutcome = wake?.outcome;
          if (request.emissionOutput?.() !== undefined) pendingWake = wakeOutcome = undefined; // A `cauce_reply` deposit IS the answer.
          // Localized turn but no ancestry arriving: the other way of holding the lock until the full
          // budget waiting for an envelope already written, scoped to our entry so a pre-paste envelope cannot sneak in, and not while background work may still answer.
          const rescue = lingering === undefined && wakeOutcome === undefined // Not an early placeholder while waking.
            ? port.findEnvelope?.(slice.entries, correlationId, injectedTurn.key)
            : undefined;
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

        const stillLingering = lingering;
        if (stillLingering !== undefined && Date.now() - lingeringSince >= backgroundWaitMs) {
          await this.note({
            reason: "background_pending",
            detail: `el turno cerró y su trabajo en segundo plano siguió ${String(Math.round(backgroundWaitMs / 60_000))}`
              + " min sin avanzar; se entrega lo que había y lo que produzca después queda en la terminal",
            occurredAt: new Date().toISOString(),
            fellBack: false,
          });
          return {
            result: this.settledResult(stillLingering.outcome, injected?.sessionId, request),
            terminalBoundary: true,
          };
        }

        const wakeText = pendingWake;
        if (wakeText !== undefined && injected !== undefined && !request.signal.aborted) {
          const moved = await this.otherConversationMoved(baseline, injected.file);
          if (moved && wakeOutcome !== undefined) { // The owner went to another conversation: never paste into it.
            return {
              result: result({ exitCode: 1, stderr: `${wakeOutcome.kind === "failed" ? wakeOutcome.detail : "sin respuesta final"};`
                + " no se despertó al agente porque la terminal pasó a otra conversación" }),
              terminalBoundary: true,
            };
          }
          const idle = await beforeAbort(() => this.paneIsIdle(activeIdentity, request.signal), request.signal);
          if (idle.aborted) continue;
          if (!idle.value && !wakeBlockedNoted) {
            wakeBlockedNoted = true;
            try {
              this.options.onNotice?.("el agente cerró sin respuesta tras delegar y hay que despertarlo, pero la caja de la terminal no está libre");
            } catch { /* A notice cannot change the delivery. */ }
          }
          if (idle.value) {
            // Not under beforeAbort: a paste+Enter must finish or never start, never run beside the drain.
            const woke = await this.wakeTurn(activeIdentity, wakeText, request.signal);
            if (woke.state === "entered") {
              wakesSent += 1;
              this.wakesSentThisDelivery = wakesSent;
              pendingWake = undefined;
              lastActivityAt = lastTranscriptGrowthAt = Date.now();
            } else if (woke.state === "barrier_ambiguous") {
              return {
                result: this.ambiguousBarrierAcquisitionState(activeIdentity, woke.detail, request.signal.aborted, pending),
                terminalBoundary: false,
              };
            } else if (woke.state === "ambiguous") {
              return {
                result: await this.ambiguousCommittedState(activeIdentity, woke.detail, request.signal.aborted, pending,
                  woke.forceTerminate),
                terminalBoundary: false,
              };
            }
          }
        }

        const deposited = request.emissionOutput?.();
        if (deposited !== undefined && lingering === undefined && pendingWake === undefined
          && Date.now() - lastActivityAt >= quietMs) {
          const idle = await beforeAbort(() => this.paneIsIdle(activeIdentity, request.signal), request.signal);
          if (idle.aborted) continue;
          if (idle.value) return {
            result: result({ exitCode: 0, stdout: port.stdout(JSON.stringify(deposited), injected?.sessionId) }),
            terminalBoundary: true,
          };
        }

        const localized = injected;
        if (localized !== undefined && lingering === undefined && pendingWake === undefined
          && Date.now() - lastActivityAt >= quietMs) {
          const idle = await beforeAbort(
            () => this.paneIsIdle(activeIdentity, request.signal),
            request.signal,
          );
          if (idle.aborted) continue;
          if (idle.value) {
            const rescued = await beforeAbort(
              () => this.lastEnvelope(baseline, localized, correlationId),
              request.signal,
            );
            if (rescued.aborted) continue;
            const rescuedEnvelope = rescued.value;
            if (rescuedEnvelope !== undefined) {
              const harvested = await beforeAbort(
                () => this.harvested(rescuedEnvelope, localized.sessionId, generating),
                request.signal,
              );
              if (harvested.aborted) continue;
              return { result: harvested.value, terminalBoundary: true };
            }
            await this.disarmPendingQuarantine(pending);
            return {
              result: result({
                timedOut: true,
                stderr: "el turno correlacionado terminó sin sobre y el panel volvió al prompt libre;"
                  + " el estado de ejecución es ambiguo y el panel queda utilizable",
              }),
              terminalBoundary: false,
            };
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

        // Safety net for harnesses that cannot declare `startedTurn` (claude): the paste never appeared
        // in the transcript. No degrade (that would execute twice) — the delivery ends AMBIGUOUS and
        // the generation is quarantined so the queue only progresses via the isolated transport or a
        // new generation. Also requires SILENCE from the PANE, not just the file (growing transcript or pane still generating is an in-flight turn; see `paneStillGenerating`, bounded by `deadline`).
        if (injected === undefined && !started && Date.now() >= correlationDeadline
          && Date.now() - lastActivityAt >= quietMs) {
          const alive = await beforeAbort(
            () => this.paneStillGenerating(activeIdentity, request.signal),
            request.signal,
          );
          if (alive.aborted) continue;
          if (alive.value) {
            lastActivityAt = Date.now();
          } else {
            // Last sweep before giving up: if the envelope arrived, the delivery does not die.
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
        }

        if (Date.now() >= (noProgress ? lastTranscriptGrowthAt + budget : deadline)) {
          // A codex chain waiting to wake a closed root: say what happened, do not quarantine.
          if (wakeOutcome !== undefined) {
            return { result: this.settledResult(wakeOutcome, injected?.sessionId, request), terminalBoundary: true };
          }
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
          // Already injected: the turn may have run tools and caused external effects; `timedOut` makes the adapter treat it as AMBIGUOUS and not retry alone.
          return {
            result: await this.quarantineTimedOut(
              activeIdentity,
              noProgress
                ? `the transcript did not advance for ${String(Math.round(budget / 60_000))} min; the turn is declared hung`
                : "budget ended with no correlated outcome for the already-injected turn",
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

  /** A `cauce_reply` deposit is the answer even if the turn then ended badly (e.g. the owner cancelled it). */
  protected settledResult(
    outcome: TurnOutcome,
    sessionId: string | undefined,
    request: CommandRunRequest,
  ): CommandRunResult {
    const port = this.options.transcript;
    if (outcome.kind === "failed") {
      const deposited = request.emissionOutput?.();
      return deposited === undefined
        ? result({ exitCode: 1, stderr: outcome.detail })
        : result({ exitCode: 0, stdout: port.stdout(JSON.stringify(deposited), sessionId) });
    }
    return result({ exitCode: 0, stdout: port.stdout(outcome.text, outcome.sessionId ?? sessionId) });
  }

  /**
   * Cancels an already-committed turn without releasing the queue over a TUI still occupied. Every
   * wait uses the deadline set by the abort event; a logical rename is followed by session/pane/PID
   * (a respawn is not), and if no terminal boundary appears the generation is marked in tmux+disk or killed exactly, so it never ends up blindly reusable.
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
        const profile = tuiProfile(this.options.harness);
        let mayInterrupt = true;
        if (profile.interruptOnlyWhileGenerating) {
          const located = await beforeDeadline( // The turn on screen may be the owner's: find OURS first.
            this.cancelledTranscriptBoundary(baseline, correlatedTurn, promptText, correlationId),
            deadline,
          );
          if (!located.completed || located.value === undefined) {
            return this.quarantineCancelled(activeIdentity, pending);
          }
          correlatedTurn = located.value.injected;
          if (located.value.state === "terminal") {
            return {
              result: postEnterCancelled(
                "el transcript confirmó el límite terminal del turno correlacionado tras la cancelación",
              ),
              terminalBoundary: true,
            };
          }
          mayInterrupt = located.value.state === "pending" && correlatedTurn !== undefined
            && turnInFlight(await capturePane(this.options.tmux, activeIdentity.paneId, {
              styled: true,
              control: this.tmuxControlUntil(deadline),
            }));
        }
        if (mayInterrupt) {
          const interrupted = await interruptPane(
            this.options.tmux,
            activeIdentity,
            this.tmuxControlUntil(deadline),
            profile.interruptKey,
          );
          if (interrupted === "ambiguous") {
            return this.quarantineCancelled(activeIdentity, pending);
          }
          interruptDelivered = interrupted === "applied";
        }
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

  /** The chain's outcome while waiting to wake the root, unless a wake we pasted has not shown up yet. */
  private wokenOutcome(entries: readonly E[], key: string): TurnOutcome | undefined {
    const wake = this.options.transcript.wakePrompt?.(entries, key);
    return wake !== undefined && wake.wakes >= this.wakesSentThisDelivery ? wake.outcome : undefined;
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
      const outcome = this.options.transcript.findAnswer(slice.entries, correlated.key) // Lingering work: still terminal.
        ?? this.options.transcript.lingering?.(slice.entries, correlated.key)?.outcome
        ?? this.wokenOutcome(slice.entries, correlated.key) // Root idle, waiting to be woken.
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

  /**
   * Whether any transcript changed size since the previous call, updating `seen` in place. A paste
   * merged into an in-flight turn is never recorded as its own user entry (claude stores it as a
   * `queued_command` attachment), so `injected` stays undefined and this is the only activity signal;
   * measured against the baseline instead, it never went quiet, holding the delivery to the 6 h lease cap.
   */
  /** Whether a TUI conversation other than the delivery's grew or appeared since the paste. */
  protected async otherConversationMoved(baseline: ReadonlyMap<string, number>, own: string): Promise<boolean> {
    const port = this.options.transcript;
    if (port.otherConversationActive === undefined) return false;
    const changed: string[] = [];
    for (const file of await port.files()) {
      if (file === own) continue;
      const size = await fileSize(file);
      if (size >= 0 && size !== baseline.get(file)) changed.push(file);
    }
    return changed.length > 0 && await port.otherConversationActive(changed, own);
  }

  protected async transcriptMoved(seen: Map<string, number>): Promise<boolean> {
    let moved = false;
    for (const file of await this.options.transcript.files()) {
      const size = await fileSize(file);
      if (size < 0) continue;
      if (seen.get(file) !== size) moved = true;
      seen.set(file, size);
    }
    return moved;
  }

}
