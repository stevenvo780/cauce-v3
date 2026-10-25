#!/usr/bin/env node
import { build } from 'esbuild';
import { isAbsolute, resolve } from 'node:path';

const target = process.argv[2];
if (!target || !isAbsolute(target)) {
  throw new Error('usage: build-cli-runtime.mjs /absolute/terminal-runtime.cjs');
}
const root = resolve(import.meta.dirname, '../..');
await build({
  absWorkingDir: root,
  entryPoints: ['ops/cli/terminal-runtime.mjs'],
  outfile: target,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'error',
});
