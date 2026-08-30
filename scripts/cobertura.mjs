#!/usr/bin/env node
/*
 * One coverage number for the repository, and the list of suites that produced it.
 *
 * Three measurement domains, because three runners cannot share one process:
 *   root vitest (node)            -> packages/ and services/, every suite in ONE invocation
 *   console vitest (jsdom, react) -> console/src
 *   adapter-sdk (node --test)     -> compiled dist, source-mapped back to src
 *
 * Root and console cover disjoint file sets, so their totals add without merging any
 * coverage map. That matters: with the v8 provider a file keeps the same statement map
 * in every run, but its branch and function maps are built from what actually executed,
 * so two runs of one file cannot be fused branch by branch. Running the root suites one
 * zone at a time is what this replaces: a run that leaves out the suite exercising a
 * file reports that file near zero, and the next reader writes redundant tests for it.
 *
 * reportOnFailure is on because vitest otherwise writes no report when a suite is red,
 * and a repository whose number vanishes on the first red suite has no number.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SUITES_RAIZ = [
  'tests/unit', 'tests/e2e', 'tests/gateway-hardening', 'tests/integration',
  'tests/store-hardening', 'tests/terminal-pty', 'packages/mcp-fleet-monitor',
  'packages/protocol/test', 'packages/store/test', 'services/dispatcher/test',
  'services/gateway/src', 'services/telegram-bridge/test', 'services/terminal-relay/src',
];

const INCLUIR_RAIZ = ['packages/*/src/**/*.ts', 'services/*/src/**/*.ts'];
const EXCLUIR_RAIZ = ['packages/adapter-sdk/src/**'];

function ejecutar(comando, argumentos, opciones = {}) {
  const inicio = Date.now();
  const resultado = spawnSync(comando, argumentos, {
    cwd: opciones.cwd ?? root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    stdio: opciones.capturar ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return { ...resultado, ms: Date.now() - inicio };
}

function resumen(directorio) {
  const ruta = join(directorio, 'coverage-summary.json');
  if (!existsSync(ruta)) throw new Error(`la corrida no dejó ${ruta}`);
  return JSON.parse(readFileSync(ruta, 'utf8'));
}

function porcentaje(cubierto, total) {
  return total === 0 ? 100 : (cubierto * 100) / total;
}

function dominioRaiz(salida) {
  const argumentos = [
    'vitest', 'run', '--coverage', '--coverage.reporter=json-summary',
    '--coverage.reporter=json', `--coverage.reportsDirectory=${salida}`,
    '--coverage.reportOnFailure=true',
    ...INCLUIR_RAIZ.map((patron) => `--coverage.include=${patron}`),
    ...EXCLUIR_RAIZ.map((patron) => `--coverage.exclude=${patron}`),
    '--testTimeout=180000', ...SUITES_RAIZ,
  ];
  const corrida = ejecutar('npx', argumentos);
  return { resumen: resumen(salida), ms: corrida.ms, codigo: corrida.status };
}

function dominioConsola(salida) {
  const argumentos = [
    'vitest', 'run', '--coverage', '--coverage.provider=v8',
    '--coverage.reporter=json-summary', '--coverage.reporter=json',
    `--coverage.reportsDirectory=${salida}`, '--coverage.reportOnFailure=true',
    '--coverage.include=src/**',
    '--coverage.exclude=src/test/**', '--coverage.exclude=**/*.test.ts',
    '--coverage.exclude=**/*.test.tsx',
  ];
  const corrida = ejecutar('npx', argumentos, { cwd: join(root, 'console') });
  return { resumen: resumen(salida), ms: corrida.ms, codigo: corrida.status };
}

/*
 * Node applies --test-coverage-include to the file on disk AND to the path the source
 * map points at, so a file shows up only when both patterns are listed. With one missing
 * the table comes out empty and reports "all files 100.00": a perfect score, not a gap.
 */
function dominioAdapter() {
  const paquete = join(root, 'packages/adapter-sdk');
  ejecutar('pnpm', ['--filter', '@cauce/adapter-sdk', 'build'], { capturar: true });
  const corrida = ejecutar('node', [
    '--enable-source-maps', '--import', '../../scripts/paquetes-de-este-arbol.mjs',
    '--test', '--test-concurrency=1', '--experimental-test-coverage',
    '--test-coverage-include=src/**', '--test-coverage-include=dist/src/**',
    'dist/test/*.test.js',
  ], { cwd: paquete, capturar: true });
  const tabla = (corrida.stdout ?? '').split('\n');
  const ficheros = tabla.filter((linea) => /\.ts\s+\|/.test(linea)).length;
  const total = tabla.find((linea) => linea.startsWith('# all files'));
  const cifras = total ? total.split('|').slice(1, 4).map((valor) => Number(valor.trim())) : [];
  if (ficheros === 0) throw new Error('el informe de adapter-sdk salió vacío: la medición no ocurrió');
  return { lineas: cifras[0], ramas: cifras[1], funciones: cifras[2], ficheros, ms: corrida.ms };
}

function peores(resumenes, cuantos) {
  const filas = [];
  for (const datos of resumenes) {
    for (const [ruta, valor] of Object.entries(datos)) {
      if (ruta === 'total' || valor.lines.total < 40) continue;
      filas.push({ ruta: ruta.replace(`${root}/`, ''), ...valor.lines });
    }
  }
  filas.sort((uno, otro) => uno.pct - otro.pct || otro.total - uno.total);
  return filas.slice(0, cuantos);
}

function segundos(ms) {
  return `${(ms / 1_000).toFixed(0)}s`;
}

const cuantos = Number(process.argv[process.argv.indexOf('--peores') + 1]) || 15;
const salida = mkdtempSync(join(tmpdir(), 'cauce-cobertura-'));
try {
  ejecutar('pnpm', ['prepare:runtime'], { capturar: true });
  ejecutar('pnpm', ['build:mcp'], { capturar: true });
  ejecutar('pnpm', ['build:adapter'], { capturar: true });
  const raiz = dominioRaiz(join(salida, 'raiz'));
  const consola = dominioConsola(join(salida, 'consola'));
  const adapter = dominioAdapter();

  const lineas = ['lines', 'branches'].map((metrica) => {
    const total = raiz.resumen.total[metrica].total + consola.resumen.total[metrica].total;
    const cubierto = raiz.resumen.total[metrica].covered + consola.resumen.total[metrica].covered;
    return { metrica, total, cubierto, pct: porcentaje(cubierto, total) };
  });

  console.log(`\n${'='.repeat(78)}\ncobertura de cauce-v3\n${'='.repeat(78)}`);
  console.log(`\nsuites que produjeron la cifra (todas en una sola corrida por dominio):`);
  console.log(`  raiz     ${SUITES_RAIZ.join(' ')}`);
  console.log(`  consola  console/src (vitest propio: jsdom + plugin react)`);
  console.log(`\ndominio            lineas              ramas               corrida`);
  for (const [nombre, dato] of [['raiz', raiz], ['consola', consola]]) {
    const l = dato.resumen.total.lines, b = dato.resumen.total.branches;
    console.log(`  ${nombre.padEnd(16)} ${`${l.covered}/${l.total}`.padEnd(14)} ${`${l.pct.toFixed(2)}%`.padEnd(8)} ${`${b.pct.toFixed(2)}%`.padEnd(10)} ${segundos(dato.ms)}`);
  }
  console.log(`\n  CIFRA FUSIONADA  lineas ${lineas[0].cubierto}/${lineas[0].total} = ${lineas[0].pct.toFixed(2)}%   ramas ${lineas[1].pct.toFixed(2)}%`);
  console.log(`\ndeclarado aparte — packages/adapter-sdk (node --test sobre dist, source-mapped;`);
  console.log(`  v8 coverage de vitest NO lo alcanza, así que queda fuera de la cifra de arriba)`);
  console.log(`  lineas ${adapter.lineas.toFixed(2)}%   ramas ${adapter.ramas.toFixed(2)}%   funciones ${adapter.funciones.toFixed(2)}%   (${adapter.ficheros} ficheros, ${segundos(adapter.ms)})`);

  const lista = peores([raiz.resumen, consola.resumen], cuantos);
  console.log(`\n${cuantos} ficheros peor cubiertos (>=40 lineas):`);
  for (const fila of lista) {
    console.log(`  ${`${fila.pct.toFixed(1)}%`.padStart(7)}  ${String(fila.total).padStart(5)}  ${fila.ruta}`);
  }
  if (raiz.codigo !== 0 || consola.codigo !== 0) {
    console.log(`\nAVISO: alguna suite falló (raiz ${raiz.codigo}, consola ${consola.codigo}); la cifra sale de lo que sí corrió.`);
  }
} finally {
  rmSync(salida, { recursive: true, force: true });
}
