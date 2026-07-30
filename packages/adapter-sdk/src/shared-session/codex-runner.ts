import { access } from "node:fs/promises";
import WebSocket from "ws";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../sdk/types.js";
import {
  announceDegradation,
  announceNotice,
  clearDegradation,
  type TmuxController,
} from "./tmux.js";
import { ensureSharedSession, type EnsureOptions } from "./session.js";
import { TUI_WINDOW, sessionName } from "./types.js";
import type { SharedSessionDegradation, SharedSessionRunner } from "./types.js";

export interface CodexSharedSessionOptions {
  readonly alias: string;
  readonly workspace: string;
  /** Ruta del socket unix del `codex app-server`. */
  readonly socketPath: string;
  readonly tmux: TmuxController;
  /** El camino de siempre (`codex exec resume --json …`), usado sólo con aviso. */
  readonly fallback: CommandRunner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly turnTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly command?: string;
  /** Lo que se le fija al panel al crearlo. Ver `SharedSessionSpec.environment`. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly onDegradation?: (degradation: SharedSessionDegradation) => void;
  /** Fábrica del transporte, para poder sustituirla por un doble en las pruebas. */
  readonly connect?: (socketPath: string) => AppServerLink;
}

const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
const CLIENT_NAME = "cauce-v3-adapter";
const CLIENT_VERSION = "3";

/** Un mensaje entrante del app-server, ya decodificado. */
export interface AppServerMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/**
 * El transporte hacia el app-server, como interfaz.
 *
 * El socket habla WEBSOCKET, no JSON crudo por la tubería: los primeros clientes fueron
 * rechazados y el log lo dijo textual —«failed to upgrade control socket websocket connection:
 * WebSocket protocol error: httparse error: invalid token»—. Con el handshake correcto responde
 * `HTTP/1.1 101 Switching Protocols`.
 */
export interface AppServerLink {
  open(signal: AbortSignal): Promise<void>;
  send(message: Record<string, unknown>): void;
  messages(): AsyncIterable<AppServerMessage>;
  close(): void;
}

class WebSocketLink implements AppServerLink {
  private socket: WebSocket | undefined;
  private readonly queue: AppServerMessage[] = [];
  private waiter: ((value: IteratorResult<AppServerMessage>) => void) | undefined;
  private ended = false;

  constructor(private readonly socketPath: string) {}

  open(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolveOpen, rejectOpen) => {
      // `ws` habla con un socket unix por esta forma de URL; el sufijo `:/` es el pathname HTTP.
      //
      // `perMessageDeflate: false` NO es una optimización: sin él el app-server ABORTA el upgrade.
      // Medido el 2026-07-30 contra codex-cli 0.144.6: con la extensión ofrecida (el valor por
      // defecto de `ws`) el servidor corta la conexión y el cliente ve un `socket hang up` seco,
      // mientras un handshake a mano sin extensiones responde `101 Switching Protocols` en
      // cualquier ruta. Es un fallo silencioso y total: la sesión compartida de codex habría
      // degradado en TODOS los turnos.
      //
      // El `Host` explícito es defensa añadida: para una URL `ws+unix://` el host que deduce `ws`
      // es la propia ruta del socket, que contiene `/` y no es un token HTTP válido. Este servidor
      // lo tolera; un parser más estricto no tendría por qué.
      const socket = new WebSocket(`ws+unix://${this.socketPath}:/`, {
        perMessageDeflate: false,
        headers: { Host: "localhost" },
      });
      this.socket = socket;
      const onAbort = (): void => socket.close();
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("open", () => resolveOpen());
      socket.once("error", (error: Error) => {
        this.finish();
        rejectOpen(error);
      });
      socket.on("message", (data: WebSocket.RawData) => {
        for (const line of data.toString("utf8").split(/\r?\n/u)) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const value: unknown = JSON.parse(trimmed);
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
              this.push(value as AppServerMessage);
            }
          } catch {
            // Un frame que no es JSON no puede tumbar la conexión del turno.
          }
        }
      });
      socket.once("close", () => {
        signal.removeEventListener("abort", onAbort);
        this.finish();
      });
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(message));
  }

  messages(): AsyncIterable<AppServerMessage> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<AppServerMessage> => ({
        next: (): Promise<IteratorResult<AppServerMessage>> => {
          const value = this.queue.shift();
          if (value !== undefined) return Promise.resolve({ value, done: false });
          if (this.ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<AppServerMessage>>((resolveNext) => {
            this.waiter = resolveNext;
          });
        },
      }),
    };
  }

  close(): void {
    this.socket?.close();
    this.finish();
  }

  private push(message: AppServerMessage): void {
    const waiter = this.waiter;
    if (waiter === undefined) {
      this.queue.push(message);
      return;
    }
    this.waiter = undefined;
    waiter({ value: message, done: false });
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }
}

/**
 * Salida (c): el turno del bus entra por el protocolo de primera parte de codex.
 *
 * El dueño tiene la TUI real (`codex --remote unix://…`) y el adaptador entra como SEGUNDO cliente
 * del mismo app-server. No hay teclas, no hay pantalla y no hay ambigüedad: el pedido llega al
 * hilo como `userMessage` y la respuesta vuelve como `agentMessage` con `phase: "final_answer"`,
 * es decir un CAMPO TIPADO. Eso elimina de raíz el defecto que descalificó a la salida (b), donde
 * el eco del pedido en pantalla contenía otra copia del JSON y el raspador no sabía cuál era la
 * respuesta.
 *
 * Y como el turno pasa por el mismo hilo, aparece en vivo en el panel del dueño.
 */
export class CodexSharedSessionRunner implements SharedSessionRunner {
  private pending: SharedSessionDegradation | undefined;
  private lastThreadId: string | undefined;

  constructor(private readonly options: CodexSharedSessionOptions) {}

  takeDegradation(): SharedSessionDegradation | undefined {
    const degradation = this.pending;
    this.pending = undefined;
    return degradation;
  }

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.pending = undefined;
    const ensure = await ensureSharedSession(
      this.options.tmux,
      {
        alias: this.options.alias,
        harness: "codex",
        workspace: this.options.workspace,
        socketPath: this.options.socketPath,
        ...(this.options.command === undefined ? {} : { command: this.options.command }),
        ...(this.options.environment === undefined ? {} : { environment: this.options.environment }),
      },
      this.ensureOptions(),
    );
    if (!ensure.ready) {
      return this.degrade(ensure.failure ?? "session_absent", ensure.detail, request);
    }
    if (ensure.created) {
      // El dueño no tenía esta terminal abierta: la acabamos de crear para servir el turno, y su
      // hilo nace vacío. Sin este aviso la resurrección es indistinguible de una sesión compartida
      // de verdad.
      await this.note({
        reason: "session_created",
        detail: `no había sesión compartida y se creó una nueva: ${ensure.detail}`,
        occurredAt: new Date().toISOString(),
        fellBack: false,
      });
      this.lastThreadId = undefined;
    }
    if (!await access(this.options.socketPath).then(() => true, () => false)) {
      return this.degrade("session_absent", `no existe el socket ${this.options.socketPath}`, request);
    }

    const link = this.options.connect?.(this.options.socketPath)
      ?? new WebSocketLink(this.options.socketPath);
    try {
      return await this.converse(link, request);
    } finally {
      link.close();
    }
  }

  private ensureOptions(): EnsureOptions {
    return {
      sleep: this.options.sleep,
      ...(this.options.readyTimeoutMs === undefined
        ? {}
        : { readyTimeoutMs: this.options.readyTimeoutMs }),
    };
  }

  private async converse(link: AppServerLink, request: CommandRunRequest): Promise<CommandRunResult> {
    try {
      await link.open(request.signal);
    } catch (error) {
      return this.degrade("handshake_failed", describe(error), request);
    }

    const inbox = link.messages()[Symbol.asyncIterator]();
    // Las notificaciones que llegan MIENTRAS se espera la respuesta de una llamada se guardan, no
    // se tiran. El servidor puede emitir `turn/started` —o incluso un `item/completed`— antes de
    // contestar a `turn/start`, y descartarlas dejaría el turno esperando para siempre una
    // notificación que ya había pasado.
    const buffered: AppServerMessage[] = [];
    const call = async (method: string, params: Record<string, unknown>, id: number): Promise<
      { ok: true; result: unknown } | { ok: false; detail: string }
    > => {
      link.send({ id, method, params });
      for (;;) {
        const next = await inbox.next();
        if (next.done === true) return { ok: false, detail: `la conexión se cerró esperando ${method}` };
        const message = next.value;
        if (message.id !== id) {
          if (message.method !== undefined) buffered.push(message);
          continue;
        }
        if (message.error !== undefined) {
          return { ok: false, detail: `${method}: ${describeRpcError(message.error)}` };
        }
        return { ok: true, result: message.result };
      }
    };

    const initialized = await call("initialize", {
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      capabilities: { experimentalApi: true },
    }, 1);
    if (!initialized.ok) return this.degrade("handshake_failed", initialized.detail, request);

    const loaded = await call("thread/loaded/list", {}, 2);
    if (!loaded.ok) return this.degrade("handshake_failed", loaded.detail, request);
    const threads = listThreads(loaded.result);
    const threadId = threads[threads.length - 1];
    if (threadId === undefined) {
      return this.degrade(
        "tui_absent",
        "el app-server no tiene ningún hilo cargado: no hay TUI enganchada con la que compartir",
        request,
      );
    }
    if (this.lastThreadId !== undefined && this.lastThreadId !== threadId) {
      // Dos sucesos distintos, y el dueño tiene que poder distinguirlos:
      //  - el hilo anterior SIGUE cargado y hay uno más nuevo -> el dueño hizo `/new`. Se sigue el
      //    nuevo, que es el que él está mirando.
      //  - el hilo anterior YA NO ESTÁ -> el app-server o la TUI se reiniciaron.
      await this.note({
        reason: threads.includes(this.lastThreadId) ? "context_cleared" : "context_reset",
        detail: `el hilo vivo pasó de ${this.lastThreadId} a ${threadId}`,
        occurredAt: new Date().toISOString(),
        fellBack: false,
      });
    }
    this.lastThreadId = threadId;

    // `thread/resume` es lo que SUSCRIBE esta conexión al hilo. Sin él la llamada a `turn/start`
    // se acepta pero no llega ninguna notificación y el turno se queda esperando para siempre.
    const resumed = await call("thread/resume", { threadId }, 3);
    if (!resumed.ok) return this.degrade("handshake_failed", resumed.detail, request);

    const started = await call("turn/start", {
      threadId,
      input: [{ type: "text", text: request.stdin }],
    }, 4);
    if (!started.ok) return this.degrade("handshake_failed", started.detail, request);
    const turnId = startedTurnId(started.result);

    // Turno en marcha: desde acá no se degrada nunca, porque reejecutar por el camino de siempre
    // correría el trabajo dos veces.
    await clearDegradation(this.options.tmux, sessionName(this.options.alias), TUI_WINDOW);
    return this.collect(inbox, buffered, threadId, turnId, request);
  }

  private async collect(
    inbox: AsyncIterator<AppServerMessage>,
    buffered: AppServerMessage[],
    threadId: string,
    turnId: string | undefined,
    request: CommandRunRequest,
  ): Promise<CommandRunResult> {
    const budget = Math.min(
      request.timeoutMs,
      this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    );
    const deadline = Date.now() + budget;
    let answer: string | undefined;
    let finalAnswer: string | undefined;

    for (;;) {
      if (request.signal.aborted) return result({ cancelled: true });
      if (Date.now() >= deadline) return result({ timedOut: true });

      // Primero lo que llegó mientras se negociaban las llamadas; después la conexión.
      let message = buffered.shift();
      if (message === undefined) {
        const next = await inbox.next();
        if (next.done === true) {
          return result({
            exitCode: 1,
            stderr: "el app-server cerró la conexión con el turno en marcha;"
              + " el estado de finalización es desconocido",
          });
        }
        message = next.value;
      }
      const params = asObject(message.params);
      if (params === undefined) continue;
      if (params.threadId !== undefined && params.threadId !== threadId) continue;
      // Y del turno correcto. El hilo es COMPARTIDO: si el dueño escribe en su panel mientras
      // corre el turno del bus, su `turn/completed` cortaría la cosecha y nos llevaríamos su
      // respuesta o un `exitCode 1` inventado. `turn/start` devuelve el id del nuestro, así que no
      // hay que adivinar. Las notificaciones de item lo traen en `params.turnId`; las de turno, en
      // `params.turn.id` (verificado contra el esquema que emite `app-server
      // generate-json-schema` y contra capturas reales de 0.145.0).
      if (turnId !== undefined) {
        const observed = observedTurnId(params);
        if (observed !== undefined && observed !== turnId) continue;
      }

      if (message.method === "item/completed") {
        const item = asObject(params.item);
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          answer = item.text;
          if (item.phase === "final_answer") finalAnswer = item.text;
        }
        // La compactación de codex pasa DELANTE de estas narices como un item más y hasta ahora se
        // descartaba con un `continue`. No rompe la cosecha —el `agentMessage` llega igual— pero
        // el remitente se queda creyendo que habla con el contexto entero cuando ya es un resumen.
        if (item?.type === "contextCompaction") {
          await this.note({
            reason: "context_compacted",
            detail: "la terminal compactó su contexto durante este turno"
              + (typeof item.id === "string" ? ` (item ${item.id})` : ""),
            occurredAt: new Date().toISOString(),
            fellBack: false,
          });
        }
        continue;
      }
      if (message.method === "error") {
        if (params.willRetry === true) continue;
        return result({
          exitCode: 1,
          stderr: `el app-server informó un error del turno: ${describeRpcError(params.error)}`,
        });
      }
      if (message.method === "turn/completed") {
        const text = finalAnswer ?? answer;
        if (text === undefined) {
          return result({
            exitCode: 1,
            stderr: "el turno terminó sin ningún mensaje del agente",
          });
        }
        return result({
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: threadId }),
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
          ].join("\n"),
        });
      }
    }
  }

  private async degrade(
    reason: "session_absent" | "tui_absent" | "handshake_failed",
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

  /** Aviso que NO es una caída: al remitente y al panel del dueño, sin teñir nada de rojo. */
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

/**
 * Los hilos cargados, en el orden en que los da el app-server.
 *
 * El ÚLTIMO es el que el dueño está mirando: `/new` añade uno y no cierra el anterior —no hay
 * `thread/closed` y `thread/loaded/list` pasa a devolver los dos, medido el 2026-07-30—. Preferir
 * el del turno anterior "para no saltar de conversación" sonaba prudente y era lo peor de todos los
 * mundos: tras un `/new` el adaptador se quedaba hablando con el hilo ABANDONADO. Demostrado en
 * vivo: turno aceptado, `agentMessage` correcto, `turn/completed` correcto… y en el panel del dueño
 * no apareció nada. El bus cobra una respuesta plausible de una conversación que ya nadie mira.
 */
function listThreads(result: unknown): readonly string[] {
  if (typeof result !== "object" || result === null) return [];
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/** El id del turno que acabamos de arrancar, tal como lo devuelve `turn/start`. */
function startedTurnId(result: unknown): string | undefined {
  const turn = asObject(asObject(result)?.turn);
  return typeof turn?.id === "string" && turn.id.length > 0 ? turn.id : undefined;
}

/** El id de turno que trae una notificación, esté donde esté. */
function observedTurnId(params: Record<string, unknown>): string | undefined {
  if (typeof params.turnId === "string" && params.turnId.length > 0) return params.turnId;
  const turn = asObject(params.turn);
  return typeof turn?.id === "string" && turn.id.length > 0 ? turn.id : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeRpcError(error: unknown): string {
  const entry = asObject(error);
  if (entry === undefined) return String(error ?? "error sin detalle");
  const message = typeof entry.message === "string" ? entry.message : undefined;
  return message ?? JSON.stringify(entry).slice(0, 300);
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
