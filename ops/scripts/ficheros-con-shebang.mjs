#!/usr/bin/env node
/**
 * Discover tracked, extensionless executables by interpreter family.
 *
 * The predicate mirrors scripts/calidad.mjs: a basename without a dot whose first 80 bytes carry a
 * shebang for the requested family. Only the header is read, never the whole file.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FAMILIAS = {
  sh: /^#!.*\b(bash|sh)\b/,
  python: /^#!.*\b(python3?)\b/,
};
const CABECERA = 80;

function cabecera(fichero) {
  const buffer = Buffer.alloc(CABECERA);
  let descriptor;
  try {
    descriptor = openSync(fichero, 'r');
  } catch {
    return '';
  }
  try {
    const leidos = readSync(descriptor, buffer, 0, CABECERA, 0);
    return buffer.subarray(0, leidos).toString('utf8');
  } catch {
    return '';
  } finally {
    closeSync(descriptor);
  }
}

export function familias() {
  return Object.keys(FAMILIAS).sort();
}

export function ficherosConShebang(familia, candidatos) {
  const patron = FAMILIAS[familia];
  if (!patron) throw new Error(`unknown interpreter family: ${familia}`);
  return candidatos
    .filter(fichero => !path.basename(fichero).includes('.'))
    .filter(fichero => patron.test(cabecera(fichero)))
    .sort();
}

export function ficherosVersionados(raiz) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: raiz, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

function principal() {
  const familia = process.argv[2];
  if (!familia || !(familia in FAMILIAS)) {
    process.stderr.write(`usage: ficheros-con-shebang.mjs <${familias().join('|')}>\n`);
    process.exit(2);
  }
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const versionados = ficherosVersionados(raiz);
  const absolutos = new Map(versionados.map(fichero => [path.join(raiz, fichero), fichero]));
  const encontrados = ficherosConShebang(familia, [...absolutos.keys()])
    .map(absoluto => absolutos.get(absoluto));
  if (encontrados.length) process.stdout.write(`${encontrados.join('\n')}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) principal();
