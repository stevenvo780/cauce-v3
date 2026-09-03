#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serverEnvironment } from './src/server-environment.ts';

const directory = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(directory, 'dist', 'server.js');
const REQUIRED_TOOLS = ['chain', 'dead_letters', 'deliveries', 'fleet_status', 'health'];

function textContent(result) {
  const text = result.content.find((part) => part.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('health returned no text content');
  return text;
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: serverEnvironment(),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'mcp-fleet-monitor-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    await client.ping();

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(REQUIRED_TOOLS)) {
      throw new Error(`unexpected tool surface: ${names.join(', ')}`);
    }

    const health = await client.callTool({ name: 'health', arguments: {} });
    if (health.isError === true) throw new Error(textContent(health));
    const payload = JSON.parse(textContent(health));
    if (typeof payload.summary !== 'string' || Number.isNaN(Date.parse(payload.timestamp))) {
      throw new Error('health returned a malformed payload');
    }

    console.log(`MCP smoke passed: ${names.join(', ')}; ${payload.summary}`);
  } finally {
    await client.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('MCP smoke failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
