#!/usr/bin/env node

import { request as httpRequest } from 'node:http';

const [rawUrl, expected = 'ready'] = process.argv.slice(2);
const timeoutMs = Number(process.env.HEALTH_TIMEOUT_MS || 3000);

try {
  if (!rawUrl) throw new Error('local health URL is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('HEALTH_TIMEOUT_MS is invalid');
  }
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || url.username || url.password || url.hash || url.search || url.pathname !== '/health/ready') {
    throw new Error('local health URL must be the credential-free loopback readiness endpoint');
  }
  const body = await new Promise((resolve, reject) => {
    const request = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4_096) response.destroy(new Error('health response is too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode ?? 0}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    request.once('error', reject);
    request.end();
  });
  const decoded = JSON.parse(body);
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)
      || Object.keys(decoded).length !== 1 || decoded.status !== expected) {
    throw new Error(`expected status=${expected}`);
  }
} catch (error) {
  console.error(`local readiness failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
