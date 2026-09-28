#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDecisionesMcpServer } from "../sdk/mcp-emission/decisiones-server.js";

const socketPath = process.argv[2];
if (socketPath === undefined || !isAbsolute(socketPath)) throw new Error("Usage: cauce-decisiones-mcp /absolute/alias-state/mcp-emission.sock");
await createDecisionesMcpServer(socketPath).connect(new StdioServerTransport());
