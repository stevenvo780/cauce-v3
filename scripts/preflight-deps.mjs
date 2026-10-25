#!/usr/bin/env node
/*
 * Comprueba que node_modules sirve al gate antes de typecheck y test: que está instalado desde
 * el pnpm-lock.yaml actual y que los módulos con binario nativo cargan. Si no, sale con código 1
 * y el remedio explícito, en vez de un fallo críptico a mitad de la suite.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REMEDIO = 'ejecuta pnpm install --frozen-lockfile';
export const REMEDIO_DIST = 'ejecuta pnpm prepare:runtime';

/* Cada prueba recibe la raíz del repo y lanza si el módulo nativo no carga. */
export const MODULOS_NATIVOS = [
  {
    nombre: '@napi-rs/canvas',
    prueba: raiz => createRequire(join(raiz, 'package.json'))('@napi-rs/canvas'),
  },
  {
    nombre: 'esbuild',
    prueba: raiz => execFileSync(join(raiz, 'node_modules/esbuild/bin/esbuild'), ['--version'], { stdio: 'ignore' }),
  },
];

/* Un dist compilado antes del último cambio del fuente hace que lo importado difiera de lo que se prueba. */
export function comprobarDistProtocolo({ raiz }) {
  const fuente = join(raiz, 'packages/protocol/src');
  const dist = join(raiz, 'packages/protocol/dist');
  if (!existsSync(fuente) || !existsSync(dist)) return [];
  const desfasados = [];
  for (const nombre of readdirSync(fuente, { recursive: true })) {
    if (!nombre.endsWith('.ts') || nombre.endsWith('.d.ts')) continue;
    const compilado = join(dist, nombre.replace(/\.ts$/u, '.js'));
    if (!existsSync(compilado) || statSync(compilado).mtimeMs < statSync(join(fuente, nombre)).mtimeMs) desfasados.push(nombre);
  }
  if (desfasados.length === 0) return [];
  const muestra = desfasados.slice(0, 3).join(', ');
  return [`el dist de @cauce/protocol está desfasado respecto a su fuente (${String(desfasados.length)} fichero(s): ${muestra}); ${REMEDIO_DIST}`];
}

export function comprobarEntorno({ raiz }) {
  const problemas = [];
  const lockfile = join(raiz, 'pnpm-lock.yaml');
  const instalado = join(raiz, 'node_modules/.pnpm/lock.yaml');

  if (!existsSync(lockfile)) {
    problemas.push('falta pnpm-lock.yaml');
  } else if (!existsSync(join(raiz, 'node_modules'))) {
    problemas.push('no existe node_modules');
  } else if (!existsSync(instalado)) {
    problemas.push('node_modules no registra el lockfile instalado (falta node_modules/.pnpm/lock.yaml)');
  } else if (!readFileSync(lockfile).equals(readFileSync(instalado))) {
    problemas.push('node_modules no coincide con pnpm-lock.yaml');
  }

  for (const { nombre, prueba } of MODULOS_NATIVOS) {
    try {
      prueba(raiz);
    } catch (error) {
      const primera = String(error?.message ?? error).split('\n')[0];
      problemas.push(`no carga el módulo nativo ${nombre} (${primera})`);
    }
  }
  return [...problemas, ...comprobarDistProtocolo({ raiz })];
}

function principal() {
  const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const problemas = comprobarEntorno({ raiz });
  if (problemas.length === 0) return 0;
  const soloDist = problemas.every(problema => problema.endsWith(REMEDIO_DIST));
  process.stderr.write(`Preflight de dependencias: ${problemas.join('; ')}.\n${soloDist ? '' : `Remedio: ${REMEDIO}\n`}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = principal();
}
