#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEmissionMcpServer } from "../sdk/mcp-emission/server.js";

const socketPath = process.env.CAUCE_EMISSION_SOCKET_PATH ?? process.argv[2];
if (socketPath === undefined || !isAbsolute(socketPath) || socketPath.includes("\0") || socketPath.trim() !== socketPath) throw new Error("Usage: cauce-mcp /absolute/alias-state/mcp-emission.sock");
await createEmissionMcpServer(socketPath).connect(new StdioServerTransport());
