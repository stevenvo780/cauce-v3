import { randomBytes } from "node:crypto";
import type { CommandRunRequest, CommandRunResult } from "../../sdk/types.js";
import { correlateEnvelopePrompt } from "../envelope.js";
import { turnInFlight } from "../pane.js";
import { ensureSharedSession, type EnsureFailure, type EnsureOptions } from "../session.js";
import { TUI_WINDOW, sessionName } from "../types.js";
import type { SharedSessionRunner } from "../types.js";
import {
  acquirePaneInputBarrier,
  clearDegradation,
  paneIdentityStillCurrent,
  pastePrompt,
  releasePaneInputBarrier,
  sendEnter,
  type PaneIdentity,
  type PaneInputBarrier,
  type PastePromptResult,
} from "../tmux.js";
import type { PasteSessionOptions } from "./contracts.js";
import { PasteSessionHarvestRunner } from "./harvest.js";
import { beforeDeadline, replacedBeforeSubmission, result, SETTLE_MS } from "./runtime.js";

type PromptCommitOutcome =
  | { readonly state: "entered" }
  | { readonly state: "not_pasted"; readonly paste: PastePromptResult }
  | {
    readonly state: "ambiguous";
    readonly detail: string;
    readonly forceTerminate: boolean;
  };

/**
 * Shared-session runner that injects prompts into the interactive TUI via tmux
 * and recovers the results from the structured transcript.
 */
export class PasteSessionRunner<E> extends PasteSessionHarvestRunner<E> implements SharedSessionRunner {
  constructor(options: PasteSessionOptions<E>) {
    super(options);
  }

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.pending = undefined;
    this.exactSessionId = undefined;
    if (request.signal.aborted) return result({ cancelled: true, harnessStarted: false });

    const ready = await this.preflight(request.signal);
    if ("cancelled" in ready || request.signal.aborted) {
      return result({ cancelled: true, harnessStarted: false });
    }
    if (!ready.ok) return this.degrade(ready.reason, ready.detail, request);
    this.exactSessionId = ready.sessionId;
    const identity = ready.identity;
    const target = identity.paneId;

    await this.reconcileTerminalPending(identity);
    const quarantine = await this.quarantineState(identity);
    if (quarantine === "current") {
      return this.degrade(
        "session_identity_unverified",
        "la generación exacta de la TUI conserva un turno cancelado de finalización ambigua;"
          + " no recibirá más input hasta que el pane/proceso cambie",
        request,
      );
    }
    if (quarantine === "unreadable") {
      return this.degrade(
        "session_identity_unverified",
        "tmux no permitió comprobar si la generación exacta conserva una cuarentena;"
          + " se evita reutilizarla a ciegas",
        request,
      );
    }
    await this.clearStaleQuarantine(identity, quarantine);
    const quarantineAfterCleanup = await this.quarantineState(identity);
    if (quarantineAfterCleanup === "current" || quarantineAfterCleanup === "unreadable") {
      return this.degrade(
        "session_identity_unverified",
        "no se pudo acreditar que la generación actual esté libre de una cuarentena concurrente",
        request,
      );
    }
    if (request.signal.aborted) return result({ cancelled: true, harnessStarted: false });

    // Paste and Enter must be a single operation from the owner's perspective: between checking
    // the input box is free and submitting it, no extra waits beyond what is strictly required.
    const acquired = await this.acquireInputBox(
      target,
      identity,
      request.signal,
    );
    if ("cancelled" in acquired || request.signal.aborted) {
      return result({ cancelled: true, harnessStarted: false });
    }
    if ("replaced" in acquired) return replacedBeforeSubmission();
    if (!acquired.ok) return this.degrade(acquired.reason, acquired.detail, request);

    // If the terminal was GENERATING when we pasted, the paste is queued and merges with the
    // in-flight turn: there will be no dedicated turn to descend from. What is done does not change —
    // pasting remains correct, the turn executes in the shared conversation — what changes is what
    // we can CLAIM afterwards and the notice read by the owner. See `turnInFlight`.
    const generating = turnInFlight(acquired.pane);
    const baseline = await this.baseline(request.signal);
    if (baseline === undefined || request.signal.aborted) {
      return result({ cancelled: true, harnessStarted: false });
    }
    if (!await paneIdentityStillCurrent(this.options.tmux, identity, this.tmuxControl(request.signal))) {
      return replacedBeforeSubmission();
    }
    if (request.signal.aborted) return result({ cancelled: true, harnessStarted: false });

    const correlationId = randomBytes(32).toString("hex");
    const promptText = correlateEnvelopePrompt(request.stdin, correlationId);
    const armed = await this.armPendingQuarantine(identity, correlationId);
    if (!armed.ok) {
      if (request.signal.aborted) {
        return result({ cancelled: true, harnessStarted: false });
      }
      return this.degrade(
        "handshake_failed",
        "no se pudo persistir quarantine-pending antes de tocar la caja de entrada",
        request,
      );
    }
    const pending = armed.pending;

    const buffer = `cauce-${this.options.alias}-${correlationId}`;
    if (request.signal.aborted) {
      await this.disarmPendingQuarantine(pending);
      return result({ cancelled: true, harnessStarted: false });
    }
    const acquiredBarrier = await acquirePaneInputBarrier(
      this.options.tmux,
      identity,
      correlationId,
      this.tmuxControl(request.signal),
    );
    if (acquiredBarrier.state === "not_applied") {
      await this.disarmPendingQuarantine(pending);
      return replacedBeforeSubmission();
    }
    if (acquiredBarrier.state === "busy") {
      await this.disarmPendingQuarantine(pending);
      if (request.signal.aborted) return result({ cancelled: true, harnessStarted: false });
      return this.degrade(
        "input_busy",
        "otra exclusión de input ya protege la caja; no se adopta ni se concatena",
        request,
      );
    }
    if (acquiredBarrier.state === "unsafe_hooks") {
      await this.disarmPendingQuarantine(pending);
      if (request.signal.aborted) return result({ cancelled: true, harnessStarted: false });
      return this.degrade(
        "handshake_failed",
        "la configuración tmux tiene hooks de input que abren una carrera; no se tocó la caja",
        request,
      );
    }
    if (acquiredBarrier.state === "ambiguous") {
      return this.ambiguousBarrierAcquisitionState(
        identity,
        "tmux perdió el resultado al adquirir la exclusión real de input",
        request.signal.aborted,
        pending,
      );
    }
    if (acquiredBarrier.state !== "acquired") {
      return this.ambiguousCommittedState(
        identity,
        "tmux devolvió un estado imposible al adquirir la exclusión de input",
        request.signal.aborted,
        pending,
        true,
      );
    }
    const committed = await this.commitUnderInputBarrier(
      acquiredBarrier.barrier,
      buffer,
      promptText,
      request.signal,
    );
    if (committed.state === "ambiguous") {
      return this.ambiguousCommittedState(
        identity,
        committed.detail,
        request.signal.aborted,
        pending,
        committed.forceTerminate,
      );
    }
    if (committed.state === "not_pasted") {
      const { paste } = committed;
      await this.disarmPendingQuarantine(pending);
      if (paste.reason === "identity_changed"
        || !await paneIdentityStillCurrent(this.options.tmux, identity, this.tmuxControl())) {
        return replacedBeforeSubmission();
      }
      if (request.signal.aborted) return result({ cancelled: true, harnessStarted: false });
      if (paste.reason === "input_busy") {
        return this.degrade(
          "input_busy",
          "la caja cambió mientras se persistía quarantine-pending; se preserva intacta",
          request,
        );
      }
      return this.degrade("handshake_failed", "tmux no aceptó el pegado del prompt", request);
    }

    // From here the turn MAY be in flight inside the TUI. No uncertainty falls back to the
    // alternative transport; see `harvest`.
    // Clearing the notice is observability, not part of the commit. If abort arrives while tmux
    // responds, leave that read in the background and ENTER the bounded drain now.
    await clearDegradation(
      this.options.tmux,
      ready.sessionId,
      TUI_WINDOW,
      this.tmuxControl(request.signal),
    );
    const harvested = await this.harvest(
      request,
      baseline,
      identity,
      generating,
      promptText,
      correlationId,
      pending,
    );
    if (harvested.terminalBoundary) await this.disarmPendingQuarantine(pending);
    return harvested.result;
  }

  /**
   * Keeps `pane_input_off` from BEFORE the final capture until AFTER Enter.
   *
   * There is no `return` inside the try: the result is only published after the finally has
   * restored and checked exactly the flag/token of this generation. If it cannot, the output is
   * overwritten as ambiguous and the caller quarantines it or terminates it exactly.
   */
  private async commitUnderInputBarrier(
    barrier: PaneInputBarrier,
    buffer: string,
    promptText: string,
    signal: AbortSignal,
  ): Promise<PromptCommitOutcome> {
    const identity = barrier.identity;
    let outcome: PromptCommitOutcome | undefined;
    try {
      const paste = await pastePrompt(
        this.options.tmux,
        identity,
        buffer,
        promptText,
        {
          signal,
          timeoutMs: this.quarantineOperationTimeoutMs(),
          verifyInputEmpty: true,
          inputBarrier: barrier,
        },
      );
      if (!paste.bufferScrubbed) {
        outcome = {
          state: "ambiguous",
          detail: "tmux no acreditó el borrado ni el scrub del buffer nombrado",
          forceTerminate: paste.state !== "not_pasted",
        };
      } else if (paste.state === "ambiguous") {
        outcome = {
          state: "ambiguous",
          detail: "tmux perdió el resultado de la mutación que pegaba el prompt",
          forceTerminate: true,
        };
      } else if (paste.state === "not_pasted") {
        outcome = { state: "not_pasted", paste };
      } else {
        // Once the paste succeeds, the operation is committed even if a cancellation arrives.
        const settled = await beforeDeadline(
          this.options.sleep(this.options.settleMs ?? SETTLE_MS),
          this.quarantineDeadline(),
        );
        if (!settled.completed) {
          outcome = {
            state: "ambiguous",
            detail: "wait between paste and Enter did not reach a postcondition",
            forceTerminate: true,
          };
        } else {
          // Delivery cancellation does not cancel the commit; the client has deadline and real reap.
          const entered = await sendEnter(
            this.options.tmux,
            identity,
            this.tmuxControl(),
            barrier,
          );
          outcome = entered === "applied"
            ? { state: "entered" }
            : {
              state: "ambiguous",
              detail: entered === "not_applied"
                ? "la generación cambió después del paste antes de que Enter pudiera aplicarse"
                : "el resultado de Enter es ambiguo después del paste",
              forceTerminate: true,
            };
        }
      }
    } catch {
      outcome = {
        state: "ambiguous",
        detail: "falló el commit paste+Enter bajo la exclusión de input",
        forceTerminate: true,
      };
    } finally {
      const released = await releasePaneInputBarrier(
        this.options.tmux,
        barrier,
        this.tmuxControl(),
      );
      if (released !== "applied") {
        outcome = {
          state: "ambiguous",
          detail: released === "not_applied"
            ? "la generación cambió antes de restaurar su flag exacto de input"
            : "tmux no acreditó la restauración exacta del flag/token de input",
          forceTerminate: true,
        };
      }
    }
    return outcome ?? {
      state: "ambiguous",
      detail: "el commit de input terminó sin postcondición",
      forceTerminate: true,
    };
  }

  private async preflight(signal: AbortSignal): Promise<
    | { ok: true; sessionId: string; identity: PaneIdentity }
    | { ok: false; reason: EnsureFailure; detail: string }
    | { ok: false; cancelled: true }
  > {
    const ensure = await ensureSharedSession(
      this.options.tmux,
      {
        alias: this.options.alias,
        harness: this.options.harness,
        workspace: this.options.workspace,
        ...(this.options.command === undefined ? {} : { command: this.options.command }),
        ...(this.options.resume === undefined ? {} : { resume: this.options.resume }),
        ...(this.options.environment === undefined ? {} : { environment: this.options.environment }),
      },
      this.ensureOptions(signal),
    );
    if (ensure.cancelled === true || signal.aborted) return { ok: false, cancelled: true };
    if (!ensure.ready) {
      this.exactSessionId = ensure.sessionId;
      return { ok: false, reason: ensure.failure ?? "session_absent", detail: ensure.detail };
    }
    if (ensure.sessionId === undefined) {
      return {
        ok: false,
        reason: "session_identity_unverified",
        detail: "tmux no devolvió el session_id exacto de la sesión acreditada",
      };
    }
    this.exactSessionId = ensure.sessionId;
    // `ensure` accredits pane/PID/command as a single generation. Do not re-resolve by
    // `session:window`, because a window with several panes could pick the active one silently.
    const identity = ensure.pane;
    if (signal.aborted) return { ok: false, cancelled: true };
    if (identity === undefined
      || identity.sessionId !== ensure.sessionId
      || identity.sessionName !== sessionName(this.options.alias)
      || identity.windowName !== TUI_WINDOW
      || (ensure.pid !== undefined && identity.panePid !== ensure.pid)
      || !await paneIdentityStillCurrent(this.options.tmux, identity, this.tmuxControl(signal))) {
      return {
        ok: false,
        reason: "session_identity_unverified",
        detail: "tmux no pudo acreditar sesión, ventana, pane_id y pane_pid como una sola generación",
      };
    }
    if (ensure.created) {
      // Notifies the creation or resume of the shared session.
      await this.note({
        reason: "session_created",
        detail: ensure.resumed === true
          ? `no había sesión compartida: se creó una REANUDANDO la conversación anterior (${ensure.detail})`
          : `no había sesión compartida y se creó una nueva, sin contexto previo: ${ensure.detail}`,
        occurredAt: new Date().toISOString(),
        fellBack: false,
      }, ensure.sessionId);
      if (signal.aborted) return { ok: false, cancelled: true };
      // A freshly born TUI is not "the same as before": the old PID means nothing now.
      this.lastPanePid = ensure.pid;
      this.lastSessionId = undefined;
      return { ok: true, sessionId: ensure.sessionId, identity };
    }
    await this.notePaneIdentity(ensure.pid);
    if (signal.aborted) return { ok: false, cancelled: true };
    return { ok: true, sessionId: ensure.sessionId, identity };
  }

  private ensureOptions(signal: AbortSignal): EnsureOptions {
    return {
      sleep: this.options.sleep,
      signal,
      ...(this.options.readyTimeoutMs === undefined
        ? {}
        : { readyTimeoutMs: this.options.readyTimeoutMs }),
      ...(this.options.onNotice === undefined ? {} : { log: this.options.onNotice }),
    };
  }


}
