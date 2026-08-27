import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  fileSize,
  QUARANTINE_OPERATION_TIMEOUT_MS,
  result,
} from "./runtime.js";

export abstract class PasteSessionRunnerBase<E> {
  protected pending: SharedSessionDegradation | undefined;
  /** PID del panel en el turno anterior, para detectar que la TUI se reinició sola. */
  protected lastPanePid: string | undefined;
  /** Identificador de la sesión de conversación anterior para detectar reinicios o vaciados de contexto. */
  protected lastSessionId: string | undefined;
  /** Compactaciones ya avisadas, para no repetir el aviso en cada sondeo del mismo turno. */
  protected readonly reportedBoundaries = new Set<string>();
  /** `$N` acreditado para esta llamada; los avisos tampoco pueden caer en un reemplazo por nombre. */
  protected exactSessionId: string | undefined;
  /** Respaldo en memoria si tmux no pudo persistir la marca de cuarentena. */
  protected locallyQuarantined: PaneIdentity | undefined;

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
   * Recupera el único crash seguro: el sobre terminal exacto ya quedó durable, pero el proceso murió
   * antes de retirar `quarantine-pending`.
   *
   * El nombre del sidecar porta el nonce de correlación y su contenido porta la generación. Sólo
   * ambas coincidencias más un sobre contractual válido permiten limpiar. Un sobre de otro turno,
   * un JSON con forma parecida, una lectura incompleta o un timeout conservan la cuarentena.
   */
  protected async reconcileTerminalPending(identity: PaneIdentity): Promise<void> {
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

  protected async hasValidTerminalEnvelope(
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
  protected async armPendingQuarantine(
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
  protected async disarmPendingQuarantine(pending: PendingQuarantine): Promise<void> {
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
    // La marca de disco obsoleta se conserva: no bloquea otra generación y la próxima cuarentena
    // la reemplaza atómicamente. No borrarla evita una carrera compare/unlink entre dos procesos.
  }

  protected async quarantine(
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
  protected async ambiguousCommittedState(
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

  /** Detecta cambios en el PID del proceso de la TUI entre turnos. */
  protected async notePaneIdentity(pid: string | undefined): Promise<void> {
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
  protected async baseline(signal: AbortSignal): Promise<ReadonlyMap<string, number> | undefined> {
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
   * ¿El turno cayó en OTRA conversación que la del turno anterior? Eso es un vaciado.
   *
   * Se comprueba después de inyectar, que es cuando se sabe con certeza dónde quedó el pedido
   * —antes sólo se podría adivinar cuál es el registro "activo"—. No se degrada ni se bloquea:
   * vaciar el contexto es una acción deliberada del dueño y el camino de siempre también arrancaría
   * sin memoria, así que degradar perdería lo único que justifica este diseño (que el turno se vea
   * en el panel) sin ganar nada. Lo que no puede pasar es que el remitente siga creyendo que habla
   * con el mismo hilo.
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
   * Compactaciones ocurridas DESDE que se pegó el prompt: sólo lo escrito tras la foto previa.
   *
   * Acotarlo a lo nuevo es lo que hace que el aviso signifique algo: un registro de semanas
   * contiene decenas de compactaciones viejas y avisar de ellas sería ruido en cada entrega.
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
   * Examina los archivos de transcript que crecieron o aparecieron tras el pegado.
   */
  protected async locateInjectedTurn(
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
   * Devuelve el sobre cosechado SIN ascendencia, diciendo por qué.
   *
   * El aviso no es decorativo: la respuesta de un turno fundido contesta a la vez lo que pidió el
   * dueño y lo que pidió el bus, y el remitente tiene derecho a saberlo. `fellBack: false` porque el
   * turno SÍ pasó por la terminal —se ejecutó entero en el panel del dueño— y por tanto no hay nada
   * que reejecutar por el camino de siempre.
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
   * Un aviso que NO es una caída: registra y además lo dice en el panel, sin teñirlo de rojo.
   *
   * El dueño es el único que puede compensar una compactación —volviendo a pegar lo importante— y
   * el único que sabe si el vaciado lo hizo él, así que el aviso tiene que llegarle a él y no sólo
   * al remitente de Telegram.
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
