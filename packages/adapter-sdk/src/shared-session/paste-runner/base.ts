import { randomBytes } from "node:crypto"; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { signalAborted } from "../../runtime-state.js";
import type { CommandRunRequest, CommandRunResult } from "../../sdk/types.js";
import { validateStructuredOutput } from "../../sdk/output-parser.js";
import { envelopeHasCorrelation, stripJsonFence } from "../envelope.js";
import { inputBoxState } from "../pane.js";
import type { EnsureFailure } from "../session.js";
import { TUI_WINDOW } from "../types.js";
import type { SharedSessionDegradation, TranscriptReader, TurnOutcome } from "../types.js";
import {
  announceDegradation,
  announceNotice,
  capturePane,
  clearCurrentPaneQuarantine,
  clearPaneQuarantine,
  killPaneGeneration,
  markPaneQuarantined,
  paneGenerationKey,
  paneIdentityStillCurrent,
  paneQuarantineState,
  samePaneIdentity,
  type PaneIdentity,
} from "../tmux.js";
import type { PasteSessionOptions, PendingQuarantine, QuarantinePersistence } from "./contracts.js";
import {
  fileQuarantinePersistence,
  pendingQuarantinePath,
  pendingQuarantinePreparationPath,
  readQuarantineMarker,
} from "./persistence.js";
import {
  beforeDeadline,
  ACQUIRE_MODAL_TIMEOUT_MS,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  fileSize,
  QUARANTINE_OPERATION_TIMEOUT_MS,
  result,
} from "./runtime.js";

export abstract class PasteSessionRunnerBase<E> {
  protected pending: SharedSessionDegradation | undefined;
  /** Pane PID from the previous turn, to detect that the TUI restarted on its own. */
  protected lastPanePid: string | undefined;
  /** Conversation session ID from the previous turn, to detect restarts or context clears. */
  protected lastSessionId: string | undefined;
  /** Compaction events already announced, to avoid repeating the notice on every poll of the same turn. */
  protected readonly reportedBoundaries = new Set<string>();
  /** `$N` proven for this call; notices also cannot be dropped by a name-based replacement. */
  protected exactSessionId: string | undefined;
  /** In-memory fallback if tmux could not persist the quarantine mark. */
  protected locallyQuarantined: PaneIdentity | undefined;
  protected readonly heldQuarantines = new Map<string, PendingQuarantine>();

  protected constructor(protected readonly options: PasteSessionOptions<E>) {}

  takeDegradation(): SharedSessionDegradation | undefined {
    const degradation = this.pending;
    this.pending = undefined;
    return degradation;
  }

  protected quarantineDeadline(): number {
    return Date.now() + this.quarantineOperationTimeoutMs();
  }

  protected quarantineOperationTimeoutMs(): number {
    return Math.max(
      1,
      this.options.quarantineOperationTimeoutMs ?? QUARANTINE_OPERATION_TIMEOUT_MS,
    );
  }

  protected tmuxControl(signal?: AbortSignal): {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  } {
    return {
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.quarantineOperationTimeoutMs(),
    };
  }

  protected tmuxControlUntil(deadline: number): { readonly timeoutMs: number } {
    return { timeoutMs: Math.max(1, deadline - Date.now()) };
  }

  protected quarantinePersistence(): QuarantinePersistence {
    return this.options.quarantinePersistence ?? fileQuarantinePersistence;
  }

  /**
   * Recovers the only safe crash: terminal envelope is durable, but the process died before
   * removing `quarantine-pending`.
   *
   * Sidecar name carries the correlation nonce, content carries the generation. Only both
   * matching plus a valid contract envelope allow cleanup. A foreign-turn envelope, similar-shape
   * JSON, partial read, or timeout preserves the quarantine.
   */
  protected async reconcileTerminalPending(identity: PaneIdentity): Promise<void> {
    const quarantineFile = this.options.quarantineFile;
    const findEnvelope = this.options.transcript.findEnvelope?.bind(this.options.transcript);
    if (quarantineFile === undefined || findEnvelope === undefined) return;

    const candidates = await this.pendingQuarantineSidecars(quarantineFile);
    if (candidates === undefined || candidates.length === 0) return;

    let clearedCurrent = false;
    for (const candidate of candidates) {
      const markerRead = await beforeDeadline(
        readQuarantineMarker(candidate.file),
        this.quarantineDeadline(),
      );
      if (!markerRead.completed || markerRead.value?.state !== "present") continue;
      if (markerRead.value.value !== paneGenerationKey(identity)) continue;
      if (!await this.hasValidTerminalEnvelope(candidate.correlationId, findEnvelope)) continue;
      const cleared = await beforeDeadline(
        this.quarantinePersistence().clear(candidate.file),
        this.quarantineDeadline(),
      );
      if (cleared.completed && cleared.value === true) {
        clearedCurrent = true;
        this.heldQuarantines.delete(candidate.correlationId);
      }
    }
    if (!clearedCurrent) return;

    // A remaining current/temp/unreadable sidecar means not all commits of this generation have a
    // terminal boundary. `inspect` aggregates exactly those sources.
    const afterPending = await beforeDeadline(
      this.quarantinePersistence().inspect(quarantineFile, identity),
      this.quarantineDeadline(),
    );
    if (!afterPending.completed || afterPending.value === "unreadable") return;
    if (afterPending.value === "current") {
      // Canonical mark was promoted from the pending we just correlated. Remove and re-inspect
      // before touching tmux; a concurrent sidecar blocks.
      const canonical = await beforeDeadline(
        readQuarantineMarker(quarantineFile),
        this.quarantineDeadline(),
      );
      if (!canonical.completed || canonical.value?.state !== "present"
        || canonical.value.value !== paneGenerationKey(identity)) return;
      const cleared = await beforeDeadline(
        this.quarantinePersistence().clear(quarantineFile),
        this.quarantineDeadline(),
      );
      if (!cleared.completed || cleared.value !== true) return;
    }
    const finalFileState = await beforeDeadline(
      this.quarantinePersistence().inspect(quarantineFile, identity),
      this.quarantineDeadline(),
    );
    if (!finalFileState.completed
      || (finalFileState.value !== "absent" && finalFileState.value !== "stale")) return;
    if (!await clearCurrentPaneQuarantine(this.options.tmux, identity, this.tmuxControl())) return;
    this.forgetLocalQuarantine(identity);
  }

  protected async pendingQuarantineSidecars(
    quarantineFile: string,
  ): Promise<readonly { readonly correlationId: string; readonly file: string }[] | undefined> {
    const listed = await beforeDeadline(
      readdir(dirname(quarantineFile)),
      this.quarantineDeadline(),
    );
    if (!listed.completed || listed.value === undefined) return undefined;
    const prefix = `${basename(quarantineFile)}.`;
    const suffix = ".pending";
    return listed.value.flatMap((name) => {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) return [];
      const correlationId = name.slice(prefix.length, -suffix.length);
      return /^[a-f0-9]{64}$/u.test(correlationId)
        ? [{ correlationId, file: join(dirname(quarantineFile), name) }]
        : [];
    });
  }

  protected async hasValidTerminalEnvelope(
    correlationId: string,
    findEnvelope: NonNullable<TranscriptReader<E>["findEnvelope"]>,
  ): Promise<boolean> {
    const filesRead = await beforeDeadline(
      this.options.transcript.files(),
      this.quarantineDeadline(),
    );
    if (!filesRead.completed || filesRead.value === undefined) return false;
    // Latest transcript/rollout files sort last. Finding the active one first avoids re-reading
    // years of history during exceptional recovery.
    for (const file of [...filesRead.value].reverse()) {
      const sliceRead = await beforeDeadline(
        this.options.transcript.read(file, 0),
        this.quarantineDeadline(),
      );
      if (!sliceRead.completed || sliceRead.value === undefined) return false;
      const outcome = findEnvelope(sliceRead.value.entries, correlationId);
      if (outcome === undefined) continue;
      if (outcome.kind !== "answer"
        || !envelopeHasCorrelation(outcome.text, correlationId)) return false;
      try {
        validateStructuredOutput(JSON.parse(stripJsonFence(outcome.text)) as unknown);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Builds the durable barrier BEFORE paste. With a file configured, disk is mandatory; without
   * one (tests/dev), the tmux session option is the persistent barrier.
   */
  protected async armPendingQuarantine(
    identity: PaneIdentity,
    correlationId: string,
  ): Promise<{ readonly ok: true; readonly pending: PendingQuarantine } | { readonly ok: false }> {
    const file = this.options.quarantineFile === undefined
      ? undefined
      : pendingQuarantinePath(this.options.quarantineFile, correlationId);
    if (file !== undefined) {
      const persistence = this.quarantinePersistence();
      // Potentially slow writes never target the active name. Only leaves a preparation with attempt
      // token; a timeout, crash, or wrapper ignoring cancellation may complete it late, but that
      // phase doesn't mean the pane received input and doesn't block a restart.
      const preparation = pendingQuarantinePreparationPath(
        file,
        randomBytes(32).toString("hex"),
      );
      const persistOperation = Promise.resolve().then(
        () => persistence.persist(preparation, identity),
      );
      const persisted = await beforeDeadline(
        persistOperation,
        this.quarantineDeadline(),
      );
      if (!persisted.completed || persisted.value !== true) {
        // Path carries THIS attempt's token. Compensation causally awaits its operation: if it finishes
        // late, it only clears that preparation and never a foreign or already-committed pending.
        void persistOperation.catch(() => false)
          .then(() => persistence.clear(preparation))
          .catch(() => false);
        return { ok: false };
      }
      // This logical link/rename is the only pre-paste commit. Not wrapped in `beforeDeadline`:
      // aborting an atomic publish recreates exactly the race being fixed. `commitPrepared` is
      // no-clobber; false preserves any other attempt's marker.
      const committed = await Promise.resolve()
        .then(() => persistence.commitPrepared(preparation, file, identity))
        .catch(() => false);
      if (!committed) {
        await beforeDeadline(
          Promise.resolve().then(() => persistence.clear(preparation)),
          this.quarantineDeadline(),
        );
        return { ok: false };
      }
      // Best-effort redundancy. The sidecar already makes a tmux timeout safe.
      await markPaneQuarantined(this.options.tmux, identity, this.tmuxControl());
      return { ok: true, pending: { identity, file, correlationId } };
    }
    const marked = await markPaneQuarantined(this.options.tmux, identity, this.tmuxControl());
    return marked
      ? { ok: true, pending: { identity, correlationId } }
      : { ok: false };
  }

  /** Called only after proven no-paste or a correlated/generation-aware terminal boundary. */
  protected async disarmPendingQuarantine(pending: PendingQuarantine): Promise<void> {
    this.heldQuarantines.delete(pending.correlationId);
    if (pending.file !== undefined) {
      await beforeDeadline(
        this.quarantinePersistence().clear(pending.file),
        this.quarantineDeadline(),
      );
    }
    await clearCurrentPaneQuarantine(
      this.options.tmux,
      pending.identity,
      this.tmuxControl(),
    );
  }

  protected async quarantineState(
    identity: PaneIdentity,
  ): Promise<"current" | "stale" | "absent" | "unreadable"> {
    if (this.locallyQuarantined !== undefined
      && samePaneIdentity(this.locallyQuarantined, identity)) return "current";
    // Both sources are deadline-observed. Specifically, reading tmux first used to turn a hung
    // socket into a deadlock before reaching the already-durable on-disk quarantine-pending.
    // A timeout is `unreadable`, never absence.
    const deadline = this.quarantineDeadline();
    const [tmuxState, fileObserved] = await Promise.all([
      paneQuarantineState(this.options.tmux, identity, this.tmuxControl())
        .catch(() => "unreadable" as const),
      this.options.quarantineFile === undefined
        ? Promise.resolve({ completed: true, value: "absent" as const })
        : beforeDeadline(
          this.quarantinePersistence().inspect(this.options.quarantineFile, identity),
          deadline,
        ),
    ]);
    const fileState = fileObserved.completed && fileObserved.value !== undefined
      ? fileObserved.value
      : "unreadable";
    if (tmuxState === "current" || fileState === "current") return "current";
    if (tmuxState === "unreadable" || fileState === "unreadable") return "unreadable";
    return tmuxState === "stale" || fileState === "stale" ? "stale" : "absent";
  }

  protected async capturedPane(
    identity: PaneIdentity,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    return await capturePane(this.options.tmux, identity.paneId, {
      styled: true,
      control: this.tmuxControl(signal),
    });
  }

  protected forgetLocalQuarantine(identity: PaneIdentity): void {
    if (this.locallyQuarantined !== undefined
      && samePaneIdentity(this.locallyQuarantined, identity)) {
      this.locallyQuarantined = undefined;
    }
  }

  protected async clearStaleQuarantine(
    identity: PaneIdentity,
    state: "stale" | "absent",
  ): Promise<void> {
    if (this.locallyQuarantined !== undefined
      && !samePaneIdentity(this.locallyQuarantined, identity)) {
      this.locallyQuarantined = undefined;
    }
    if (state !== "stale") return;
    const observed = await paneQuarantineState(this.options.tmux, identity, this.tmuxControl());
    if (observed === "stale") {
      await clearPaneQuarantine(this.options.tmux, identity, this.tmuxControl());
    }
    // Obsolete on-disk mark is preserved: it doesn't block another generation and the next
    // quarantine replaces it atomically. Not deleting avoids a compare/unlink race between
    // two processes.
  }

  protected async quarantine(
    identity: PaneIdentity,
    pending: PendingQuarantine,
    forceTerminate = false,
  ): Promise<string> {
    this.locallyQuarantined = identity;
    this.heldQuarantines.set(pending.correlationId, pending);
    const fileMarked = this.options.quarantineFile === undefined
      ? false
      : (await beforeDeadline(
        this.quarantinePersistence().persist(this.options.quarantineFile, identity),
        this.quarantineDeadline(),
      )).value === true;
    const tmuxMarked = await markPaneQuarantined(
      this.options.tmux,
      identity,
      this.tmuxControl(),
    );
    if ((fileMarked || tmuxMarked) && !forceTerminate) {
      return "su generación quedó en cuarentena durable y no se reutilizará";
    }
    // If neither mark could persist, destroying THIS exact generation is the only state that
    // remains safe after restarting the adapter.
    const killed = await killPaneGeneration(this.options.tmux, identity, this.tmuxControl());
    const generationGone = killed === "applied" || killed === "not_applied";
    return generationGone
      ? forceTerminate
        ? "se terminó o ya había desaparecido únicamente esa generación tras la mutación ambigua"
        : "no se pudo persistir la cuarentena y se terminó únicamente esa generación del pane"
      : fileMarked || tmuxMarked
        ? "la terminación exacta quedó ambigua, pero la generación conserva cuarentena durable"
      : pending.file === undefined
        ? "las promociones fallaron, pero quarantine-pending ya quedó durable en tmux antes del paste"
        : "las promociones fallaron, pero quarantine-pending ya quedó durable en disco antes del paste";
  }

  /**
   * A prompt may have been pasted or executed: never falls back to the alternative transport.
   * The generation is durably blocked (or exactly terminated) and the result keeps
   * `harnessStarted: undefined`, forcing the engine to treat it as ambiguous.
   */
  protected async ambiguousCommittedState(
    identity: PaneIdentity,
    detail: string,
    cancelled: boolean,
    pending: PendingQuarantine,
    forceTerminate = false,
  ): Promise<CommandRunResult> {
    const quarantineDetail = await this.quarantine(identity, pending, forceTerminate);
    return result({
      ...(cancelled ? { cancelled: true } : { exitCode: 1 }),
      stderr: `${detail}; el estado de ejecución es ambiguo; ${quarantineDetail}`,
    });
  }

  /**
   * Uncertain acquisition occurs BEFORE paste: no turn yet exists that would justify killing the
   * TUI. The proposed token also doesn't prove ownership, so attempting `release` could enable or
   * alter a foreign barrier. The durable pending is preserved and no compensatory mutation is
   * performed on the human process.
   */
  protected ambiguousBarrierAcquisitionState(
    identity: PaneIdentity,
    detail: string,
    cancelled: boolean,
    pending: PendingQuarantine,
  ): CommandRunResult {
    this.locallyQuarantined = identity;
    const durableBoundary = pending.file === undefined ? "tmux" : "disco";
    return result({
      ...(cancelled ? { cancelled: true } : { exitCode: 1 }),
      stderr: `${detail}; no se acreditó ownership de la barrera y no se intentó liberarla ni `
        + `terminar el pane; quarantine-pending queda durable en ${durableBoundary}`,
    });
  }

  /** Detects changes in the TUI process PID between turns. */
  protected async notePaneIdentity(pid: string | undefined): Promise<void> {
    if (pid === undefined) return;
    if (this.lastPanePid !== undefined && this.lastPanePid !== pid) {
      await this.note({
        reason: "context_reset",
        detail: `el panel pasó del proceso ${this.lastPanePid} al ${pid}`,
        occurredAt: new Date().toISOString(),
        fellBack: false,
      });
      // The new TUI conversation has nothing to do with the previous one: comparing its identity to
      // the prior one would yield a clear that nobody performed.
      this.lastSessionId = undefined;
    }
    this.lastPanePid = pid;
  }

  protected async acquireInputBox(
    target: string,
    identity: PaneIdentity,
    signal: AbortSignal,
  ): Promise<
    { ok: true; pane: string | undefined }
    | { ok: false; reason: "input_busy" | "modal_blocking"; detail: string }
    | { ok: false; cancelled: true }
    | { ok: false; replaced: true }
  > {
    const deadline = Date.now() + (this.options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
    const modalDeadline = Date.now() + ACQUIRE_MODAL_TIMEOUT_MS;
    let evidence = "la caja de entrada nunca quedó libre";
    let modal = false;
    for (;;) {
      if (signal.aborted) return { ok: false, cancelled: true };
      const pane = await capturePane(this.options.tmux, target, {
        styled: true,
        control: this.tmuxControl(signal),
      });
      if (signalAborted(signal)) return { ok: false, cancelled: true };
      if (pane === undefined
        || !await paneIdentityStillCurrent(this.options.tmux, identity, this.tmuxControl(signal))) {
        if (signalAborted(signal)) return { ok: false, cancelled: true };
        return { ok: false, replaced: true };
      }
      if (signalAborted(signal)) return { ok: false, cancelled: true };
      const state = inputBoxState(pane);
      // The pane we decided to paste into is the one to inspect for merged turn: recapturing later
      // would be a different moment.
      if (!state.occupied) return { ok: true, pane };
      evidence = state.evidence;
      modal = state.kind === "modal";
      if (Date.now() >= (modal ? Math.min(deadline, modalDeadline) : deadline)) {
        return modal
          ? { ok: false, reason: "modal_blocking", detail: evidence }
          : { ok: false, reason: "input_busy", detail: evidence };
      }
      await this.options.sleep(this.options.pollMs ?? DEFAULT_POLL_MS);
      if (signalAborted(signal)) return { ok: false, cancelled: true };
    }
  }

  /** Transcript snapshot BEFORE injection: the only thing bounding what could change during the turn. */
  protected async baseline(signal: AbortSignal): Promise<ReadonlyMap<string, number> | undefined> {
    const sizes = new Map<string, number>();
    if (signal.aborted) return undefined;
    const files = await this.options.transcript.files();
    if (signalAborted(signal)) return undefined;
    for (const file of files) {
      const size = await fileSize(file);
      if (signalAborted(signal)) return undefined;
      if (size >= 0) sizes.set(file, size);
    }
    return sizes;
  }

  /**
   * Turn landed in a DIFFERENT conversation than the previous turn = context clear.
   *
   * Checked after injection, when the request's landing is known with certainty (before, the
   * "active" log is just a guess). Not degraded or blocked: clearing is the owner's deliberate
   * action and the fallback would also start without memory, so degrading loses the only thing
   * this design justifies (the turn being visible in the pane) for no gain. The sender must not
   * keep believing they are on the same thread.
   */
  protected async noteTranscriptIdentity(sessionId: string | undefined): Promise<void> {
    if (sessionId === undefined) return;
    if (this.lastSessionId !== undefined && this.lastSessionId !== sessionId) {
      await this.note({
        reason: "context_cleared",
        detail: `la conversación de la terminal pasó de ${this.lastSessionId} a ${sessionId}`
          + " sin que el proceso se reiniciara (/clear en claude, /new en codex)",
        occurredAt: new Date().toISOString(),
        fellBack: false,
      });
      this.reportedBoundaries.clear();
    }
    this.lastSessionId = sessionId;
  }

  /**
   * Compactions since the prompt was pasted: only what was written after the prior snapshot.
   *
   * Restricting to the new is what makes the notice meaningful: a weeks-old log contains dozens
   * of old compactions and notifying them would be noise every delivery.
   */
  protected async noteCompactions(appended: readonly E[]): Promise<void> {
    for (const event of this.options.transcript.compactions(appended)) {
      if (this.reportedBoundaries.has(event.id)) continue;
      this.reportedBoundaries.add(event.id);
      await this.note({
        reason: "context_compacted",
        detail: event.detail,
        occurredAt: new Date().toISOString(),
        fellBack: false,
      });
    }
  }

  /**
   * Inspects transcript files that grew or appeared after the paste.
   */
  protected async locateInjectedTurn(
    baseline: ReadonlyMap<string, number>,
    promptText: string,
    correlationId: string,
  ): Promise<{
    injected?: { file: string; key: string; sessionId?: string };
    started: boolean;
    /** Anything grew since the paste? See `DEFAULT_QUIET_MS`. */
    activity: boolean;
    /** Envelope written after the paste, when there is no own turn to descend from. */
    envelope?: TurnOutcome;
  }> {
    const port = this.options.transcript;
    let started = false;
    let activity = false;
    let envelope: TurnOutcome | undefined;
    for (const file of await port.files()) {
      const size = await fileSize(file);
      const previous = baseline.get(file) ?? -1;
      if (size <= previous) continue;
      activity = true;
      const slice = await port.read(file, Math.max(previous, 0));
      if (port.startedTurn?.(slice.appended) === true) started = true;
      // Only `appended`: what was written BEFORE the paste cannot be this turn's reply.
      envelope = port.findEnvelope?.(slice.appended, correlationId) ?? envelope;
      const found = port.findInjected(file, slice.entries, promptText);
      if (found === undefined) continue;
      return {
        injected: found.sessionId === undefined
          ? { file, key: found.key }
          : { file, key: found.key, sessionId: found.sessionId },
        started,
        activity,
        ...(envelope === undefined ? {} : { envelope }),
      };
    }
    return { started, activity, ...(envelope === undefined ? {} : { envelope }) };
  }

  /**
   * Final envelope sweep, just before declaring the delivery dead.
   *
   * Exists so the deadline is a ceiling, not a guillotine: a delivery whose envelope is already
   * written cannot die by timeout. Same search as the loop, repeated at the only point where the
   * loop will not look again.
   */
  protected async lastEnvelope(
    baseline: ReadonlyMap<string, number>,
    injected: { file: string; key: string } | undefined,
    correlationId: string,
  ): Promise<TurnOutcome | undefined> {
    const port = this.options.transcript;
    if (port.findEnvelope === undefined) return undefined;
    if (injected !== undefined) {
      const slice = await port.read(injected.file, baseline.get(injected.file) ?? 0);
      return port.findEnvelope(slice.entries, correlationId, injected.key);
    }
    let envelope: TurnOutcome | undefined;
    for (const file of await port.files()) {
      const previous = baseline.get(file) ?? -1;
      if (await fileSize(file) <= previous) continue;
      const slice = await port.read(file, Math.max(previous, 0));
      envelope = port.findEnvelope(slice.appended, correlationId) ?? envelope;
    }
    return envelope;
  }

  /**
   * Returns the harvested envelope WITHOUT ancestry, stating why.
   *
   * The notice is not decorative: a merged turn's reply answers both the owner and the bus, and
   * the sender has the right to know. `fellBack: false` because the turn DID go through the
   * terminal —it ran fully in the owner's pane— so there is nothing to re-run via the fallback.
   */
  protected async harvested(
    outcome: TurnOutcome,
    sessionId: string | undefined,
    generating: boolean,
  ): Promise<CommandRunResult> {
    if (outcome.kind === "failed") {
      return result({ exitCode: 1, stderr: outcome.detail });
    }
    await this.note({
      reason: "turn_merged",
      detail: generating
        ? "la terminal estaba generando cuando entró el pedido, así que lo encoló y lo fundió con"
          + " el turno en curso; el sobre se correlacionó por el registro, no por la cadena de turnos"
        : "el pedido no abrió un turno propio en el registro; el sobre se correlacionó por el"
          + " registro, no por la cadena de turnos",
      occurredAt: new Date().toISOString(),
      fellBack: false,
    });
    // DO NOT clear the input box: the turn ran, so the box already cleared itself, and a late
    // `C-u` would delete what the owner is typing now. This runner never uses C-u: in doubt it
    // preserves the human input and the next acquisition fails closed.
    return result({
      exitCode: 0,
      stdout: this.options.transcript.stdout(outcome.text, outcome.sessionId ?? sessionId),
    });
  }

  /**
   * Falls back SAYING SO, on three surfaces at once.
   *
   * Silent degradation is indistinguishable from success, so it cannot exist.
   */
  protected async degrade(
    reason: EnsureFailure
      | "input_busy"
      | "modal_blocking"
      | "handshake_failed",
    detail: string,
    request: CommandRunRequest,
  ): Promise<CommandRunResult> {
    if (request.signal.aborted) return result({ cancelled: true, harnessStarted: false });
    const degradation: SharedSessionDegradation = {
      reason,
      detail,
      occurredAt: new Date().toISOString(),
      fellBack: true,
    };
    this.record(degradation);
    if (this.exactSessionId !== undefined) {
      await announceDegradation(
        this.options.tmux,
        this.exactSessionId,
        TUI_WINDOW,
        `CAUCE: un turno del bus NO pasó por esta terminal (${reason}: ${detail})`,
      );
    }
    if (signalAborted(request.signal)) return result({ cancelled: true, harnessStarted: false });
    return this.options.fallback.run(request);
  }

  /**
   * Accumulates notices within the same turn without losing any.
   *
   * There can be two: TUI restarted (`context_reset`) and the turn also ended up on the fallback
   * path. Keeping only the last would drop the first, so details are concatenated and the
   * degrading one wins, being the more severe.
   */
  protected record(degradation: SharedSessionDegradation): void {
    const previous = this.pending;
    this.pending = previous === undefined
      ? degradation
      : {
        reason: degradation.fellBack ? degradation.reason : previous.reason,
        detail: `${previous.detail}; ${degradation.detail}`,
        occurredAt: degradation.occurredAt,
        fellBack: previous.fellBack || degradation.fellBack,
      };
    this.options.onDegradation?.(degradation);
  }

  /**
   * A notice that is NOT a fallback: records and also says it in the pane, without red tint.
   *
   * The owner is the only one who can compensate a compaction —re-pasting what matters— and the
   * only one who knows if they did the clear, so the notice must reach them, not just the Telegram
   * sender.
   */
  protected async note(
    degradation: SharedSessionDegradation,
    sessionId: string | undefined = this.exactSessionId,
  ): Promise<void> {
    this.record(degradation);
    if (sessionId === undefined) return;
    await announceNotice(
      this.options.tmux,
      sessionId,
      TUI_WINDOW,
      `CAUCE: ${degradation.reason} — ${degradation.detail}`,
    );
  }
}
