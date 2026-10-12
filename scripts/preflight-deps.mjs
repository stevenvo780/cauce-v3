#!/usr/bin/env node
/*
 * Comprueba que node_modules sirve al gate antes de typecheck y test: que está instalado desde
 * el pnpm-lock.yaml actual y que los módulos con binario nativo cargan. Si no, sale con código 1
 * y el remedio explícito, en vez de un fallo críptico a mitad de la suite.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REMEDIO = 'ejecuta pnpm install --frozen-lockfile';

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
  return problemas;
}

function principal() {
  const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const problemas = comprobarEntorno({ raiz });
  if (problemas.length === 0) return 0;
  process.stderr.write(`Preflight de dependencias: ${problemas.join('; ')}.\nRemedio: ${REMEDIO}\n`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = principal();
}
