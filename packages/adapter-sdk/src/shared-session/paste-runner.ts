import { stat } from "node:fs/promises";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../sdk/types.js";
import {
  announceDegradation,
  announceNotice,
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
  tuiTarget,
  type EnsureOptions,
} from "./session.js";
import { TUI_WINDOW, sessionName } from "./types.js";
import type {
  ResumeSpec,
  SharedSessionDegradation,
  SharedSessionHarness,
  SharedSessionRunner,
  TranscriptReader,
} from "./types.js";

export interface PasteSessionOptions<E> {
  readonly alias: string;
  /** Qué TUI corre en el panel. Determina el binario, no el mecanismo: el mecanismo es uno solo. */
  readonly harness: SharedSessionHarness;
  /** Directorio de trabajo de la TUI. */
  readonly workspace: string;
  /**
   * De dónde sale el sobre. Lo ÚNICO específico de cada harness.
   *
   * Se recibe ya construido —y por tanto ya apuntando a un directorio concreto— para que el sitio
   * donde la TUI escribe y el sitio donde el adaptador lee salgan del mismo valor y no se puedan
   * separar. Ver `claudeTranscript` y `codexTranscript`.
   */
  readonly transcript: TranscriptReader<E>;
  /** Lo que se le fija al panel al crearlo. Ver `SharedSessionSpec.environment`. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly tmux: TmuxController;
  /**
   * El camino de siempre (`claude --print …`, `codex exec --json …`).
   *
   * Se conserva porque una entrega no se puede perder por una terminal cerrada, pero SÓLO se usa
   * anunciándolo: es el punto exacto donde murió el intento anterior, que caía acá en silencio.
   */
  readonly fallback: CommandRunner;
  readonly sleep: (ms: number) => Promise<void>;
  /** Cuánto se espera a que el dueño suelte la caja de entrada antes de degradar. */
  readonly acquireTimeoutMs?: number;
  /**
   * Recorte OPCIONAL del turno ya inyectado, por debajo del presupuesto de la entrega.
   *
   * Sin esto el turno usa `request.timeoutMs`, que es lo que negoció el motor. No tiene default a
   * propósito: un default acá es un techo invisible que contradice al presupuesto declarado, y eso
   * es exactamente lo que mató las entregas de kratos el 2026-08-04 (ver `harvest`).
   * Pasado el plazo el estado es AMBIGUO, nunca un reintento.
   */
  readonly turnTimeoutMs?: number;
  /** Cuánto se espera entre el pegado y el Enter. Ver `SETTLE_MS`. */
  readonly settleMs?: number;
  /** Cuánto se le da a la TUI para registrar el turno pegado. Ver `harvest`. */
  readonly injectTimeoutMs?: number;
  /** Recorte de la espera por correlacionar el pegado. Ver `DEFAULT_CORRELATION_TIMEOUT_MS`. */
  readonly correlationTimeoutMs?: number;
  readonly pollMs?: number;
  readonly readyTimeoutMs?: number;
  readonly command?: string;
  /**
   * Cómo se reanuda la conversación del dueño si hay que rehacerle el panel. Ver `ResumeSpec`.
   *
   * Ausente = el panel resucita EN BLANCO, que es lo que hacía este runner hasta el 2026-08-06.
   */
  readonly resume?: ResumeSpec;
  readonly onDegradation?: (degradation: SharedSessionDegradation) => void;
  /** Dónde se cuenta que una reanudación no salió. Ver `EnsureOptions.log`. */
  readonly onNotice?: (detail: string) => void;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 750;

/**
 * Cuánto dura un turno ya inyectado en la TUI.
 *
 * Es una función exportada y no dos líneas dentro de `harvest` para que la regla se pueda fijar
 * con una prueba: lo que se rompió el 2026-08-04 no fue el cálculo, fue que un default escondido
 * ganaba sobre el presupuesto declarado y nadie tenía dónde verlo.
 *
 * La regla, entera: manda `request.timeoutMs`. Sólo se recorta si alguien pasó `turnTimeoutMs` a
 * propósito, y sólo hacia abajo — un recorte nunca puede AMPLIAR el presupuesto de la entrega.
 */
export function turnBudgetMs(requestTimeoutMs: number, turnTimeoutMs?: number): number {
  return turnTimeoutMs === undefined
    ? requestTimeoutMs
    : Math.min(requestTimeoutMs, turnTimeoutMs);
}

/**
 * Cuánto se deja asentar el pegado antes de mandar el Enter.
 *
 * No es un `sleep` supersticioso: las dos TUI leen el pegado entre corchetes como un bloque y lo
 * insertan en su caja de forma asíncrona; codex además tiene un detector de ráfaga
 * (`tui/src/bottom_pane/paste_burst.rs`, visible en el binario 0.144.6) que agrupa lo que llega
 * junto. Un Enter que entre dentro de esa misma ráfaga puede acabar siendo un salto de línea del
 * texto en vez del envío. Un cuarto de segundo no se nota en un turno y quita esa carrera.
 *
 * Y si aun así no se enviara, `harvest` lo detecta y lo DICE, en vez de esperar el presupuesto
 * entero delante de una caja con el pedido escrito sin mandar.
 */
const SETTLE_MS = 250;

/**
 * Cuánto se espera a que la TUI registre el turno pegado antes de darlo por no entregado.
 *
 * Medido en el rollout de codex el 2026-07-31: entre el envío y la primera línea del turno en
 * disco pasan milisegundos (`task_started` a las 16:45:18.174, respuesta completa a las
 * 16:45:20.107). Treinta segundos es un margen de tres órdenes de magnitud.
 */
const DEFAULT_INJECT_TIMEOUT_MS = 30_000;

/**
 * Cada cuántos sondeos se comprueba que la sesión tmux sigue viva.
 *
 * Comprobarlo en todos costaba un proceso `tmux` cada 750 ms —unos 4800 por hora de turno— para
 * detectar un suceso rarísimo. Cada 8 sondeos da un aviso en menos de 10 s, que es de sobra.
 */
const LIVENESS_EVERY = 8;

/**
 * Cuánto se espera a CORRELACIONAR el pegado antes de soltar la sesión.
 *
 * Distinto del presupuesto del turno: un turno legítimo puede durar horas, pero su entrada aparece
 * en el registro a los pocos segundos de pegarla. Si pasa esto sin que aparezca, el pegado se perdió
 * —se entreveró con lo que estaba tecleando una persona en la misma caja de entrada, o cayó mientras
 * la TUI generaba— y esperar el presupuesto entero no lo va a arreglar.
 *
 * Lo que arregla, medido el 2026-08-04: al quitar el tope escondido de 60 min, el presupuesto de
 * claude pasó a ser el de la entrega (24 h). Como este harness NO declara `startedTurn` a propósito
 * (ver `claudeTranscript`), nunca degradaba tras pegar, así que un pegado perdido retenía el lock de
 * la sesión 24 h: 16 entregas encoladas, cuatro horas sin una sola respuesta, y el reinicio del
 * adaptador no lo soltaba porque la siguiente entrega volvía a trabarse igual.
 *
 * Se sale por `timedOut` (AMBIGUO), no por `degrade`: si el pegado SÍ había entrado y sólo no se
 * supo correlacionar, degradar lo volvería a ejecutar por el camino de respaldo y el turno correría
 * dos veces. Ambiguo suelta el lock, deja constancia y no reintenta solo.
 */
const DEFAULT_CORRELATION_TIMEOUT_MS = 5 * 60_000;

/**
 * Salida (d): conducir la TUI real por tmux y cosechar el sobre del registro que ella escribe.
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
 * forma que produce el harness en su modo de siempre, y lo valida después el mismo `parse` +
 * `validateDeliveryOutput`. El sobre se sigue exigiendo entero.
 *
 * Vale para los dos harness porque el mecanismo es el mismo. Lo único que cambia —dónde queda
 * escrito el turno y cómo se le sigue la pista— entra por `options.transcript`.
 */
export class PasteSessionRunner<E> implements SharedSessionRunner {
  private pending: SharedSessionDegradation | undefined;
  /** PID del panel en el turno anterior, para detectar que la TUI se reinició sola. */
  private lastPanePid: string | undefined;
  /**
   * Identidad de la conversación en la que cayó el turno anterior.
   *
   * Es la ÚNICA señal que delata un vaciado. Medido el 2026-07-30 con claude 2.1.220: `/clear`
   * cierra el `.jsonl` y abre otro con `sessionId` nuevo, sin escribir ninguna marca en el viejo
   * —simplemente deja de crecer— y SIN reiniciar el proceso: `pane_pid` idéntico antes y después.
   * O sea que el heurístico de PID no lo ve nunca, y la cosecha sigue funcionando perfecta: el bus
   * entregaba una respuesta impecable producida por un contexto vacío, con cero señal.
   */
  private lastSessionId: string | undefined;
  /** Compactaciones ya avisadas, para no repetir el aviso en cada sondeo del mismo turno. */
  private readonly reportedBoundaries = new Set<string>();

  constructor(private readonly options: PasteSessionOptions<E>) {}

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
    if (!acquired.ok) return this.degrade(acquired.reason, acquired.detail, request);

    const baseline = await this.baseline();

    const buffer = `cauce-${this.options.alias}`;
    if (!await pastePrompt(this.options.tmux, target, buffer, request.stdin)) {
      return this.degrade("handshake_failed", "tmux no aceptó el pegado del prompt", request);
    }
    await this.options.sleep(this.options.settleMs ?? SETTLE_MS);
    if (!await sendEnter(this.options.tmux, target)) {
      // El texto quedó en la caja sin enviarse. Se limpia antes de degradar para no dejarle al
      // dueño el prompt de protocolo escrito en su terminal.
      await this.clearInputBox(target);
      return this.degrade("handshake_failed", "tmux no aceptó el envío del prompt", request);
    }

    // A partir de acá el turno PUEDE estar en marcha dentro de la TUI. Sólo se degrada si el
    // registro demuestra que no arrancó ninguno; ver `harvest`.
    await clearDegradation(this.options.tmux, session, TUI_WINDOW);
    return this.harvest(request, baseline, session, target);
  }

  private async preflight(): Promise<
    { ok: true } | { ok: false; reason: "session_absent" | "tui_absent"; detail: string }
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
      this.ensureOptions(),
    );
    if (!ensure.ready) {
      return { ok: false, reason: ensure.failure ?? "session_absent", detail: ensure.detail };
    }
    if (ensure.created) {
      // Resurrección: había que crearla, así que el dueño NO tenía ese panel abierto. `ensure` ya
      // lo sabía y el runner lo tiraba: medido el 2026-07-30, borrada la sesión, la entrega salió
      // con `exitCode 0` y sin un solo aviso.
      //
      // Se sigue avisando aunque la conversación haya vuelto entera, porque el panel es NUEVO y el
      // dueño no lo estaba mirando; lo que cambia es qué se le dice. Decir "empieza de cero" cuando
      // el contexto volvió es tan falso como callarse que se perdió.
      await this.note({
        reason: "session_created",
        detail: ensure.resumed === true
          ? `no había sesión compartida: se creó una REANUDANDO la conversación anterior (${ensure.detail})`
          : `no había sesión compartida y se creó una nueva, sin contexto previo: ${ensure.detail}`,
        occurredAt: new Date().toISOString(),
        fellBack: false,
      });
      // Una TUI recién nacida no es "la misma que antes": el PID viejo ya no significa nada.
      this.lastPanePid = ensure.pid;
      this.lastSessionId = undefined;
      return { ok: true };
    }
    await this.notePaneIdentity(ensure.pid);
    return { ok: true };
  }

  private ensureOptions(): EnsureOptions {
    return {
      sleep: this.options.sleep,
      ...(this.options.readyTimeoutMs === undefined
        ? {}
        : { readyTimeoutMs: this.options.readyTimeoutMs }),
      ...(this.options.onNotice === undefined ? {} : { log: this.options.onNotice }),
    };
  }

  /**
   * Detecta que la TUI no es la misma que atendió el turno anterior.
   *
   * Sin esto, un reinicio de la TUI —medido: `claude` se auto-actualiza y se relanza— deja al bus
   * hablando con una conversación vacía mientras todo parece normal. Se avisa y NO se degrada: el
   * turno sí pasa por la terminal, lo que se perdió es la memoria.
   */
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
   * Espera a que el dueño suelte la caja de entrada.
   *
   * Esperar es lo correcto y no un parche: una línea a medio escribir se resuelve sola en
   * segundos, y degradar de inmediato regalaría el contexto compartido por una pausa de tecleo.
   * Lo que no se hace nunca es escribir encima.
   */
  private async acquireInputBox(target: string): Promise<
    { ok: true } | { ok: false; reason: "input_busy" | "modal_blocking"; detail: string }
  > {
    const deadline = Date.now() + (this.options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
    let evidence = "la caja de entrada nunca quedó libre";
    let modal = false;
    for (;;) {
      const state = inputBoxState(await capturePane(this.options.tmux, target, { styled: true }));
      if (!state.occupied) return { ok: true };
      evidence = state.evidence;
      modal = state.kind === "modal";
      if (Date.now() >= deadline) {
        // El diagnóstico correcto importa porque las dos salidas son OPUESTAS: ante `input_busy`
        // el dueño tiene que BORRAR lo que escribió, ante un diálogo tiene que CONTESTARLO. El
        // aviso anterior mandaba a hacer lo primero en los dos casos.
        return modal
          ? { ok: false, reason: "modal_blocking", detail: evidence }
          : { ok: false, reason: "input_busy", detail: evidence };
      }
      await this.options.sleep(this.options.pollMs ?? DEFAULT_POLL_MS);
    }
  }

  /** Foto del registro ANTES de inyectar: lo único que acota qué pudo cambiar durante el turno. */
  private async baseline(): Promise<ReadonlyMap<string, number>> {
    const sizes = new Map<string, number>();
    for (const file of await this.options.transcript.files()) {
      const size = await fileSize(file);
      if (size >= 0) sizes.set(file, size);
    }
    return sizes;
  }

  /**
   * Saca el sobre del registro, nunca de la pantalla.
   *
   * Dos fases: primero identificar dónde quedó registrado el prompt que acabamos de pegar
   * (igualdad exacta), y después esperar el desenlace de ESE turno. La segunda condición es la que
   * garantiza que no estamos cosechando la respuesta a algo que el dueño escribió en paralelo.
   *
   * Y una tercera cosa, que es lo que separa una espera honesta de una espera muda: mientras el
   * turno no aparezca, se mira si arrancó ALGUNO. Si no arrancó ninguno, el pegado no llegó a la
   * caja, no corrió nada, y caer al camino de siempre no puede duplicar ningún efecto: se degrada
   * diciéndolo. Si arrancó alguno y aun así no es el nuestro, la situación es ambigua y se agota
   * el presupuesto, que es exactamente lo que corresponde.
   */
  private async harvest(
    request: CommandRunRequest,
    baseline: ReadonlyMap<string, number>,
    session: string,
    target: string,
  ): Promise<CommandRunResult> {
    const port = this.options.transcript;
    /**
     * El presupuesto del turno es el que negoció el motor, NO una constante de este archivo.
     *
     * Hasta el 2026-08-04 acá había un `Math.min(request.timeoutMs, 3_600_000)`. `turnTimeoutMs`
     * no lo pasaba nadie —ni `bin/shared.ts` ni ningún otro sitio—, así que ese `min` ganaba
     * SIEMPRE y todo turno moría a los 60:00 exactos, contradiciendo en silencio el presupuesto
     * que `executionBudgetFor` había calculado a partir de la entrega (24 h por defecto en
     * `CAUCE_DEFAULT_TIMEOUT_MS`, acotado por la lease del ACK y por el techo de 12 h del store).
     *
     * Qué costó: el 2026-08-04 dos entregas de Miguel a `kratos` ejecutaron 60:00 clavados
     * (23:57:28→00:57:28 y 00:57:30→01:57:28) y murieron. Como el alias sirve una entrega por vez,
     * al morir arrancaba la siguiente, tardaba lo mismo y moría igual: cinco pedidos de un cliente
     * en cola, ninguna respuesta, y ni un solo error visible.
     *
     * No es "sin techo": `request.timeoutMs` YA viene acotado, y el bucle de abajo sigue vigilando
     * `signal.aborted` y la vida de la sesión tmux. Lo que se quita es un límite escondido que
     * nadie podía ver ni configurar. `turnTimeoutMs` queda como recorte EXPLÍCITO para quien lo
     * pase a propósito.
     */
    const budget = turnBudgetMs(request.timeoutMs, this.options.turnTimeoutMs);
    const deadline = Date.now() + budget;
    const injectTimeoutMs = this.options.injectTimeoutMs ?? DEFAULT_INJECT_TIMEOUT_MS;
    const injectDeadline = Date.now() + injectTimeoutMs;
    const correlationDeadline = Date.now()
      + (this.options.correlationTimeoutMs ?? DEFAULT_CORRELATION_TIMEOUT_MS);
    let injected: { file: string; key: string; sessionId?: string } | undefined;
    let started = false;
    // El registro de una conversación larga pesa megabytes y un turno puede durar una hora.
    // Releerlo entero en cada sondeo costaría más que el propio turno, así que sólo se lee cuando
    // el fichero creció; y la sesión tmux se comprueba cada tantos sondeos, no en todos.
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
        const scan = await this.locateInjectedTurn(baseline, request.stdin);
        started = started || scan.started;
        injected = scan.injected;
        if (injected !== undefined) await this.noteTranscriptIdentity(injected.sessionId);
      }
      if (injected !== undefined && await this.grew(injected.file, lastSize)) {
        lastSize = await fileSize(injected.file);
        const slice = await port.read(injected.file, baseline.get(injected.file) ?? 0);
        await this.noteCompactions(slice.appended);
        const outcome = port.findAnswer(slice.entries, injected.key);
        if (outcome?.kind === "failed") {
          // El turno SÍ entró en la terminal y terminó mal. No se reintenta por el camino de
          // siempre: pudo haber corrido herramientas antes de romperse.
          return result({ exitCode: 1, stderr: outcome.detail });
        }
        if (outcome !== undefined) {
          return result({
            exitCode: 0,
            stdout: port.stdout(outcome.text, outcome.sessionId ?? injected.sessionId),
          });
        }
      }

      if (injected === undefined && !started && port.startedTurn !== undefined
        && Date.now() >= injectDeadline) {
        await this.clearInputBox(target);
        return this.degrade(
          "handshake_failed",
          `la TUI no registró ningún turno en ${Math.round(injectTimeoutMs / 1000)} s tras el`
          + " envío: el pedido no llegó a la caja de entrada",
          request,
        );
      }

      // Red de seguridad para los harness que no pueden declarar `startedTurn` (claude): el pegado
      // nunca apareció en el registro. No se degrada —eso lo ejecutaría dos veces— se suelta la
      // sesión como AMBIGUO para que la cola siga corriendo.
      if (injected === undefined && !started && Date.now() >= correlationDeadline) {
        await this.clearInputBox(target);
        return result({
          timedOut: true,
          stderr: "el pegado no apareció en el registro de la terminal;"
            + " el turno se suelta como ambiguo para no retener la sesión",
        });
      }

      if (Date.now() >= deadline) {
        // Ya se inyectó: el turno pudo haber corrido herramientas y causado efectos externos.
        // `timedOut` hace que el adaptador lo trate como AMBIGUO y no lo reintente solo.
        return result({ timedOut: true });
      }
      await this.options.sleep(this.options.pollMs ?? DEFAULT_POLL_MS);
    }
  }

  /**
   * Borra lo que quedó escrito en la caja. Mejor esfuerzo, y nunca falla hacia afuera.
   *
   * Sólo se llama cuando está demostrado que el pedido NO se envió: dejarle al dueño el prompt de
   * protocolo escrito en su terminal es un residuo, no un aviso.
   */
  private async clearInputBox(target: string): Promise<void> {
    await this.options.tmux.run(["send-keys", "-t", target, "C-u"]).catch(() => undefined);
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
   * Sólo mira los ficheros que crecieron o que aparecieron después del pegado.
   *
   * Un registro acumula meses de conversaciones —6.511 ficheros y 2,5 GB en `ws-prizma` el
   * 2026-07-31— y releerlas todas en cada sondeo costaría más que el turno. La foto previa acota
   * el trabajo a lo que pudo haber cambiado; recorrer el árbol entero y preguntar los tamaños
   * cuesta 15 ms medidos sobre esos 6.511 ficheros.
   */
  private async locateInjectedTurn(
    baseline: ReadonlyMap<string, number>,
    promptText: string,
  ): Promise<{
    injected?: { file: string; key: string; sessionId?: string };
    started: boolean;
  }> {
    const port = this.options.transcript;
    let started = false;
    for (const file of await port.files()) {
      const size = await fileSize(file);
      const previous = baseline.get(file) ?? -1;
      if (size <= previous) continue;
      const slice = await port.read(file, Math.max(previous, 0));
      if (port.startedTurn?.(slice.appended) === true) started = true;
      const found = port.findInjected(file, slice.entries, promptText);
      if (found === undefined) continue;
      return {
        injected: found.sessionId === undefined
          ? { file, key: found.key }
          : { file, key: found.key, sessionId: found.sessionId },
        started,
      };
    }
    return { started };
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
    reason: "session_absent" | "tui_absent" | "input_busy" | "modal_blocking" | "handshake_failed",
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

  /**
   * Un aviso que NO es una caída: registra y además lo dice en el panel, sin teñirlo de rojo.
   *
   * El dueño es el único que puede compensar una compactación —volviendo a pegar lo importante— y
   * el único que sabe si el vaciado lo hizo él, así que el aviso tiene que llegarle a él y no sólo
   * al remitente de Telegram.
   */
  private async note(degradation: SharedSessionDegradation): Promise<void> {
    this.record(degradation);
    await announceNotice(
      this.options.tmux,
      sessionName(this.options.alias),
      TUI_WINDOW,
      `CAUCE: ${degradation.reason} — ${degradation.detail}`,
    );
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
