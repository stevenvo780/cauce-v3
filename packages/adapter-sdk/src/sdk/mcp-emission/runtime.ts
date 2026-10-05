import { createServer, request, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, prepareStateDirectory } from "../durable-store/atomic-state.js";
import {
  EmissionTurn, toolArguments, type EmissionGateway, type EmissionTurnOptions,
} from "./tools.js";
import { answerDecisiones, type DecisionesForwarder } from "./decisiones.js";
import { readResult, sendOutsideDelivery, type EmissionIdentity } from "./outside-delivery.js";
import type { PromptOrigin } from "../../shared-session/prompt-origin.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export interface EmissionToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
interface EmissionCallScope {
  readonly turn: EmissionTurn | undefined;
  readonly token: unknown;
  readonly callId?: unknown;
}
const MAX_REMEMBERED_CALLS = 256;

export class EmissionRuntime {
  readonly socketPath: string;
  private server: Server | undefined;
  private closing = false;
  private readonly endpoints = new Map<EmissionTurn, {
    readonly server: Server; readonly path: string; readonly ino: number; readonly dev: number;
    readonly onAbort: () => void;
  }>();
  private readonly endpointCreations = new Map<EmissionTurn, Promise<string>>();
  private readonly endpointClosures = new Map<EmissionTurn, Promise<void>>();
  private readonly turns = new Set<EmissionTurn>();
  private readonly scopedTurns = new WeakSet<EmissionTurn>();
  private tail: Promise<unknown> = Promise.resolve();
  private deliveriesInFlight: (() => number) | undefined; // Unset means unknown: never publish a root blind.
  private lastPromptOrigin: (() => Promise<PromptOrigin | undefined>) | undefined; // Unset: no human TUI to speak for.
  private readonly sendKeys = new Map<string, string>(); // MCP call id -> key, so a transport retry of one call is one message.

  constructor(
    readonly stateDirectory: string,
    readonly instanceId: string,
    readonly gateway: EmissionGateway,
    readonly decisiones?: DecisionesForwarder,
    readonly identity?: EmissionIdentity,
  ) { this.socketPath = join(stateDirectory, "mcp-emission.sock"); }

  trackDeliveries(count: () => number): void { this.deliveriesInFlight = count; }
  trackPromptOrigin(origin: () => Promise<PromptOrigin | undefined>): void { this.lastPromptOrigin = origin; }
  refuseOutsideDelivery(reason: string): void { this.outsideRefusal = reason; }
  private outsideRefusal: string | undefined;

  private sendKey(callId: unknown): string {
    if (typeof callId !== "string" || callId.length === 0 || callId.length > 200) return `tui:${randomUUID()}`;
    const known = this.sendKeys.get(callId);
    if (known !== undefined) return known;
    const key = `tui:${randomUUID()}`;
    this.sendKeys.set(callId, key);
    for (const oldest of this.sendKeys.keys()) {
      if (this.sendKeys.size <= MAX_REMEMBERED_CALLS) break;
      this.sendKeys.delete(oldest);
    }
    return key;
  }

  /** cauce_send with no turn of its own: a root only when nothing is in flight and a human typed the last prompt. */
  private assertOutsideDeliveryAvailable(): void {
    if (this.closing) throw new Error("Emission runtime is closing; nothing was sent");
    const inFlight = this.deliveriesInFlight?.();
    if (this.turns.size > 0 || (inFlight ?? 0) > 0) throw new Error("Hay una entrega de Cauce en curso en este adaptador; no se envió nada. Reintentá cauce_send cuando termine.");
    if (inFlight === undefined) throw new Error("Este adaptador no tiene una terminal compartida con un humano: fuera de una entrega no se envía nada.");
  }

  private async sendWithoutTurn(args: Record<string, unknown>, scope: EmissionCallScope | undefined): Promise<unknown> {
    if ((scope?.token ?? null) !== null) throw new Error("El turno de esta llamada ya cerró; no se envió nada.");
    this.assertOutsideDeliveryAvailable();
    if (this.outsideRefusal !== undefined) throw new Error(`${this.outsideRefusal}; no se envió nada.`);
    if (this.identity === undefined || this.lastPromptOrigin === undefined) {
      throw new Error("Este adaptador no tiene una terminal compartida con un humano: fuera de una entrega no se envía nada.");
    }
    const origin = await this.lastPromptOrigin().catch(() => undefined);
    this.assertOutsideDeliveryAvailable();
    if (origin === "cauce") {
      throw new Error("Lo último que entró en esta terminal fue un pedido de Cauce, no de tu humano: fuera de una entrega"
        + " sólo se envía lo que pide una persona en la TUI. No se envió nada.");
    }
    if (origin !== "human") {
      throw new Error("No pude confirmar en el registro de la terminal que el último pedido lo tecleó una persona; no se envió nada.");
    }
    return sendOutsideDelivery(this.gateway, this.identity, args, this.sendKey(scope?.callId));
  }

  begin(options: Omit<EmissionTurnOptions, "persist" | "gateway" | "instanceId">): EmissionTurn {
    if (this.closing) throw new Error("Emission runtime is closing");
    const turn = new EmissionTurn({ ...options, gateway: this.gateway, instanceId: this.instanceId,
      persist: async (state, correlationId) => {
        const { delivery } = options;
        const directory = join(this.stateDirectory, "mcp-emission");
        await prepareStateDirectory(directory);
        await atomicWrite(join(directory, `${delivery.delivery_id}.${String(delivery.attempt)}.json`), {
          delivery_id: delivery.delivery_id, attempt: delivery.attempt, epoch: delivery.epoch,
          submission: "staged_until_cli_finishes", ...state,
        });
        if (state.replied && correlationId !== undefined) {
          if (!/^[a-f0-9]{64}$/u.test(correlationId)) throw new Error("Invalid internal turn correlation");
          await atomicWrite(join(directory, `${correlationId}.json`), {
            correlation_id: correlationId, output: state.output,
          });
        }
      },
    });
    this.turns.add(turn);
    return turn;
  }

  end(turn: EmissionTurn): void {
    turn.close(); this.turns.delete(turn);
    this.closeEndpoint(turn);
  }

  endpointFor(turn: EmissionTurn): Promise<string> {
    this.scopedTurns.add(turn);
    const pending = this.endpointCreations.get(turn);
    if (pending !== undefined) return pending;
    const creation = this.createEndpoint(turn);
    this.endpointCreations.set(turn, creation);
    void creation.finally(() => { this.endpointCreations.delete(turn); }).catch(() => undefined);
    return creation;
  }

  private ownsTurn(turn: EmissionTurn): boolean {
    return !this.closing && this.turns.has(turn) && !turn.options.signal.aborted && turn.options.isCurrent();
  }

  private async createEndpoint(turn: EmissionTurn): Promise<string> {
    if (!this.ownsTurn(turn)) throw new Error("Emission turn is not owned");
    const known = this.endpoints.get(turn);
    if (known !== undefined) return known.path;
    const path = join(this.stateDirectory, `e-${randomUUID()}.sock`);
    if (Buffer.byteLength(path) > 107) throw new Error("Emission endpoint exceeds Unix socket path limit");
    const server = this.socketServer(turn);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => { server.removeListener("error", reject); resolve(); });
      });
      await chmod(path, 0o600);
      const metadata = await lstat(path);
      if (!metadata.isSocket() || metadata.uid !== process.getuid?.()) throw new Error("Emission endpoint ownership differs");
      const onAbort = (): void => { this.closeEndpoint(turn); };
      this.endpoints.set(turn, { server, path, ino: metadata.ino, dev: metadata.dev, onAbort });
      turn.options.signal.addEventListener("abort", onAbort, { once: true });
      if (!this.ownsTurn(turn)) {
        await this.releaseEndpoint(turn);
        throw new Error("Emission turn closed before endpoint activation");
      }
      return path;
    } catch (error) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      throw error;
    }
  }

  private closeEndpoint(turn: EmissionTurn): void {
    const endpoint = this.endpoints.get(turn);
    if (endpoint === undefined) return;
    this.endpoints.delete(turn);
    turn.options.signal.removeEventListener("abort", endpoint.onAbort);
    const closing = (async () => {
      endpoint.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => endpoint.server.close((error) => {
        if (error) reject(error); else resolve();
      }));
      try {
        const metadata = await lstat(endpoint.path);
        if (metadata.ino !== endpoint.ino || metadata.dev !== endpoint.dev || !metadata.isSocket()
            || metadata.uid !== process.getuid?.()) throw new Error("Emission endpoint replaced before cleanup");
        await unlink(endpoint.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    })();
    this.endpointClosures.set(turn, closing);
    void closing.catch(() => undefined);
  }

  async releaseEndpoint(turn: EmissionTurn): Promise<void> {
    this.closeEndpoint(turn);
    await this.endpointClosures.get(turn);
    this.endpointClosures.delete(turn);
  }

  private currentTurn(): EmissionTurn | undefined {
    const legacy = [...this.turns].filter((turn) => !this.scopedTurns.has(turn));
    const [turn] = legacy;
    return legacy.length === 1 && turn?.available ? turn : undefined;
  }

  call(name: string, args: unknown, scope?: EmissionCallScope): Promise<EmissionToolResult> {
    // Capture the scope before queueing: an old request must never mutate a later turn.
    const turn = scope === undefined ? this.currentTurn() : scope.turn;
    const operation = this.tail.then(async (): Promise<EmissionToolResult> => {
      try {
        if (scope?.turn !== undefined && (!scope.turn.available || scope.token !== scope.turn.token)) {
          throw new Error("The MCP call does not own an active turn; nothing was deposited");
        }
        const parsed = toolArguments(name, args);
        let value: unknown;
        if (name === "cauce_queue") value = await this.gateway("GET", "/v3/agent/queue");
        else if (name === "cauce_result") value = await readResult(this.gateway, parsed);
        else if (name === "cauce_send" && turn === undefined) value = await this.sendWithoutTurn(parsed, scope);
        else {
          if (turn === undefined) throw new Error("No unique active turn; wait for a Cauce delivery");
          if (scope !== undefined && scope.token !== turn.token) throw new Error("The MCP call belongs to a different turn; nothing was deposited");
          value = await turn.call(name, parsed);
        }
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Emission failed" }] };
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async listen(): Promise<void> {
    if (this.closing) throw new Error("Emission runtime is closing");
    if (this.server !== undefined) return;
    await prepareStateDirectory(this.stateDirectory);
    try {
      const previous = await lstat(this.socketPath);
      if (!previous.isSocket() || previous.uid !== process.getuid?.()) throw new Error("Unsafe existing emission socket");
      const live = await forwardEmission(this.socketPath, "cauce_status", {}).then(() => true).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") return false;
        throw error;
      });
      if (live) throw new Error("Another emission server owns this alias socket");
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const server = this.socketServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => { server.removeListener("error", reject); resolve(); });
    });
    this.server = server;
    await chmod(this.socketPath, 0o600);
  }

  private socketServer(boundTurn?: EmissionTurn): Server {
    const server = createServer((incoming, response) => {
      const turn = boundTurn ?? this.currentTurn();
      void (async () => {
        if (incoming.method === "GET" && incoming.url === "/scope") {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ turn_token: turn?.token ?? null }));
          return;
        }
        const route = incoming.method === "POST" ? incoming.url : undefined;
        if (route !== "/tool" && route !== "/decisiones") { response.writeHead(404).end(); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of incoming) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          bytes += buffer.length;
          if (bytes > MAX_REQUEST_BYTES) { response.writeHead(413).end(); return; }
          chunks.push(buffer);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          name?: unknown; arguments?: unknown; turn_token?: unknown; call_id?: unknown; operacion?: unknown; argumentos?: unknown;
        };
        // Decisions need no turn and never wait behind this.tail: a slow Jev must not delay a reply.
        if (route === "/decisiones") {
          const answer = await answerDecisiones(this.decisiones, value.operacion, value.argumentos);
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
          return;
        }
        if (typeof value.name !== "string") throw new Error("Missing tool name");
        const result = await this.call(value.name, value.arguments ?? {}, { turn, token: value.turn_token, callId: value.call_id });
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
    });
    server.requestTimeout = 30_000;
    return server;
  }

  async close(): Promise<void> {
    this.closing = true;
    const server = this.server;
    this.server = undefined;
    server?.closeAllConnections();
    const globalClosed = server === undefined ? Promise.resolve() : new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error); else resolve();
    }));
    void globalClosed.catch(() => undefined);
    for (const turn of this.turns) this.end(turn);
    await Promise.allSettled(this.endpointCreations.values());
    await Promise.all(this.endpointClosures.values());
    this.endpointClosures.clear();
    await globalClosed;
  }
}

export async function forwardEmission(
  socketPath: string, name: string, args: unknown, turnToken?: string, callId?: string,
): Promise<EmissionToolResult> {
  const token = turnToken ?? (await socketExchange(socketPath, "/scope", "GET")).turn_token;
  return await socketExchange(socketPath, "/tool", "POST", {
    name, arguments: args, turn_token: token, ...(callId === undefined ? {} : { call_id: callId }),
  }) as EmissionToolResult;
}

export function socketExchange(
  socketPath: string, path: string, method: "GET" | "POST", body?: unknown, timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, path, method, headers: { "content-type": "application/json" } }, (response) => {
      let received = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        received += chunk;
        if (Buffer.byteLength(received) > MAX_REQUEST_BYTES) outgoing.destroy(new Error("Emission response exceeds limit"));
      });
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error(`Emission socket returned HTTP ${String(response.statusCode)}`);
          resolve(JSON.parse(received) as Record<string, unknown>);
        } catch (error) { reject(error instanceof Error ? error : new Error("Invalid emission response")); }
      });
      response.on("error", reject);
    });
    outgoing.setTimeout(timeoutMs, () => { outgoing.destroy(new Error("Emission socket timed out")); });
    outgoing.on("error", reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
