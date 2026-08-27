import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../sdk/types.js";
import { validateStructuredOutput } from "../sdk/output-parser.js";
import {
  acquirePaneInputBarrier,
  announceDegradation,
  announceNotice,
  capturePane,
  clearCurrentPaneQuarantine,
  clearPaneQuarantine,
  clearDegradation,
  inspectExactPane,
  interruptPane,
  killPaneGeneration,
  markPaneQuarantined,
  paneGenerationKey,
  paneIdentityStillCurrent,
  paneQuarantineState,
  pastePrompt,
  releasePaneInputBarrier,
  sendEnter,
  samePaneIdentity,
  samePaneProcess,
  type PaneIdentity,
  type PaneInputBarrier,
  type PastePromptResult,
  type TmuxController,
} from "./tmux.js";
import {
  correlateEnvelopePrompt,
  envelopeHasCorrelation,
  stripJsonFence,
} from "./envelope.js";
import { inputBoxState, turnInFlight } from "./pane.js";
import {
  ensureSharedSession,
  type EnsureFailure,
  type EnsureOptions,
} from "./session.js";
import { TUI_WINDOW, sessionName } from "./types.js";
import type {
  ResumeSpec,
  SharedSessionDegradation,
  SharedSessionHarness,
  SharedSessionRunner,
  TranscriptReader,
  TurnOutcome,
} from "./types.js";

export interface PasteSessionOptions<E> {
  readonly alias: string;
  /** Qué TUI corre en el panel. Determina el binario de la sesión compartida. */
  readonly harness: SharedSessionHarness;
  /** Directorio de trabajo de la TUI. */
  readonly workspace: string;
  /** Lector de transcript del harness para obtener los sobres estructurados. */
  readonly transcript: TranscriptReader<E>;
  /** Variables de entorno fijadas al crear el panel. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly tmux: TmuxController;
  /** Runner de respaldo utilizado cuando la sesión compartida se degrada. */
  readonly fallback: CommandRunner;
  readonly sleep: (ms: number) => Promise<void>;
  /** Cuánto se espera a que la caja de entrada quede libre antes de degradar. */
  readonly acquireTimeoutMs?: number;
  /**
   * Recorte opcional del turno inyectado por debajo de `request.timeoutMs`.
   * Si vence el plazo, el estado de ejecución se reporta como ambiguo sin reintento automático.
   */
  readonly turnTimeoutMs?: number;
  /** Espera terminal máxima tras interrumpir un turno cancelado antes de poner el pane en cuarentena. */
  readonly cancelDrainTimeoutMs?: number;
  /** Marca durable de cuarentena; producción la ubica dentro del state directory del alias. */
  readonly quarantineFile?: string;
  /** Presupuesto acotado para cada operación de cuarentena. */
  readonly quarantineOperationTimeoutMs?: number;
  /** Persistencia inyectable para acreditar fallos y bloqueos de disco en pruebas. */
  readonly quarantinePersistence?: QuarantinePersistence;
  /** Tiempo de espera entre el pegado y el envío de Enter. */
  readonly settleMs?: number;
  /** Tiempo de espera para que la TUI registre el turno pegado. */
  readonly injectTimeoutMs?: number;
  /** Tiempo límite para correlacionar el pegado. */
  readonly correlationTimeoutMs?: number;
  /** Tiempo de inactividad para considerar perdido un pegado sin correlacionar. */
  readonly quietTimeoutMs?: number;
  /** Techo absoluto de la espera por un turno fundido. */
  readonly mergedGraceMs?: number;
  readonly pollMs?: number;
  readonly readyTimeoutMs?: number;
  readonly command?: string;
  /** Cómo se reanuda la conversación si es necesario recrear el panel. Ver `ResumeSpec`. */
  readonly resume?: ResumeSpec;
  readonly onDegradation?: (degradation: SharedSessionDegradation) => void;
  /** Notificación de incidencias durante la inicialización o reanudación. */
  readonly onNotice?: (detail: string) => void;
}

interface CommittedRunResult {
  readonly result: CommandRunResult;
  /** Transcript correlacionado o desaparición/cambio exacto: ya es seguro retirar pending. */
  readonly terminalBoundary: boolean;
}

type PromptCommitOutcome =
  | { readonly state: "entered" }
  | { readonly state: "not_pasted"; readonly paste: PastePromptResult }
  | {
    readonly state: "ambiguous";
    readonly detail: string;
    readonly forceTerminate: boolean;
  };

const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 750;
const DEFAULT_CANCEL_DRAIN_TIMEOUT_MS = 30_000;
const QUARANTINE_OPERATION_TIMEOUT_MS = 2_000;

export type FileQuarantineState = "current" | "stale" | "absent" | "unreadable";

/** Operaciones mínimas de la barrera durable, separadas para poder probar I/O colgado. */
export interface QuarantinePersistence {
  readonly inspect: (path: string, identity: PaneIdentity) => Promise<FileQuarantineState>;
  readonly persist: (path: string, identity: PaneIdentity) => Promise<boolean>;
  /**
   * Publica una preparación pre-paste mediante CAS de nombre: nunca reemplaza un pending que ya
   * exista. El llamador no abandona esta frontera atómica; sólo se pega después de `true`.
   */
  readonly commitPrepared: (
    preparedPath: string,
    pendingPath: string,
    identity: PaneIdentity,
  ) => Promise<boolean>;
  readonly clear: (path: string) => Promise<boolean>;
}

/**
 * Calcula el presupuesto del turno inyectado a partir de `requestTimeoutMs` y `turnTimeoutMs` opcional.
 */
export function turnBudgetMs(requestTimeoutMs: number, turnTimeoutMs?: number): number {
  return turnTimeoutMs === undefined
    ? requestTimeoutMs
    : Math.min(requestTimeoutMs, turnTimeoutMs);
}

/** Tiempo de espera entre el pegado en la caja de entrada y el envío de Enter. */
const SETTLE_MS = 250;

/** Tiempo de espera para que la TUI registre el turno pegado en el transcript. */
const DEFAULT_INJECT_TIMEOUT_MS = 30_000;

/** Intervalo de sondeos entre comprobaciones de vitalidad del pane en tmux. */
const LIVENESS_EVERY = 8;

/** Tiempo límite de espera para correlacionar el prompt pegado en el transcript antes de marcar ambiguo. */
const DEFAULT_CORRELATION_TIMEOUT_MS = 5 * 60_000;

/** Tiempo de inactividad en el transcript necesario para dar por perdido un pegado no correlacionado. */
const DEFAULT_QUIET_MS = 5 * 60_000;

/** Techo máximo de espera ante actividad continua en el transcript sin correlación explícita. */
const DEFAULT_MERGED_GRACE_MS = 30 * 60_000;

/**
 * Ejecutor de sesión compartida que inyecta prompts en la TUI interactiva vía tmux
 * y recupera los resultados desde el transcript estructurado.
 */
export class PasteSessionRunner<E> implements SharedSessionRunner {
  private pending: SharedSessionDegradation | undefined;
  /** PID del panel en el turno anterior, para detectar que la TUI se reinició sola. */
  private lastPanePid: string | undefined;
  /** Identificador de la sesión de conversación anterior para detectar reinicios o vaciados de contexto. */
  private lastSessionId: string | undefined;
  /** Compactaciones ya avisadas, para no repetir el aviso en cada sondeo del mismo turno. */
  private readonly reportedBoundaries = new Set<string>();
  /** `$N` acreditado para esta llamada; los avisos tampoco pueden caer en un reemplazo por nombre. */
  private exactSessionId: string | undefined;
  /** Respaldo en memoria si tmux no pudo persistir la marca de cuarentena. */
  private locallyQuarantined: PaneIdentity | undefined;

  constructor(private readonly options: PasteSessionOptions<E>) {}

  takeDegradation(): SharedSessionDegradation | undefined {
    const degradation = this.pending;
    this.pending = undefined;
    return degradation;
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

    // El pegado y el Enter tienen que ser una operación sola respecto del dueño: entre que se
    // comprueba que la caja está libre y que se envía, no puede haber más esperas de las
    // imprescindibles.
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

    // Si la terminal estaba GENERANDO cuando pegamos, el pegado se encola y se funde con el turno
    // en curso: no habrá turno propio del que descender. No cambia lo que se hace —pegar sigue
    // siendo correcto, el turno acaba ejecutándose en la conversación compartida— cambia lo que se
    // puede AFIRMAR después, y el aviso que lee el dueño. Ver `turnInFlight`.
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

    // A partir de acá el turno PUEDE estar en marcha dentro de la TUI. Ninguna incertidumbre
    // vuelve al transporte alternativo; ver `harvest`.
    // Limpiar el aviso es observabilidad, no parte del commit. Si el aborto llega mientras tmux
    // responde, se deja esa lectura en segundo plano y se entra YA al drenaje acotado.
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
   * Mantiene `pane_input_off` desde ANTES de la captura final hasta DESPUÉS de Enter.
   *
   * No hay `return` dentro del try: el resultado sólo se publica después de que el finally haya
   * restaurado y comprobado exactamente el flag/token de esta generación. Si no puede, la salida
   * se sobreescribe como ambigua y el llamador la pone en cuarentena o la termina exactamente.
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
        // Desde el paste exitoso la operación está comprometida incluso si llega cancelación.
        const settled = await beforeDeadline(
          this.options.sleep(this.options.settleMs ?? SETTLE_MS),
          this.quarantineDeadline(),
        );
        if (!settled.completed) {
          outcome = {
            state: "ambiguous",
            detail: "la espera entre paste y Enter no alcanzó una postcondición",
            forceTerminate: true,
          };
        } else {
          // La cancelación de entrega no cancela el commit; el cliente tiene deadline y reap real.
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
    // `ensure` acredita pane/PID/comando como una sola generación. No se vuelve a resolver por
    // `session:window`, porque una ventana con varios panes podría elegir el activo silenciosamente.
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
      // Notifica la creación o reanudación de la sesión compartida.
      await this.note({
        reason: "session_created",
        detail: ensure.resumed === true
          ? `no había sesión compartida: se creó una REANUDANDO la conversación anterior (${ensure.detail})`
          : `no había sesión compartida y se creó una nueva, sin contexto previo: ${ensure.detail}`,
        occurredAt: new Date().toISOString(),
        fellBack: false,
      }, ensure.sessionId);
      if (signal.aborted) return { ok: false, cancelled: true };
      // Una TUI recién nacida no es "la misma que antes": el PID viejo ya no significa nada.
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

  private quarantineDeadline(): number {
    return Date.now() + this.quarantineOperationTimeoutMs();
  }

  private quarantineOperationTimeoutMs(): number {
    return Math.max(
      1,
      this.options.quarantineOperationTimeoutMs ?? QUARANTINE_OPERATION_TIMEOUT_MS,
    );
  }

  private tmuxControl(signal?: AbortSignal): {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  } {
    return {
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.quarantineOperationTimeoutMs(),
    };
  }

  private tmuxControlUntil(deadline: number): { readonly timeoutMs: number } {
    return { timeoutMs: Math.max(1, deadline - Date.now()) };
  }

  private quarantinePersistence(): QuarantinePersistence {
    return this.options.quarantinePersistence ?? fileQuarantinePersistence;
  }

  /**
   * Recupera el único crash seguro: el sobre terminal exacto ya quedó durable, pero el proceso murió
   * antes de retirar `quarantine-pending`.
   *
   * El nombre del sidecar porta el nonce de correlación y su contenido porta la generación. Sólo
   * ambas coincidencias más un sobre contractual válido permiten limpiar. Un sobre de otro turno,
   * un JSON con forma parecida, una lectura incompleta o un timeout conservan la cuarentena.
   */
  private async reconcileTerminalPending(identity: PaneIdentity): Promise<void> {
    const quarantineFile = this.options.quarantineFile;
    const findEnvelope = this.options.transcript.findEnvelope?.bind(this.options.transcript);
    if (quarantineFile === undefined || findEnvelope === undefined) return;

    const listed = await beforeDeadline(
      readdir(dirname(quarantineFile)),
      this.quarantineDeadline(),
    );
    if (!listed.completed || listed.value === undefined) return;
    const prefix = `${basename(quarantineFile)}.`;
    const suffix = ".pending";
    const candidates = listed.value.flatMap((name) => {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) return [];
      const correlationId = name.slice(prefix.length, -suffix.length);
      return /^[a-f0-9]{64}$/u.test(correlationId)
        ? [{ correlationId, file: join(dirname(quarantineFile), name) }]
        : [];
    });
    if (candidates.length === 0) return;

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
      if (cleared.completed && cleared.value === true) clearedCurrent = true;
    }
    if (!clearedCurrent) return;

    // Un sidecar actual, temporal o ilegible que siga presente significa que no todos los commits
    // de esta generación tienen límite terminal. `inspect` agrega precisamente esas fuentes.
    const afterPending = await beforeDeadline(
      this.quarantinePersistence().inspect(quarantineFile, identity),
      this.quarantineDeadline(),
    );
    if (!afterPending.completed || afterPending.value === "unreadable") return;
    if (afterPending.value === "current") {
      // La marca canónica se promovió desde el pending que acabamos de correlacionar. Se retira y se
      // vuelve a inspeccionar antes de tocar tmux; un sidecar concurrente impide continuar.
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
    await clearCurrentPaneQuarantine(this.options.tmux, identity, this.tmuxControl());
  }

  private async hasValidTerminalEnvelope(
    correlationId: string,
    findEnvelope: NonNullable<TranscriptReader<E>["findEnvelope"]>,
  ): Promise<boolean> {
    const filesRead = await beforeDeadline(
      this.options.transcript.files(),
      this.quarantineDeadline(),
    );
    if (!filesRead.completed || filesRead.value === undefined) return false;
    // Los transcript/rollout más recientes ordenan al final. Encontrar primero el activo evita
    // releer años de historial durante una recuperación excepcional.
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
   * Arma la barrera durable ANTES del paste. Con fichero configurado, disco es obligatorio;
   * sin fichero (tests/desarrollo), la opción de sesión tmux es la barrera persistente.
   */
  private async armPendingQuarantine(
    identity: PaneIdentity,
    correlationId: string,
  ): Promise<{ readonly ok: true; readonly pending: PendingQuarantine } | { readonly ok: false }> {
    const file = this.options.quarantineFile === undefined
      ? undefined
      : pendingQuarantinePath(this.options.quarantineFile, correlationId);
    if (file !== undefined) {
      const persistence = this.quarantinePersistence();
      // La escritura potencialmente lenta nunca apunta al nombre activo. Sólo deja una preparación
      // con token de intento; un timeout, crash o wrapper que ignore cancelación puede completarla
      // tarde, pero esa fase no significa que el pane haya recibido input y no bloquea un restart.
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
        // El path lleva el token de ESTE intento. La compensación espera causalmente su operación:
        // si termina tarde, borra sólo esa preparación y jamás un pending ajeno o ya comprometido.
        void persistOperation.catch(() => false)
          .then(() => persistence.clear(preparation))
          .catch(() => false);
        return { ok: false };
      }
      // Este link/rename lógico es el único commit pre-paste. No se envuelve en `beforeDeadline`:
      // abandonar una publicación atómica vuelve a crear exactamente la carrera que se corrige.
      // `commitPrepared` hace no-clobber; false conserva cualquier marcador de otro intento.
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
      // Redundancia best-effort. El sidecar ya hace seguro un timeout de tmux.
      await markPaneQuarantined(this.options.tmux, identity, this.tmuxControl());
      return { ok: true, pending: { identity, file, correlationId } };
    }
    const marked = await markPaneQuarantined(this.options.tmux, identity, this.tmuxControl());
    return marked
      ? { ok: true, pending: { identity, correlationId } }
      : { ok: false };
  }

  /** Sólo se llama tras no-paste acreditado o un límite terminal correlacionado/de generación. */
  private async disarmPendingQuarantine(pending: PendingQuarantine): Promise<void> {
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

  private async quarantineState(
    identity: PaneIdentity,
  ): Promise<"current" | "stale" | "absent" | "unreadable"> {
    if (this.locallyQuarantined !== undefined
      && samePaneIdentity(this.locallyQuarantined, identity)) return "current";
    // Las dos fuentes se observan con plazo. En particular, leer tmux primero convertía un socket
    // colgado en un deadlock antes de alcanzar el quarantine-pending que ya estaba durable en
    // disco. Un timeout es "unreadable", nunca ausencia.
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

  private async clearStaleQuarantine(
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
    // La marca de disco obsoleta se conserva: no bloquea otra generación y la próxima cuarentena
    // la reemplaza atómicamente. No borrarla evita una carrera compare/unlink entre dos procesos.
  }

  private async quarantine(
    identity: PaneIdentity,
    pending: PendingQuarantine,
    forceTerminate: boolean = false,
  ): Promise<string> {
    this.locallyQuarantined = identity;
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
    // Si ninguna de las dos marcas pudo persistir, destruir ESTA generación exacta es el único
    // estado que también sigue siendo seguro después de reiniciar el adaptador.
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
   * Un prompt ya pudo quedar pegado o ejecutado: jamás cae al transporte alternativo.
   * La generación se bloquea durablemente (o se termina exactamente) y el resultado conserva
   * `harnessStarted: undefined`, que obliga al motor a tratarlo como ambiguo.
   */
  private async ambiguousCommittedState(
    identity: PaneIdentity,
    detail: string,
    cancelled: boolean,
    pending: PendingQuarantine,
    forceTerminate: boolean = false,
  ): Promise<CommandRunResult> {
    const quarantineDetail = await this.quarantine(identity, pending, forceTerminate);
    return result({
      ...(cancelled ? { cancelled: true } : { exitCode: 1 }),
      stderr: `${detail}; el estado de ejecución es ambiguo; ${quarantineDetail}`,
    });
  }

  /**
   * La adquisicion incierta ocurre ANTES de paste: no existe todavia ningun turno que justificaría
   * matar la TUI. El token propuesto tampoco acredita ownership, por lo que intentar `release`
   * podria habilitar o alterar una barrera ajena. Se conserva el pending ya durable y no se hace
   * ninguna mutacion compensatoria sobre el proceso humano.
   */
  private ambiguousBarrierAcquisitionState(
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

  /** Detecta cambios en el PID del proceso de la TUI entre turnos. */
  private async notePaneIdentity(pid: string | undefined): Promise<void> {
    if (pid === undefined) return;
    if (this.lastPanePid !== undefined && this.lastPanePid !== pid) {
      await this.note({
        reason: "context_reset",
        detail: `el panel pasó del proceso ${this.lastPanePid} al ${pid}`,
        occurredAt: new Date().toISOString(),
        fellBack: false,
      });
      // La conversación de la TUI nueva no tiene nada que ver con la anterior: comparar su
      // identidad con la de antes daría un vaciado que nadie hizo.
      this.lastSessionId = undefined;
    }
    this.lastPanePid = pid;
  }

  /**
   * Espera a que la caja de entrada esté libre antes de interactuar.
   */
  private async acquireInputBox(
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
    let evidence = "la caja de entrada nunca quedó libre";
    let modal = false;
    for (;;) {
      if (signal.aborted) return { ok: false, cancelled: true };
      const pane = await capturePane(this.options.tmux, target, {
        styled: true,
        control: this.tmuxControl(signal),
      });
      if (signal.aborted) return { ok: false, cancelled: true };
      if (pane === undefined
        || !await paneIdentityStillCurrent(this.options.tmux, identity, this.tmuxControl(signal))) {
        if (signal.aborted) return { ok: false, cancelled: true };
        return { ok: false, replaced: true };
      }
      if (signal.aborted) return { ok: false, cancelled: true };
      const state = inputBoxState(pane);
      // El panel con el que se decidió pegar es el que hay que mirar para saber si el turno se
      // fundió: capturarlo otra vez después ya sería otro instante.
      if (!state.occupied) return { ok: true, pane };
      evidence = state.evidence;
      modal = state.kind === "modal";
      if (Date.now() >= deadline) {
        return modal
          ? { ok: false, reason: "modal_blocking", detail: evidence }
          : { ok: false, reason: "input_busy", detail: evidence };
      }
      await this.options.sleep(this.options.pollMs ?? DEFAULT_POLL_MS);
      if (signal.aborted) return { ok: false, cancelled: true };
    }
  }

  /** Foto del registro ANTES de inyectar: lo único que acota qué pudo cambiar durante el turno. */
  private async baseline(signal: AbortSignal): Promise<ReadonlyMap<string, number> | undefined> {
    const sizes = new Map<string, number>();
    if (signal.aborted) return undefined;
    const files = await this.options.transcript.files();
    if (signal.aborted) return undefined;
    for (const file of files) {
      const size = await fileSize(file);
      if (signal.aborted) return undefined;
      if (size >= 0) sizes.set(file, size);
    }
    return sizes;
  }

  /**
   * Saca el sobre del registro estructurado del harness.
   */
  private async harvest(
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
    // Última vez que el registro creció. Es lo que separa "el pegado se perdió" (nada escribe nunca)
    // de "el pegado se fundió con el turno en curso" (la terminal escribe todo el tiempo). Ver
    // `DEFAULT_QUIET_MS`.
    let lastActivityAt = Date.now();
    // El registro de una conversación larga pesa megabytes y un turno puede durar una hora.
    // Releerlo entero en cada sondeo costaría más que el propio turno, así que sólo se lee cuando
    // el fichero creció; y la sesión tmux se comprueba cada tantos sondeos, no en todos.
    let lastSize = -1;
    let probe = 0;
    // El timestamp lo fija el EVENTO, no el siguiente sondeo. Así una lectura de transcript lenta
    // no puede empezar a contar el plazo recién cuando termina.
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
        if (cancelObservedAt !== undefined) continue;
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
        // Un rename no reemplaza la conversación ni el proceso. El siguiente preflight volverá a
        // exigir los nombres canónicos antes de inyectar un turno nuevo.
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
        // Si el pegado se fusionó con un turno en curso, recupera el sobre escrito con posterioridad al pegado.
        if (injected === undefined && scan.envelope !== undefined) {
          const harvested = await beforeAbort(
            () => this.harvested(scan.envelope!, undefined, generating),
            request.signal,
          );
          if (harvested.aborted) continue;
          return { result: harvested.value, terminalBoundary: true };
        }
      }
      let injectedGrew = false;
      if (injected !== undefined) {
        const grew = await beforeAbort(
          () => this.grew(injected!.file, lastSize),
          request.signal,
        );
        if (grew.aborted) continue;
        injectedGrew = grew.value;
      }
      if (injected !== undefined && injectedGrew) {
        const measured = await beforeAbort(() => fileSize(injected!.file), request.signal);
        if (measured.aborted) continue;
        lastSize = measured.value;
        lastActivityAt = Date.now();
        const read = await beforeAbort(
          () => port.read(injected!.file, baseline.get(injected!.file) ?? 0),
          request.signal,
        );
        if (read.aborted) continue;
        const slice = read.value;
        const noted = await beforeAbort(
          () => this.noteCompactions(slice.appended),
          request.signal,
        );
        if (noted.aborted) continue;
        const outcome = port.findAnswer(slice.entries, injected.key);
        if (request.signal.aborted) continue;
        if (outcome?.kind === "failed") {
          // El turno SÍ entró en la terminal y terminó mal. No se reintenta por el camino de
          // siempre: pudo haber corrido herramientas antes de romperse.
          return {
            result: result({ exitCode: 1, stderr: outcome.detail }),
            terminalBoundary: true,
          };
        }
        if (outcome !== undefined) {
          return {
            result: result({
              exitCode: 0,
              stdout: port.stdout(outcome.text, outcome.sessionId ?? injected.sessionId),
            }),
            terminalBoundary: true,
          };
        }
        // Turno propio localizado y ascendencia que no llega: el otro modo de retener el lock hasta
        // el presupuesto entero esperando un sobre que ya está escrito. Se acota a partir de nuestra
        // entrada, así que un sobre anterior al pegado no se puede colar.
        const rescue = port.findEnvelope?.(slice.entries, correlationId, injected.key);
        if (request.signal.aborted) continue;
        if (rescue !== undefined) {
          const harvested = await beforeAbort(
            () => this.harvested(rescue, injected?.sessionId, generating),
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
            `la TUI no registró un turno correlacionado en ${Math.round(injectTimeoutMs / 1000)}`
              + " s después de aceptar paste+Enter",
            pending,
          ),
          terminalBoundary: false,
        };
      }

      // Red de seguridad para los harness que no pueden declarar `startedTurn` (claude): el pegado
      // nunca apareció en el registro. No se degrada —eso lo ejecutaría dos veces— la entrega
      // termina AMBIGUA y la generación queda en cuarentena para que la cola sólo progrese por el
      // transporte aislado o sobre una generación nueva.
      //
      // Se exige ADEMÁS silencio: mientras el registro siga creciendo, lo que hay delante no es un
      // pegado perdido sino un turno en marcha que se lo tragó, y matarlo es tirar trabajo. Con el
      // pegado de verdad perdido no crece nada y esto vence en los mismos 5 min de siempre.
      if (injected === undefined && !started && Date.now() >= correlationDeadline
        && (Date.now() - lastActivityAt >= quietMs || Date.now() >= mergedCeiling)) {
        // Antes de soltarla, el sobre: puede haber aparecido en el mismo sondeo en que se agotó la
        // espera. Si llegó, la entrega no muere.
        const rescued = await beforeAbort(
          () => this.lastEnvelope(baseline, injected, correlationId),
          request.signal,
        );
        if (rescued.aborted) continue;
        if (rescued.value !== undefined) {
          const harvested = await beforeAbort(
            () => this.harvested(rescued.value!, undefined, generating),
            request.signal,
          );
          if (harvested.aborted) continue;
          return { result: harvested.value, terminalBoundary: true };
        }
        return {
          result: await this.quarantineTimedOut(
            activeIdentity,
            "el paste+Enter aceptado no alcanzó un límite correlacionado en el transcript",
            pending,
          ),
          terminalBoundary: false,
        };
      }

      if (Date.now() >= deadline) {
        // Último barrido antes de darla por muerta: si el sobre llegó, la entrega no muere. Esta es
        // la red que faltaba, y es la que convierte el plazo en un techo y no en una guillotina.
        const rescued = await beforeAbort(
          () => this.lastEnvelope(baseline, injected, correlationId),
          request.signal,
        );
        if (rescued.aborted) continue;
        if (rescued.value !== undefined) {
          const harvested = await beforeAbort(
            () => this.harvested(rescued.value!, injected?.sessionId, generating),
            request.signal,
          );
          if (harvested.aborted) continue;
          return { result: harvested.value, terminalBoundary: true };
        }
        // Ya se inyectó: el turno pudo haber corrido herramientas y causado efectos externos.
        // `timedOut` hace que el adaptador lo trate como AMBIGUO y no lo reintente solo.
        return {
          result: await this.quarantineTimedOut(
            activeIdentity,
            "el presupuesto terminó sin desenlace correlacionado del turno ya inyectado",
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
   * Cancela un turno ya comprometido sin liberar la cola sobre una TUI todavía ocupada.
   *
   * Toda espera usa el plazo fijado por el evento abort. Un rename lógico se sigue por
   * session/pane/PID; un respawn no. Si no aparece un límite terminal, la generación se marca en
   * tmux+disco o se mata exactamente, de modo que nunca quede reutilizable a ciegas.
   */
  private async drainCancelledTurn(
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

  /** Sólo un desenlace ligado al prompt/nonce de esta entrega permite reutilizar la generación. */
  private async cancelledTranscriptBoundary(
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

  private async quarantineCancelled(
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

  private async quarantineTimedOut(
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

  private async grew(file: string, lastSize: number): Promise<boolean> {
    return await fileSize(file) > lastSize;
  }

  /**
   * ¿El turno cayó en OTRA conversación que la del turno anterior? Eso es un vaciado.
   *
   * Se comprueba después de inyectar, que es cuando se sabe con certeza dónde quedó el pedido
   * —antes sólo se podría adivinar cuál es el registro "activo"—. No se degrada ni se bloquea:
   * vaciar el contexto es una acción deliberada del dueño y el camino de siempre también arrancaría
   * sin memoria, así que degradar perdería lo único que justifica este diseño (que el turno se vea
   * en el panel) sin ganar nada. Lo que no puede pasar es que el remitente siga creyendo que habla
   * con el mismo hilo.
   */
  private async noteTranscriptIdentity(sessionId: string | undefined): Promise<void> {
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
   * Compactaciones ocurridas DESDE que se pegó el prompt: sólo lo escrito tras la foto previa.
   *
   * Acotarlo a lo nuevo es lo que hace que el aviso signifique algo: un registro de semanas
   * contiene decenas de compactaciones viejas y avisar de ellas sería ruido en cada entrega.
   */
  private async noteCompactions(appended: readonly E[]): Promise<void> {
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
   * Examina los archivos de transcript que crecieron o aparecieron tras el pegado.
   */
  private async locateInjectedTurn(
    baseline: ReadonlyMap<string, number>,
    promptText: string,
    correlationId: string,
  ): Promise<{
    injected?: { file: string; key: string; sessionId?: string };
    started: boolean;
    /** ¿Creció algo desde el pegado? Ver `DEFAULT_QUIET_MS`. */
    activity: boolean;
    /** El sobre escrito después del pegado, cuando no hay turno propio del que descender. */
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
      // Sólo `appended`: lo escrito ANTES del pegado no puede ser la respuesta a este turno.
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
   * El último barrido en busca del sobre, justo antes de dar la entrega por muerta.
   *
   * Existe para que el plazo sea un techo y no una guillotina: una entrega cuyo sobre YA está
   * escrito no puede morir por vencimiento. Es la misma búsqueda que hace el bucle, repetida en el
   * único punto donde el bucle ya no va a volver a mirar.
   */
  private async lastEnvelope(
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
   * Devuelve el sobre cosechado SIN ascendencia, diciendo por qué.
   *
   * El aviso no es decorativo: la respuesta de un turno fundido contesta a la vez lo que pidió el
   * dueño y lo que pidió el bus, y el remitente tiene derecho a saberlo. `fellBack: false` porque el
   * turno SÍ pasó por la terminal —se ejecutó entero en el panel del dueño— y por tanto no hay nada
   * que reejecutar por el camino de siempre.
   */
  private async harvested(
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
    // NO se limpia la caja: el turno se ejecutó, así que la caja ya se vació sola, y un `C-u` a
    // destiempo borraría lo que el dueño esté escribiendo ahora. Este runner nunca usa C-u: ante
    // una duda preserva el input humano y la adquisición siguiente falla cerrado.
    return result({
      exitCode: 0,
      stdout: this.options.transcript.stdout(outcome.text, outcome.sessionId ?? sessionId),
    });
  }

  /**
   * Cae al camino de siempre DICIÉNDOLO, en tres superficies a la vez.
   *
   * El intento anterior murió exactamente acá: su anfitrión registraba
   * `bus_client_connected` -> `client_gone` sin turno, el adaptador respondía por su vía de
   * siempre en 15-18 s, y nada en el resultado revelaba que la sesión compartida no había
   * participado. La degradación silenciosa es indistinguible del éxito, así que no puede existir.
   */
  private async degrade(
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
    if (request.signal.aborted) return result({ cancelled: true, harnessStarted: false });
    return this.options.fallback.run(request);
  }

  /**
   * Acumula avisos dentro del mismo turno sin perder ninguno.
   *
   * Puede haber dos: la TUI se reinició (`context_reset`) y además el turno terminó cayendo al
   * camino de siempre. Quedarse con el último tiraría el primero, así que se concatenan los
   * detalles y manda el que degradó, que es el más grave.
   */
  private record(degradation: SharedSessionDegradation): void {
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
   * Un aviso que NO es una caída: registra y además lo dice en el panel, sin teñirlo de rojo.
   *
   * El dueño es el único que puede compensar una compactación —volviendo a pegar lo importante— y
   * el único que sabe si el vaciado lo hizo él, así que el aviso tiene que llegarle a él y no sólo
   * al remitente de Telegram.
   */
  private async note(
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

interface PendingQuarantine {
  readonly identity: PaneIdentity;
  readonly correlationId: string;
  readonly file?: string;
}

async function fileQuarantineState(
  path: string,
  identity: PaneIdentity,
): Promise<FileQuarantineState> {
  const states: FileQuarantineState[] = [];
  const marker = await readQuarantineMarker(path);
  states.push(marker.state === "present"
    ? (marker.value === paneGenerationKey(identity) ? "current" : "stale")
    : marker.state);
  try {
    const base = basename(path);
    const names = await readdir(dirname(path));
    const pendingNames = names.filter((name) => name.startsWith(`${base}.`)
      && name.endsWith(".pending"));
    // Un temporal de una marca ACTIVA prueba que una escritura durable quedó a mitad. Las únicas
    // excepciones son preparaciones `.arming` con correlation+token exactos: por protocolo el
    // paste no puede empezar hasta que `commitPrepared` publique el nombre `.pending`, así que un
    // crash o una finalización tardía en esa fase es recuperable y no puede bloquear otro turno.
    if (names.some((name) => (name.startsWith(`${base}.`) || name.startsWith(`.${base}.`))
      && name.endsWith(".tmp")
      && !isPendingQuarantinePreparationArtifact(base, name))) states.push("unreadable");
    for (const name of pendingNames) {
      const pending = await readQuarantineMarker(join(dirname(path), name));
      states.push(pending.state === "present"
        ? (pending.value === paneGenerationKey(identity) ? "current" : "stale")
        : "unreadable");
    }
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") states.push("unreadable");
  }
  if (states.includes("current")) return "current";
  if (states.includes("unreadable")) return "unreadable";
  return states.includes("stale") ? "stale" : "absent";
}

async function readQuarantineMarker(path: string): Promise<
  | { readonly state: "present"; readonly value: string }
  | { readonly state: "absent" | "unreadable" }
> {
  try {
    const value = (await readFile(path, "utf8")).replace(/\r?\n$/u, "");
    return /^\$[0-9]+:@[0-9]+:%[0-9]+:[0-9]+$/u.test(value)
      ? { state: "present", value }
      : { state: "unreadable" };
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? { state: "absent" } : { state: "unreadable" };
  }
}

/** Escritura atómica, privada y sincronizada: nunca guarda texto de la entrega. */
async function persistQuarantineMarker(target: string, identity: PaneIdentity): Promise<boolean> {
  const directory = dirname(target);
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${paneGenerationKey(identity)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function pendingQuarantinePath(path: string, correlationId: string): string {
  return `${path}.${correlationId}.pending`;
}

function pendingQuarantinePreparationPath(pendingPath: string, attemptToken: string): string {
  return `${pendingPath.slice(0, -".pending".length)}.${attemptToken}.arming`;
}

/** Sólo reconoce artefactos que el protocolo garantiza anteriores a cualquier paste. */
function isPendingQuarantinePreparationArtifact(base: string, name: string): boolean {
  const token = "[a-f0-9]{64}";
  if (name.startsWith(`${base}.`) && name.endsWith(".arming")) {
    const body = name.slice(`${base}.`.length, -".arming".length);
    return new RegExp(`^${token}\\.${token}$`, "u").test(body);
  }
  if (!name.startsWith(`.${base}.`) || !name.endsWith(".tmp")) return false;
  const body = name.slice(`.${base}.`.length, -".tmp".length);
  return new RegExp(`^${token}\\.${token}\\.arming\\.[0-9]+\\.[a-f0-9]{16}$`, "u")
    .test(body);
}

/**
 * Publica una preparación ya durable sin reemplazar otro intento.
 *
 * `link` es el CAS de nombre que falta en `rename`: EEXIST conserva byte a byte el destino ajeno.
 * El hard-link se sincroniza antes de retirar la fase arming. Si el proceso cae antes del link sólo
 * queda una preparación ignorable; después del link queda un pending conservador y recuperable.
 */
async function commitPreparedQuarantineMarker(
  preparedPath: string,
  pendingPath: string,
  identity: PaneIdentity,
): Promise<boolean> {
  if (dirname(preparedPath) !== dirname(pendingPath)) return false;
  const expected = paneGenerationKey(identity);
  const prepared = await readQuarantineMarker(preparedPath);
  if (prepared.state !== "present" || prepared.value !== expected) return false;
  let linked = false;
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await link(preparedPath, pendingPath);
    linked = true;
    const published = await readQuarantineMarker(pendingPath);
    if (published.state !== "present" || published.value !== expected) throw new Error("bad link");
    directoryHandle = await open(dirname(pendingPath), "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;
    // El pending ya es durable. Fallar al retirar el nombre arming no revierte el commit: esa fase
    // se ignora por contrato y ambos nombres apuntan al mismo inode privado.
    await unlink(preparedPath).catch(() => undefined);
    return true;
  } catch {
    // Sólo se compensa el destino si ESTE link lo creó. EEXIST u otro rechazo jamás borra la marca
    // que ya estaba en `pendingPath`.
    if (linked) await clearPendingQuarantineFile(pendingPath);
    return false;
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

async function clearPendingQuarantineFile(path: string): Promise<boolean> {
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await unlink(path);
    directoryHandle = await open(dirname(path), "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;
    return true;
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT";
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

/** Implementación de producción: escritura atómica+fsync y lectura fail-closed. */
export const fileQuarantinePersistence: QuarantinePersistence = {
  inspect: fileQuarantineState,
  persist: persistQuarantineMarker,
  commitPrepared: commitPreparedQuarantineMarker,
  clear: clearPendingQuarantineFile,
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : undefined;
}

async function beforeAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<{ readonly aborted: true } | { readonly aborted: false; readonly value: T }> {
  if (signal.aborted) return { aborted: true };
  return new Promise((resolveBeforeAbort, rejectBeforeAbort) => {
    let settled = false;
    const aborted = (): void => {
      if (settled) return;
      settled = true;
      resolveBeforeAbort({ aborted: true });
    };
    signal.addEventListener("abort", aborted, { once: true });
    void operation().then((value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      resolveBeforeAbort({ aborted: false, value });
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      rejectBeforeAbort(error);
    });
  });
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<{ readonly completed: boolean; readonly value?: T }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void operation.catch(() => undefined);
    return { completed: false };
  }
  return new Promise((resolveBeforeDeadline) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveBeforeDeadline({ completed: false });
    }, remaining);
    void operation.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveBeforeDeadline({ completed: true, value });
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveBeforeDeadline({ completed: true });
    });
  });
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return -1;
  }
}

function result(overrides: Partial<CommandRunResult>): CommandRunResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    ...overrides,
  };
}

function postEnterCancelled(detail?: string): CommandRunResult {
  return result({
    cancelled: true,
    ...(detail === undefined ? {} : { stderr: detail }),
  });
}

function replacedBeforeSubmission(): CommandRunResult {
  return result({
    exitCode: 1,
    harnessStarted: false,
    stderr: "la sesión tmux acreditada fue reemplazada antes de Enter;"
      + " la entrega no se ejecutó y el reemplazo quedó intacto",
  });
}
