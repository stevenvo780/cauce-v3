/* eslint @typescript-eslint/no-deprecated: "off" -- JSON Schema tools require the low-level request handlers. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DECISIONES_TIMEOUT_MS, DECISIONES_TOOLS, respaldoSinServicio } from "./decisiones.js";
import { socketExchange, type EmissionToolResult } from "./runtime.js";

function unavailable(operacion: string, argumentos: unknown): EmissionToolResult {
  const respaldo = respaldoSinServicio(operacion, argumentos);
  const body = { error: "adaptador_no_responde", mensaje: "El adaptador de Cauce no responde: aplicá el respaldo", ...(respaldo === undefined ? {} : { respaldo }) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}

export async function callDecisiones(socketPath: string, operacion: string, argumentos: unknown): Promise<EmissionToolResult> {
  const answer = await socketExchange(socketPath, "/decisiones", "POST", { operacion, argumentos }, DECISIONES_TIMEOUT_MS + 5_000);
  const status = typeof answer.status === "number" ? answer.status : 502;
  const text = JSON.stringify(answer.body ?? {});
  return status >= 400 ? { isError: true, content: [{ type: "text", text }] } : { content: [{ type: "text", text }] };
}

/** A separate MCP server from cauce-emission, so registering it never turns on MCP emission in an alias. */
export function createDecisionesMcpServer(socketPath: string): Server {
  const server = new Server({ name: "cauce-decisiones", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: DECISIONES_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    if (!DECISIONES_TOOLS.some((tool) => tool.name === name)) return { isError: true, content: [{ type: "text", text: `Herramienta desconocida: ${name}` }] };
    const argumentos = request.params.arguments ?? {};
    try { return await callDecisiones(socketPath, name, argumentos); }
    catch { return unavailable(name, argumentos); }
  });
  return server;
}
