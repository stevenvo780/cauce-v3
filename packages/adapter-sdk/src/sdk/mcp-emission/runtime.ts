import { createServer, request, type Server } from "node:http";
import { chmod, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, prepareStateDirectory } from "../durable-store/atomic-state.js";
import {
  EmissionTurn, toolArguments, type EmissionGateway, type EmissionTurnOptions,
} from "./tools.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export interface EmissionToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
interface EmissionCallScope {
  readonly turn: EmissionTurn | undefined;
  readonly token: unknown;
}

export class EmissionRuntime {
  readonly socketPath: string;
  private server: Server | undefined;
  private readonly turns = new Set<EmissionTurn>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly stateDirectory: string,
    readonly instanceId: string,
    readonly gateway: EmissionGateway,
  ) { this.socketPath = join(stateDirectory, "mcp-emission.sock"); }

  begin(options: Omit<EmissionTurnOptions, "persist" | "gateway" | "instanceId">): EmissionTurn {
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

  end(turn: EmissionTurn): void { turn.close(); this.turns.delete(turn); }

  private currentTurn(): EmissionTurn | undefined {
    const [turn] = this.turns;
    return this.turns.size === 1 && turn?.available ? turn : undefined;
  }

  call(name: string, args: unknown, scope?: EmissionCallScope): Promise<EmissionToolResult> {
    // Capture the scope before queueing: an old request must never mutate a later turn.
    const turn = scope === undefined ? this.currentTurn() : scope.turn;
    const operation = this.tail.then(async (): Promise<EmissionToolResult> => {
      try {
        const parsed = toolArguments(name, args);
        let value: unknown;
        if (name === "cauce_queue") value = await this.gateway("GET", "/v3/agent/queue");
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
    const server = createServer((incoming, response) => {
      const turn = this.currentTurn();
      void (async () => {
        if (incoming.method === "GET" && incoming.url === "/scope") {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ turn_token: turn?.token ?? null }));
          return;
        }
        if (incoming.method !== "POST" || incoming.url !== "/tool") { response.writeHead(404).end(); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of incoming) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          bytes += buffer.length;
          if (bytes > MAX_REQUEST_BYTES) { response.writeHead(413).end(); return; }
          chunks.push(buffer);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name?: unknown; arguments?: unknown; turn_token?: unknown };
        if (typeof value.name !== "string") throw new Error("Missing tool name");
        const result = await this.call(value.name, value.arguments ?? {}, { turn, token: value.turn_token });
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
    });
    server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => { server.removeListener("error", reject); resolve(); });
    });
    this.server = server;
    await chmod(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    for (const turn of this.turns) turn.close();
    this.turns.clear();
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error); else resolve();
    }));
  }
}

export async function forwardEmission(socketPath: string, name: string, args: unknown, turnToken?: string): Promise<EmissionToolResult> {
  const token = turnToken ?? (await socketExchange(socketPath, "/scope", "GET")).turn_token;
  return await socketExchange(socketPath, "/tool", "POST", { name, arguments: args, turn_token: token }) as EmissionToolResult;
}

function socketExchange(socketPath: string, path: string, method: "GET" | "POST", body?: unknown): Promise<Record<string, unknown>> {
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
    outgoing.setTimeout(30_000, () => { outgoing.destroy(new Error("Emission socket timed out")); });
    outgoing.on("error", reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
