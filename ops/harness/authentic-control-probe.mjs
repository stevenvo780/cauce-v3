#!/usr/bin/env node

const [rawUrl, expected = 'ready'] = process.argv.slice(2);
const timeoutMs = Number(process.env.HEALTH_TIMEOUT_MS || 3000);

try {
  if (!rawUrl) throw new Error('control health URL is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('HEALTH_TIMEOUT_MS must be positive');
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:') throw new Error('control health URL must use HTTP');
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== expected && body[expected] !== true) throw new Error(`expected status=${expected}`);
} catch (error) {
  console.error(`fixture readiness failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
