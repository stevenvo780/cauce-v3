#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEmissionMcpServer } from "../sdk/mcp-emission/server.js";

const socketPath = process.argv[2];
if (socketPath === undefined || !isAbsolute(socketPath)) throw new Error("Usage: cauce-mcp /absolute/alias-state/mcp-emission.sock");
await createEmissionMcpServer(socketPath).connect(new StdioServerTransport());
