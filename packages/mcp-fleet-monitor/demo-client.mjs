#!/usr/bin/env node

/**
 * Simple MCP client for testing the fleet monitor server.
 * This demonstrates how to interact with the server programmatically.
 *
 * Usage:
 *   export DATABASE_URL="..."
 *   export CAUCE_TENANT_ID="Steven"
 *   node demo-client.mjs
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(__dirname, 'dist', 'src', 'server.js');

class MCPClient {
  constructor() {
    this.process = null;
    this.requestId = 1;
    this.pendingRequests = new Map();
  }

  async start() {
    // Spawn the server process
    this.process = spawn('node', [serverScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    // Handle stderr (logs)
    this.process.stderr.on('data', (data) => {
      console.error(`[server] ${data.toString().trim()}`);
    });

    // Handle stdout (MCP responses)
    this.lineBuffer = '';
    this.process.stdout.on('data', (data) => {
      this.lineBuffer += data.toString();
      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            this.handleResponse(message);
          } catch (error) {
            console.error('Failed to parse response:', line, error);
          }
        }
      }
    });

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  handleResponse(message) {
    if (message.id && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
    } else if (!message.id) {
      // Handle notifications
      console.log('[notification]', message);
    }
  }

  async send(method, params = {}) {
    const id = this.requestId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 5000);

      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async close() {
    if (this.process) {
      this.process.kill();
    }
  }
}

async function main() {
  const client = new MCPClient();

  try {
    console.log('Starting MCP Fleet Monitor server...');
    await client.start();
    console.log('✓ Server started\n');

    // Test 1: List tools
    console.log('=== Listing available tools ===');
    const tools = await client.send('tools/list');
    console.log(
      'Available tools:',
      tools.tools.map((t) => t.name).join(', ')
    );
    console.log();

    // Test 2: Call estado_flota
    console.log('=== Calling estado_flota() ===');
    try {
      const result = await client.send('tools/call', {
        name: 'estado_flota',
        arguments: {},
      });
      if (result.content && result.content.length > 0) {
        const data = JSON.parse(result.content[0].text);
        console.log('Response:', JSON.stringify(data, null, 2));
      } else {
        console.log('No response from tool');
      }
    } catch (error) {
      console.error('Error:', error.message);
    }
    console.log();

    // Test 3: Call salud
    console.log('=== Calling salud() ===');
    try {
      const result = await client.send('tools/call', {
        name: 'salud',
        arguments: {},
      });
      if (result.content && result.content.length > 0) {
        const data = JSON.parse(result.content[0].text);
        console.log('Response:', JSON.stringify(data, null, 2));
      } else {
        console.log('No response from tool');
      }
    } catch (error) {
      console.error('Error:', error.message);
    }
    console.log();

    // Test 4: Call entregas with filter
    console.log('=== Calling entregas(estado="acked", limit=5) ===');
    try {
      const result = await client.send('tools/call', {
        name: 'entregas',
        arguments: { estado: 'acked', limit: 5 },
      });
      if (result.content && result.content.length > 0) {
        const data = JSON.parse(result.content[0].text);
        console.log('Response (first 2 items):');
        console.log(
          JSON.stringify(
            {
              ...data,
              data: data.data?.slice(0, 2),
              total: data.data?.length,
            },
            null,
            2
          )
        );
      } else {
        console.log('No response from tool');
      }
    } catch (error) {
      console.error('Error:', error.message);
    }
    console.log();

    console.log('✓ All tests completed');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
