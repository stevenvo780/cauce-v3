#!/usr/bin/env node

import { request } from 'node:http';

const [socketPath, path = '/health/ready', expected = 'ready'] = process.argv.slice(2);
const timeoutMs = Number(process.env.HEALTH_TIMEOUT_MS || 3000);

if (!socketPath?.startsWith('/')) {
  console.error('readiness failed: an absolute Unix socket path is required');
  process.exit(2);
}

try {
  const body = await new Promise((resolve, reject) => {
    const requestHandle = request({ socketPath, path, method: 'GET', signal: AbortSignal.timeout(timeoutMs) }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65_536) response.destroy(new Error('response is too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode ?? 0}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    requestHandle.once('error', reject);
    requestHandle.end();
  });
  const decoded = JSON.parse(body);
  if (decoded.status !== expected && decoded[expected] !== true) throw new Error(`expected status=${expected}`);
} catch (error) {
  console.error(`readiness failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
