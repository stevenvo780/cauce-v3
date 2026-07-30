import { stat } from "node:fs/promises";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../sdk/types.js";
import {
  announceDegradation,
  capturePane,
  clearDegradation,
  hasSession,
  pastePrompt,
  sendEnter,
  type TmuxController,
} from "./tmux.js";
import { inputBoxState } from "./pane.js";
import {
  ensureSharedSession,
  transcriptDirectory,
  tuiTarget,
  type EnsureOptions,
} from "./session.js";
import {
  findFinalAssistant,
  findInjectedTurn,
  readTranscript,
  stripJsonFence,
  transcriptBaseline,
  transcriptFiles,
  type TranscriptFileBaseline,
} from "./transcript.js";
import { TUI_WINDOW, sessionName } from "./types.js";
import type { SharedSessionDegradation, SharedSessionRunner } from "./types.js";

export interface ClaudeSharedSessionOptions {
  readonly alias: string;
  /** Directorio de trabajo de la TUI; determina también dónde están los transcripts. */
  readonly workspace: string;
  /** HOME del usuario del contenedor, para resolver `~/.claude/projects`. */
  readonly home: string;
  readonly tmux: TmuxController;
  /**
   * El camino de siempre (`claude --print --output-format json …`).
   *
   * Se conserva porque una entrega no se puede perder por una terminal cerrada, pero SÓLO se usa
   * anunciándolo: es el punto exacto donde murió el intento anterior, que caía acá en silencio.
   */
  readonly fallback: CommandRunner;
  readonly sleep: (ms: number) => Promise<void>;
  /** Cuánto se espera a que el dueño suelte la caja de entrada antes de degradar. */
  readonly acquireTimeoutMs?: number;
  /** Techo de un turno ya inyectado. Pasado esto es AMBIGUO, nunca un reintento. */
  readonly turnTimeoutMs?: number;
  readonly pollMs?: number;
  readonly readyTimeoutMs?: number;
  readonly command?: string;
  readonly onDegradation?: (degradation: SharedSessionDegradation) => void;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;
const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
const DEFAULT_POLL_MS = 750;

/**
 * Cada cuántos sondeos se comprueba que la sesión tmux sigue viva.
 *
 * Comprobarlo en todos costaba un proceso `tmux` cada 750 ms —unos 4800 por hora de turno— para
 * detectar un suceso rarísimo. Cada 8 sondeos da un aviso en menos de 10 s, que es de sobra.
 */
const LIVENESS_EVERY = 8;

/**
 * Salida (d): conducir la TUI real por tmux y cosechar el sobre del transcript.
 *
 * Las tres propiedades que el dueño pidió, a la vez:
 *  - TUI de verdad, con su panel, sus `/comandos` y su historial: es el binario real corriendo en
 *    un panel tmux, no un cliente de línea que la imita.
 *  - el turno del bus se ve EN VIVO en ese panel, porque entra por la misma caja de entrada.
 *  - contexto compartido en las dos direcciones y en UNA sola rama, porque el turno cuelga de la
 *    cabeza de la propia TUI.
 *
 * Lo que se paga: el acoplamiento es por teclas, que no es una API estable, y hay UNA sola caja de
 * entrada, así que hace falta arbitrarla.
 *
 * Este runner sustituye al transporte, no al contrato: devuelve un `CommandRunResult` con la misma
 * forma que produce `claude --print --output-format json`, y lo valida después el mismo
 * `parseClaudeOutput` + `validateDeliveryOutput` de siempre. El sobre se sigue exigiendo entero.
 */
export class ClaudeSharedSessionRunner implements SharedSessionRunner {
  private pending: SharedSessionDegradation | undefined;
  /** PID del panel en el turno anterior, para detectar que la TUI se reinició sola. */
  private lastPanePid: string | undefined;

  constructor(private readonly options: ClaudeSharedSessionOptions) {}

  takeDegradation(): SharedSessionDegradation | undefined {
    const degradation = this.pending;
    this.pending = undefined;
    return degradation;
  }

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.pending = undefined;
    const target = tuiTarget(this.options.alias);
    const session = sessionName(this.options.alias);

    const ready = await this.preflight();
    if (!ready.ok) return this.degrade(ready.reason, ready.detail, request);

    // El pegado y el Enter tienen que ser una operación sola respecto del dueño: entre que se
    // comprueba que la caja está libre y que se envía, no puede haber más esperas de las
    // imprescindibles.
    const acquired = await this.acquireInputBox(target);
    if (!acquired.ok) return this.degrade("input_busy", acquired.detail, request);

    const directory = transcriptDirectory(this.options.home, this.options.workspace);
    const baseline = await transcriptBaseline(directory);

    const buffer = `cauce-${this.options.alias}`;
    if (!await pastePrompt(this.options.tmux, target, buffer, request.stdin)) {
      return this.degrade("handshake_failed", "tmux no aceptó el pegado del prompt", request);
    }
    if (!await sendEnter(this.options.tmux, target)) {
      // El texto quedó en la caja sin enviarse. Se limpia antes de degradar para no dejarle al
      // dueño el prompt de protocolo escrito en su terminal.
      await this.options.tmux.run(["send-keys", "-t", target, "C-u"]).catch(() => undefined);
      return this.degrade("handshake_failed", "tmux no aceptó el envío del prompt", request);
    }

    // A partir de acá el turno está EN MARCHA dentro de la TUI. No se degrada nunca más en este
    // turno: reejecutar por el camino de siempre lo correría dos veces, con sus efectos externos
    // aplicados dos veces. Un fallo desde este punto es ambiguo y se dice como tal.
    await clearDegradation(this.options.tmux, session, TUI_WINDOW);
    return this.harvest(request, directory, baseline, session);
  }

  private async preflight(): Promise<
    { ok: true } | { ok: false; reason: "session_absent" | "tui_absent"; detail: string }
  > {
    const ensure = await ensureSharedSession(
      this.options.tmux,
      {
        alias: this.options.alias,
        harness: "claude",
        workspace: this.options.workspace,
        ...(this.options.command === undefined ? {} : { command: this.options.command }),
      },
      this.ensureOptions(),
    );
    if (!ensure.ready) {
      return { ok: false, reason: ensure.failure ?? "session_absent", detail: ensure.detail };
    }
    this.notePaneIdentity(ensure.pid);
    return { ok: true };
  }

  private ensureOptions(): EnsureOptions {
    return {
      sleep: this.options.sleep,
      ...(this.options.readyTimeoutMs === undefined
        ? {}
        : { readyTimeoutMs: this.options.readyTimeoutMs }),
    };
  }

  /**
   * Detecta que la TUI no es la misma que atendió el turno anterior.
   *
   * Sin esto, un reinicio de la TUI —medido: `claude` se auto-actualiza y se relanza— deja al bus
   * hablando con una conversación vacía mientras todo parece normal. Se avisa y NO se degrada: el
   * turno sí pasa por la terminal, lo que se perdió es la memoria.
   */
  private notePaneIdentity(pid: string | undefined): void {
    if (pid === undefined) return;
    if (this.lastPanePid !== undefined && this.lastPanePid !== pid) {
      this.record({
        reason: "context_reset",
        detail: `el panel pasó del proceso ${this.lastPanePid} al ${pid}`,
        occurredAt: new Date().toISOString(),
        fellBack: false,
      });
    }
    this.lastPanePid = pid;
  }

  /**
   * Espera a que el dueño suelte la caja de entrada.
   *
   * Esperar es lo correcto y no un parche: una línea a medio escribir se resuelve sola en
   * segundos, y degradar de inmediato regalaría el contexto compartido por una pausa de tecleo.
   * Lo que no se hace nunca es escribir encima.
   */
  private async acquireInputBox(target: string): Promise<{ ok: true } | { ok: false; detail: string }> {
    const deadline = Date.now() + (this.options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
    let evidence = "la caja de entrada nunca quedó libre";
    for (;;) {
      const state = inputBoxState(await capturePane(this.options.tmux, target));
      if (!state.occupied) return { ok: true };
      evidence = state.evidence;
      if (Date.now() >= deadline) return { ok: false, detail: evidence };
      await this.options.sleep(this.options.pollMs ?? DEFAULT_POLL_MS);
    }
  }

  /**
   * Saca el sobre del transcript, nunca de la pantalla.
   *
   * Dos fases: primero identificar en qué fichero y con qué uuid quedó registrado el prompt que
   * acabamos de pegar (igualdad exacta), y después esperar la respuesta final que DESCIENDE de esa
   * entrada. La segunda condición es la que garantiza que no estamos cosechando la respuesta a
   * algo que el dueño escribió en paralelo.
   */
  private async harvest(
    request: CommandRunRequest,
    directory: string,
    baseline: readonly TranscriptFileBaseline[],
    session: string,
  ): Promise<CommandRunResult> {
    const budget = Math.min(
      request.timeoutMs,
      this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    );
    const deadline = Date.now() + budget;
    let injected: { file: string; uuid: string; sessionId?: string } | undefined;
    // El transcript de una conversación larga pesa megabytes y un turno puede durar una hora.
    // Releerlo entero en cada sondeo costaría más que el propio turno, así que sólo se parsea
    // cuando el fichero creció; y la sesión tmux se comprueba cada tantos sondeos, no en todos.
    let lastSize = -1;
    let probe = 0;

    for (;;) {
      if (request.signal.aborted) {
        return result({ cancelled: true });
      }
      if (probe % LIVENESS_EVERY === 0 && !await hasSession(this.options.tmux, session)) {
        return result({
          exitCode: 1,
          stderr: "la sesión compartida desapareció mientras el turno estaba en marcha;"
            + " el estado de finalización es desconocido",
        });
      }
      probe += 1;

      if (injected === undefined) {
        injected = await this.locateInjectedTurn(directory, baseline, request.stdin);
      }
      if (injected !== undefined && await this.grew(injected.file, lastSize)) {
        lastSize = await fileSize(injected.file);
        const entries = await readTranscript(injected.file);
        const answer = findFinalAssistant(entries, injected.uuid);
        if (answer !== undefined) {
          const sessionId = answer.sessionId ?? injected.sessionId;
          return result({
            exitCode: 0,
            stdout: JSON.stringify({
              type: "result",
              subtype: "success",
              is_error: false,
              result: stripJsonFence(answer.text),
              ...(sessionId === undefined ? {} : { session_id: sessionId }),
            }),
          });
        }
      }

      if (Date.now() >= deadline) {
        // Ya se inyectó: el turno pudo haber corrido herramientas y causado efectos externos.
        // `timedOut` hace que el adaptador lo trate como AMBIGUO y no lo reintente solo.
        return result({ timedOut: true });
      }
      await this.options.sleep(this.options.pollMs ?? DEFAULT_POLL_MS);
    }
  }

  private async grew(file: string, lastSize: number): Promise<boolean> {
    return await fileSize(file) > lastSize;
  }

  /**
   * Sólo mira los ficheros que crecieron o que aparecieron después del pegado.
   *
   * Un directorio de proyecto acumula decenas de conversaciones; releerlas todas en cada sondeo
   * costaría más que el turno. La foto previa acota el trabajo a lo que pudo haber cambiado.
   */
  private async locateInjectedTurn(
    directory: string,
    baseline: readonly TranscriptFileBaseline[],
    promptText: string,
  ): Promise<{ file: string; uuid: string; sessionId?: string } | undefined> {
    const sizes = new Map(baseline.map((entry) => [entry.file, entry.size]));
    for (const file of await transcriptFiles(directory)) {
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        continue;
      }
      if (size <= (sizes.get(file) ?? -1)) continue;
      const found = findInjectedTurn(await readTranscript(file), promptText);
      if (found !== undefined) {
        return found.sessionId === undefined
          ? { file, uuid: found.uuid }
          : { file, uuid: found.uuid, sessionId: found.sessionId };
      }
    }
    return undefined;
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
    reason: "session_absent" | "tui_absent" | "input_busy" | "handshake_failed",
    detail: string,
    request: CommandRunRequest,
  ): Promise<CommandRunResult> {
    const degradation: SharedSessionDegradation = {
      reason,
      detail,
      occurredAt: new Date().toISOString(),
      fellBack: true,
    };
    this.record(degradation);
    await announceDegradation(
      this.options.tmux,
      sessionName(this.options.alias),
      TUI_WINDOW,
      `CAUCE: un turno del bus NO pasó por esta terminal (${reason}: ${detail})`,
    );
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
