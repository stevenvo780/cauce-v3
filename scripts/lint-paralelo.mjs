#!/usr/bin/env node
// Runs package scripts at once and prints each one's whole output in the order given, so logs stay readable.
// Every script lints its own files and no rule looks across files, so splitting a run changes no verdict.
import { spawn } from 'node:child_process';

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('uso: node scripts/lint-paralelo.mjs <script de package.json>...');
  process.exit(2);
}

const children = new Set();
const run = name => new Promise(resolve => {
  const started = Date.now();
  const chunks = [];
  const child = spawn('pnpm', ['run', name], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => chunks.push(chunk));
  const done = (code, detail = '') => {
    children.delete(child);
    resolve({ name, code, seconds: Math.round((Date.now() - started) / 1000), output: Buffer.concat(chunks).toString() + detail });
  };
  child.on('error', error => { done(127, `${String(error)}\n`); });
  child.on('close', (code, signal) => { done(code ?? 1, signal ? `terminado por ${signal}\n` : ''); });
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit(130);
  });
}

const pending = names.map(run);
const failed = [];
for (const result of pending) {
  const { name, code, seconds, output } = await result;
  process.stdout.write(`\n== ${name}: exit ${code} (${seconds}s)\n${output}`);
  if (code !== 0) failed.push(name);
}
if (failed.length > 0) {
  console.error(`\nlint-paralelo: ROJO en ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\nlint-paralelo: ${names.length} script(s) en verde`);
