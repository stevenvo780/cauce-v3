/* eslint @typescript-eslint/no-deprecated: "off" -- JSON Schema tools require the low-level request handlers. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { EMISSION_TOOLS } from "./tools.js";
import { forwardEmission } from "./runtime.js";

export function createEmissionMcpServer(socketPath: string): Server {
  const server = new Server({ name: "cauce-emission", version: "1.0.0" }, { capabilities: { tools: {} } });
  const shim = randomUUID(); // Names this shim's calls: the same JSON-RPC request retried reuses its idempotency key.
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: EMISSION_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await forwardEmission(socketPath, request.params.name, request.params.arguments ?? {}, undefined,
        `${shim}:${String(extra.requestId)}`);
    }
    catch { return { isError: true, content: [{ type: "text", text: "Cauce adapter is unavailable; preserve your result and use the text envelope fallback" }] }; }
  });
  return server;
}
