#!/usr/bin/env node
const [url, expected = 'ready'] = process.argv.slice(2);
try {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== expected && body[expected] !== true) throw new Error(`expected status=${expected}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
