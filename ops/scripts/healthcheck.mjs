#!/usr/bin/env node

const [url = 'http://127.0.0.1:8080/health/ready', expected = 'ready'] = process.argv.slice(2);
const timeoutMs = Number(process.env.HEALTH_TIMEOUT_MS || 3000);

try {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error('health response is not JSON');
  const body = await response.json();
  const healthy = body.status === expected || body[expected] === true;
  if (!healthy) throw new Error(`expected status=${expected}`);
  process.exit(0);
} catch (error) {
  console.error(`healthcheck failed: ${error.message}`);
  process.exit(1);
}
