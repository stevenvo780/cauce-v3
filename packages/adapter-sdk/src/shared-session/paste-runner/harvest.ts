import type { CommandRunRequest, CommandRunResult } from "../../sdk/types.js";
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
   * Saca el sobre del registro estructurado del harness.
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

  /** Sólo un desenlace ligado al prompt/nonce de esta entrega permite reutilizar la generación. */
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
