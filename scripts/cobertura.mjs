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
const SALIDAS_COMPILADAS = [
  'packages/protocol/dist',
  'packages/mcp-fleet-monitor/dist',
  'packages/adapter-sdk/dist',
];

function ejecutar(comando, argumentos, opciones = {}) {
  const inicio = Date.now();
  const resultado = spawnSync(comando, argumentos, {
    cwd: opciones.cwd ?? root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    stdio: opciones.capturar ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return { ...resultado, ms: Date.now() - inicio };
}

function falloDeCorrida(nombre, corrida) {
  if (corrida.error) {
    return new Error(`${nombre} no pudo arrancar: ${corrida.error.message}`, { cause: corrida.error });
  }
  if (corrida.status === 0) return undefined;
  const causa = corrida.signal ? `señal ${corrida.signal}` : `exit ${String(corrida.status)}`;
  return new Error(`${nombre} falló (${causa})`);
}

function mostrarSalidaCapturada(corrida) {
  if (corrida.stdout) process.stdout.write(corrida.stdout);
  if (corrida.stderr) process.stderr.write(corrida.stderr);
}

function exigirCorridaVerde(nombre, corrida) {
  const fallo = falloDeCorrida(nombre, corrida);
  if (!fallo) return;
  mostrarSalidaCapturada(corrida);
  throw fallo;
}

function limpiarSalidasCompiladas() {
  for (const ruta of SALIDAS_COMPILADAS) {
    rmSync(join(root, ruta), { recursive: true, force: true });
  }
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
  return {
    resumen: resumenTrasCorrida('suite raíz', salida, corrida),
    ms: corrida.ms,
    fallo: falloDeCorrida('suite raíz', corrida),
  };
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
  return {
    resumen: resumenTrasCorrida('suite consola', salida, corrida),
    ms: corrida.ms,
    fallo: falloDeCorrida('suite consola', corrida),
  };
}

function resumenTrasCorrida(nombre, salida, corrida) {
  try {
    return resumen(salida);
  } catch (error) {
    const fallo = falloDeCorrida(nombre, corrida);
    if (!fallo) throw error;
    throw new AggregateError([fallo, error], `${nombre} falló y no dejó cobertura utilizable`, {
      cause: fallo,
    });
  }
}

/*
 * Node applies --test-coverage-include to the file on disk AND to the path the source
 * map points at, so a file shows up only when both patterns are listed. With one missing
 * the table comes out empty and reports "all files 100.00": a perfect score, not a gap.
 */
function dominioAdapter() {
  const paquete = join(root, 'packages/adapter-sdk');
  const corrida = ejecutar('node', [
    '--enable-source-maps', '--import', '../../scripts/paquetes-de-este-arbol.mjs',
    '--test', '--test-concurrency=1', '--experimental-test-coverage',
    '--test-coverage-include=src/**', '--test-coverage-include=dist/src/**',
    'dist/test/*.test.js',
  ], { cwd: paquete, capturar: true });
  const fallo = falloDeCorrida('suite adapter-sdk', corrida);
  if (fallo) mostrarSalidaCapturada(corrida);
  const tabla = (corrida.stdout ?? '').split('\n');
  const ficheros = tabla.filter((linea) => /\.ts\s+\|/.test(linea)).length;
  const total = tabla.find((linea) => linea.startsWith('# all files'));
  const cifras = total ? total.split('|').slice(1, 4).map((valor) => Number(valor.trim())) : [];
  if (ficheros === 0 || cifras.length !== 3 || cifras.some((valor) => !Number.isFinite(valor))) {
    const informe = new Error('el informe de adapter-sdk salió vacío o malformado: la medición no ocurrió');
    if (!fallo) throw informe;
    throw new AggregateError([fallo, informe], 'suite adapter-sdk falló sin cobertura utilizable', {
      cause: fallo,
    });
  }
  return {
    lineas: cifras[0], ramas: cifras[1], funciones: cifras[2], ficheros, ms: corrida.ms,
    fallo,
  };
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

function intentar(operacion) {
  try {
    return { valor: operacion() };
  } catch (error) {
    return { error };
  }
}

function mensaje(error) {
  return error instanceof Error ? error.message : String(error);
}

const cuantos = Number(process.argv[process.argv.indexOf('--peores') + 1]) || 15;
const salida = mkdtempSync(join(tmpdir(), 'cauce-cobertura-'));
try {
  limpiarSalidasCompiladas();
  exigirCorridaVerde(
    'build de protocol',
    ejecutar('pnpm', ['prepare:runtime'], { capturar: true }),
  );
  exigirCorridaVerde('build de mcp', ejecutar('pnpm', ['build:mcp'], { capturar: true }));
  exigirCorridaVerde('build de adapter', ejecutar('pnpm', ['build:adapter'], { capturar: true }));

  const resultadoRaiz = intentar(() => dominioRaiz(join(salida, 'raiz')));
  const resultadoConsola = intentar(() => dominioConsola(join(salida, 'consola')));
  const resultadoAdapter = intentar(dominioAdapter);
  const raiz = resultadoRaiz.valor;
  const consola = resultadoConsola.valor;
  const adapter = resultadoAdapter.valor;

  const lineas = raiz && consola
    ? ['lines', 'branches'].map((metrica) => {
      const total = raiz.resumen.total[metrica].total + consola.resumen.total[metrica].total;
      const cubierto = raiz.resumen.total[metrica].covered + consola.resumen.total[metrica].covered;
      return { metrica, total, cubierto, pct: porcentaje(cubierto, total) };
    })
    : undefined;

  console.log(`\n${'='.repeat(78)}\ncobertura de cauce-v3\n${'='.repeat(78)}`);
  console.log(`\nsuites que produjeron la cifra (todas en una sola corrida por dominio):`);
  console.log(`  raiz     ${SUITES_RAIZ.join(' ')}`);
  console.log(`  consola  console/src (vitest propio: jsdom + plugin react)`);
  console.log(`\ndominio            lineas              ramas               corrida`);
  for (const [nombre, dato, resultado] of [
    ['raiz', raiz, resultadoRaiz], ['consola', consola, resultadoConsola],
  ]) {
    if (!dato) {
      console.log(`  ${nombre.padEnd(16)} NO DISPONIBLE      ${mensaje(resultado.error)}`);
      continue;
    }
    const l = dato.resumen.total.lines, b = dato.resumen.total.branches;
    console.log(`  ${nombre.padEnd(16)} ${`${l.covered}/${l.total}`.padEnd(14)} ${`${l.pct.toFixed(2)}%`.padEnd(8)} ${`${b.pct.toFixed(2)}%`.padEnd(10)} ${segundos(dato.ms)}`);
  }
  if (lineas) {
    console.log(`\n  CIFRA FUSIONADA  lineas ${lineas[0].cubierto}/${lineas[0].total} = ${lineas[0].pct.toFixed(2)}%   ramas ${lineas[1].pct.toFixed(2)}%`);
  } else {
    console.log(`\n  CIFRA FUSIONADA  NO DISPONIBLE: falta al menos un dominio medible`);
  }
  console.log(`\ndeclarado aparte — packages/adapter-sdk (node --test sobre dist, source-mapped;`);
  console.log(`  v8 coverage de vitest NO lo alcanza, así que queda fuera de la cifra de arriba)`);
  if (adapter) {
    console.log(`  lineas ${adapter.lineas.toFixed(2)}%   ramas ${adapter.ramas.toFixed(2)}%   funciones ${adapter.funciones.toFixed(2)}%   (${adapter.ficheros} ficheros, ${segundos(adapter.ms)})`);
  } else {
    console.log(`  NO DISPONIBLE: ${mensaje(resultadoAdapter.error)}`);
  }

  const resumenes = [raiz?.resumen, consola?.resumen].filter(Boolean);
  const lista = peores(resumenes, cuantos);
  console.log(`\n${cuantos} ficheros peor cubiertos (>=40 lineas):`);
  for (const fila of lista) {
    console.log(`  ${`${fila.pct.toFixed(1)}%`.padStart(7)}  ${String(fila.total).padStart(5)}  ${fila.ruta}`);
  }

  const fallos = [resultadoRaiz, resultadoConsola, resultadoAdapter].flatMap((resultado) => {
    if (resultado.error) return [resultado.error];
    return resultado.valor?.fallo ? [resultado.valor.fallo] : [];
  });
  if (fallos.length > 0) {
    console.error(`\nCOBERTURA FALLIDA: la tabla parcial no acredita un gate verde.`);
    for (const fallo of fallos) console.error(`  - ${mensaje(fallo)}`);
    throw new AggregateError(fallos, `${String(fallos.length)} dominio(s) de cobertura fallaron`);
  }
} finally {
  rmSync(salida, { recursive: true, force: true });
}
