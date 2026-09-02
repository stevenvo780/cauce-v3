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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

export const PAQUETES_RAIZ = [
  'packages/protocol/src', 'packages/store/src', 'packages/mcp-fleet-monitor/src',
  'services/dispatcher/src', 'services/gateway/src', 'services/telegram-bridge/src',
  'services/terminal-relay/src',
];
export const PAQUETE_CONSOLA = 'console/src';
export const PAQUETE_ADAPTER = 'packages/adapter-sdk';
export const TOLERANCIA = 0.2;
const BASE_RELATIVA = 'scripts/cobertura-base.json';
const CLAVES_DE_BASE = new Set(['lineas_pct', 'pendiente_de_siembra']);
const SIEMBRA_PENDIENTE =
  'pendiente de siembra: corre `node scripts/cobertura.mjs --trinquete --sembrar` sobre un arbol verde';

const USO = [
  'uso: node scripts/cobertura.mjs [--peores N] [--trinquete [--actualizar | --sembrar]]',
  '',
  '  (sin banderas)         mide los tres dominios e imprime el informe completo',
  '  --peores N             cuantos ficheros peor cubiertos listar (por defecto 15)',
  '  --trinquete            compara el porcentaje de lineas de cada paquete contra',
  `                         ${BASE_RELATIVA} y sale 1 si alguno cae mas de`,
  `                         ${TOLERANCIA.toFixed(2)} puntos, si un dominio no se pudo medir, si un paquete`,
  '                         declarado no tiene cifra en la base, o si su entrada esta',
  '                         marcada {"lineas_pct": null, "pendiente_de_siembra": true}:',
  '                         un paquete solo entra en la base por --sembrar',
  '  --trinquete --actualizar   reescribe la base SOLO hacia arriba; cualquier bajada',
  '                         la rechaza y no toca el fichero',
  '  --trinquete --sembrar      escribe lo medido tal cual, y solo para los paquetes',
  '                         declarados: las claves rancias se retiran. Es la siembra',
  '                         inicial y la re-siembra explicita al cierre de una version:',
  '                         baja la base si la cobertura bajo, asi que nombra en stderr',
  '                         cada bajada que escribe. Un dominio que no se midio no se',
  '                         congela: conserva su cifra anterior, o queda marcado',
  '                         pendiente de siembra si nunca la tuvo, y la corrida sale 1.',
].join('\n');

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

function redondear(valor) {
  return Number(valor.toFixed(2));
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

export function agregarPaquetes(datos, prefijos) {
  const acumulado = new Map(prefijos.map((prefijo) => [prefijo, { cubierto: 0, total: 0 }]));
  for (const [ruta, valor] of Object.entries(datos)) {
    if (ruta === 'total') continue;
    const relativa = ruta.startsWith(`${root}/`) ? ruta.slice(root.length + 1) : ruta;
    const prefijo = prefijos.find((candidato) => relativa.startsWith(`${candidato}/`));
    if (prefijo === undefined) continue;
    const entrada = acumulado.get(prefijo);
    entrada.cubierto += valor.lines.covered;
    entrada.total += valor.lines.total;
  }
  return Object.fromEntries(acumulado);
}

function medicionDeDominio(dominio, prefijos, razon) {
  const indisponible = (motivo) => Object.fromEntries(prefijos.map((p) => [p, { no_disponible: motivo }]));
  if (!dominio) return indisponible(razon);
  if (dominio.fallo) return indisponible(`la suite terminó roja: ${mensaje(dominio.fallo)}`);
  const agregado = agregarPaquetes(dominio.resumen, prefijos);
  return Object.fromEntries(prefijos.map((prefijo) => {
    const { cubierto, total } = agregado[prefijo];
    if (total === 0) return [prefijo, { no_disponible: `el informe no trae ninguna linea bajo ${prefijo}` }];
    return [prefijo, { lineas_pct: redondear(porcentaje(cubierto, total)) }];
  }));
}

function medicionDeAdapter(adapter, razon) {
  if (!adapter) return { [PAQUETE_ADAPTER]: { no_disponible: razon } };
  if (adapter.fallo) {
    return { [PAQUETE_ADAPTER]: { no_disponible: `la suite terminó roja: ${mensaje(adapter.fallo)}` } };
  }
  return { [PAQUETE_ADAPTER]: { lineas_pct: redondear(adapter.lineas) } };
}

function describirFallo(fila) {
  if (fila.estado === 'ROJO') {
    return `${fila.paquete}: lineas cae de ${fila.base.toFixed(2)}% a ${fila.medido.toFixed(2)}% (${fila.diferencia.toFixed(2)} puntos; tolerancia ${TOLERANCIA.toFixed(2)})`;
  }
  if (fila.estado === 'NUEVO') {
    return `${fila.paquete}: NUEVO (mide ${fila.medido.toFixed(2)}% y la base no lo tiene); ${SIEMBRA_PENDIENTE}`;
  }
  if (fila.estado === 'PENDIENTE') return `${fila.paquete}: ${SIEMBRA_PENDIENTE}`;
  if (fila.estado === 'BASE INVALIDA') return `${fila.paquete}: ${fila.razon}`;
  let exigencia = 'todavia no hay cifra en la base';
  if (typeof fila.base === 'number') exigencia = `la base exige ${fila.base.toFixed(2)}%`;
  else if (fila.pendiente === true) exigencia = 'la base lo tiene pendiente de siembra';
  return `${fila.paquete}: ${fila.estado} (${fila.razon}); ${exigencia} y un dominio sin medir no es un dominio que no empeoró`;
}

function esPendiente(entrada) {
  return typeof entrada === 'object' && entrada !== null && entrada.pendiente_de_siembra === true;
}

function marcadorPendiente() {
  return { lineas_pct: null, pendiente_de_siembra: true };
}

function copiaDeBase(entrada) {
  return esPendiente(entrada) ? marcadorPendiente() : { lineas_pct: entrada.lineas_pct };
}

function razonDeEntradaInvalida(valor) {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return `no es un objeto con lineas_pct: ${JSON.stringify(valor)}`;
  }
  const desconocidas = Object.keys(valor).filter((clave) => !CLAVES_DE_BASE.has(clave));
  if (desconocidas.length > 0) return `trae claves que la base no conoce: ${desconocidas.join(', ')}`;
  if ('pendiente_de_siembra' in valor) {
    if (valor.pendiente_de_siembra !== true) return 'usa pendiente_de_siembra con un valor que no es true';
    if (valor.lineas_pct !== null) return 'esta pendiente de siembra, asi que su lineas_pct debe ser null';
    return undefined;
  }
  if (typeof valor.lineas_pct !== 'number' || !Number.isFinite(valor.lineas_pct)) {
    return `no trae un lineas_pct numerico: ${JSON.stringify(valor.lineas_pct)}`;
  }
  if (valor.lineas_pct < 0 || valor.lineas_pct > 100) {
    return `tiene un lineas_pct fuera de 0..100: ${String(valor.lineas_pct)}`;
  }
  return undefined;
}

export function validarBase(base) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    throw new Error(`${BASE_RELATIVA} corrupta: la base debe ser un objeto de paquete a cifra`);
  }
  const problemas = Object.entries(base)
    .map(([paquete, valor]) => [paquete, razonDeEntradaInvalida(valor)])
    .filter(([, razon]) => razon !== undefined)
    .map(([paquete, razon]) => `la entrada "${paquete}" ${razon}`);
  if (problemas.length > 0) {
    throw new Error(`${BASE_RELATIVA} corrupta: ${problemas.join('; ')}`);
  }
  return base;
}

export function compararCobertura(medido, base) {
  const paquetes = [...new Set([...Object.keys(base), ...Object.keys(medido)])].sort();
  const filas = [];
  const siguiente = {};
  for (const paquete of paquetes) {
    const esperado = base[paquete];
    const actual = medido[paquete];
    const invalida = esperado === undefined ? undefined : razonDeEntradaInvalida(esperado);
    if (invalida !== undefined) {
      filas.push({ paquete, estado: 'BASE INVALIDA', razon: `la entrada de la base ${invalida}` });
      continue;
    }
    if (esperado !== undefined) siguiente[paquete] = copiaDeBase(esperado);
    if (actual === undefined) {
      filas.push({
        paquete, estado: 'AUSENTE', razon: 'no aparece en esta corrida',
        base: esperado?.lineas_pct, pendiente: esPendiente(esperado),
      });
      continue;
    }
    if (typeof actual.lineas_pct !== 'number') {
      const razon = typeof actual.no_disponible === 'string' ? actual.no_disponible : 'sin medición';
      filas.push({ paquete, estado: 'NO DISPONIBLE', razon, base: esperado?.lineas_pct, pendiente: esPendiente(esperado) });
      continue;
    }
    const medida = redondear(actual.lineas_pct);
    if (esperado === undefined) {
      filas.push({ paquete, estado: 'NUEVO', medido: medida, razon: 'declarado y sin cifra en la base' });
      continue;
    }
    if (esPendiente(esperado)) {
      filas.push({ paquete, estado: 'PENDIENTE', medido: medida, razon: SIEMBRA_PENDIENTE });
      continue;
    }
    const diferencia = redondear(medida - esperado.lineas_pct);
    if (diferencia < -TOLERANCIA) {
      filas.push({ paquete, estado: 'ROJO', base: esperado.lineas_pct, medido: medida, diferencia });
      continue;
    }
    if (diferencia > 0) siguiente[paquete] = { lineas_pct: medida };
    filas.push({
      paquete, estado: diferencia > 0 ? 'SUBE' : 'OK', base: esperado.lineas_pct, medido: medida, diferencia,
    });
  }
  const rotas = filas.filter((fila) => fila.estado !== 'OK' && fila.estado !== 'SUBE');
  return { filas, fallos: rotas.map(describirFallo), base: siguiente };
}

export function baseActualizada(medido, base) {
  const comparacion = compararCobertura(medido, base);
  if (comparacion.fallos.length > 0) return { rechazado: comparacion.fallos, base };
  return { rechazado: [], base: comparacion.base };
}

function leerBase() {
  const ruta = join(root, BASE_RELATIVA);
  if (!existsSync(ruta)) return undefined;
  return validarBase(JSON.parse(readFileSync(ruta, 'utf8')));
}

function escribirBase(base) {
  const ordenada = Object.fromEntries(Object.keys(base).sort().map((clave) => [clave, base[clave]]));
  writeFileSync(join(root, BASE_RELATIVA), `${JSON.stringify(ordenada, null, 1)}\n`);
}

function celda(fila) {
  if (fila.estado === 'NUEVO') return `NUEVO   medido ${fila.medido.toFixed(2)}% y sin cifra en la base`;
  if (fila.estado === 'PENDIENTE') return `PENDIENTE  medido ${fila.medido.toFixed(2)}%; ${fila.razon}`;
  if (typeof fila.base !== 'number' || typeof fila.medido !== 'number') return `${fila.estado}: ${fila.razon}`;
  const signo = fila.diferencia > 0 ? '+' : '';
  return `${fila.estado.padEnd(7)} base ${fila.base.toFixed(2)}%  medido ${fila.medido.toFixed(2)}%  ${signo}${fila.diferencia.toFixed(2)}`;
}

function baseSembrada(medido, anterior) {
  const escrita = {};
  const conservados = [];
  for (const [paquete, valor] of Object.entries(medido)) {
    if (typeof valor.lineas_pct === 'number') {
      escrita[paquete] = { lineas_pct: redondear(valor.lineas_pct) };
      continue;
    }
    const previo = anterior[paquete];
    const heredable = previo !== undefined && razonDeEntradaInvalida(previo) === undefined && !esPendiente(previo);
    escrita[paquete] = heredable ? { lineas_pct: previo.lineas_pct } : marcadorPendiente();
    conservados.push([paquete, heredable ? `conserva la cifra anterior ${previo.lineas_pct.toFixed(2)}%` : 'queda pendiente de siembra']);
  }
  const retiradas = Object.keys(anterior).filter((paquete) => !(paquete in escrita));
  const bajadas = Object.entries(escrita).filter(([paquete, valor]) => {
    const previo = anterior[paquete];
    return typeof previo?.lineas_pct === 'number' && valor.lineas_pct !== null && valor.lineas_pct < previo.lineas_pct;
  });
  return { escrita, conservados: new Map(conservados), retiradas, bajadas };
}

function sembrarBase(medido) {
  console.log(`\ntrinquete de cobertura — siembra de ${BASE_RELATIVA}:`);
  for (const paquete of Object.keys(medido).sort()) {
    const valor = medido[paquete];
    const texto = typeof valor.lineas_pct === 'number'
      ? `${valor.lineas_pct.toFixed(2)}%`
      : `NO DISPONIBLE: ${valor.no_disponible}`;
    console.log(`  ${paquete.padEnd(32)} ${texto}`);
  }
  const entradas = Object.entries(medido);
  const medidos = entradas.filter(([, valor]) => typeof valor.lineas_pct === 'number');
  const sinMedir = entradas.filter(([, valor]) => typeof valor.lineas_pct !== 'number');
  if (medidos.length === 0) {
    return [new Error('ningun dominio se pudo medir: la siembra no escribe una base sin una sola cifra real')];
  }
  const lectura = intentar(leerBase);
  if (lectura.error) console.error(`  aviso: la base anterior no es legible (${mensaje(lectura.error)}); la siembra la reemplaza entera`);
  const { escrita, conservados, retiradas, bajadas } = baseSembrada(medido, lectura.valor ?? {});
  escribirBase(escrita);
  console.log(`  base escrita con ${String(Object.keys(escrita).length)} paquete(s) declarado(s), ${String(medidos.length)} medido(s) en esta corrida`);
  for (const paquete of retiradas) console.log(`  retirada la clave rancia ${paquete}: ya no es un paquete declarado`);
  if (bajadas.length > 0) {
    console.error(`\nBAJADAS ESCRITAS EN LA BASE: ${String(bajadas.length)} paquete(s) quedan exigiendo menos que antes.`);
    for (const [paquete, valor] of bajadas) {
      console.error(`  - ${paquete}: ${lectura.valor[paquete].lineas_pct.toFixed(2)}% -> ${valor.lineas_pct.toFixed(2)}%`);
    }
  }
  if (sinMedir.length === 0) return [];
  console.error(`\nSIEMBRA PARCIAL: ${String(sinMedir.length)} paquete(s) sin medir; ninguno congela una cifra de esta corrida.`);
  return sinMedir.map(([paquete, valor]) => new Error(
    `${paquete}: ${valor.no_disponible}; la siembra no congela la cifra de un dominio que no se midió: ${conservados.get(paquete)}`,
  ));
}

function aplicarTrinquete(medido, { actualizar, sembrar }) {
  if (sembrar) return sembrarBase(medido);
  const lectura = intentar(leerBase);
  if (lectura.error) {
    console.error(`\nBASE DE COBERTURA INUTILIZABLE:\n  ${mensaje(lectura.error)}`);
    return [lectura.error];
  }
  const base = lectura.valor;
  if (base === undefined) {
    return [new Error(`no existe ${BASE_RELATIVA}: siembralo con --trinquete --sembrar antes de exigir el trinquete`)];
  }
  const comparacion = compararCobertura(medido, base);
  console.log(`\ntrinquete de cobertura (lineas por paquete, base ${BASE_RELATIVA}):`);
  for (const fila of comparacion.filas) console.log(`  ${fila.paquete.padEnd(32)} ${celda(fila)}`);
  if (actualizar) {
    const decision = baseActualizada(medido, base);
    if (decision.rechazado.length === 0) {
      escribirBase(decision.base);
      console.log(`  base actualizada solo hacia arriba: ${String(Object.keys(decision.base).length)} paquetes`);
      return [];
    }
    console.error('\nTRINQUETE RECHAZADO: --actualizar no baja la base.');
    for (const fallo of decision.rechazado) console.error(`  - ${fallo}`);
    return decision.rechazado.map((fallo) => new Error(fallo));
  }
  if (comparacion.fallos.length === 0) {
    console.log(`  VERDE: ningun paquete cae mas de ${TOLERANCIA.toFixed(2)} puntos`);
    return [];
  }
  console.error('\nTRINQUETE DE COBERTURA ROJO:');
  for (const fallo of comparacion.fallos) console.error(`  - ${fallo}`);
  return comparacion.fallos.map((fallo) => new Error(fallo));
}

function principal(argumentos) {
  if (argumentos.includes('--ayuda') || argumentos.includes('-h')) {
    console.log(USO);
    return;
  }
  const cuantos = Number(argumentos[argumentos.indexOf('--peores') + 1]) || 15;
  const trinquete = argumentos.includes('--trinquete');
  const actualizar = argumentos.includes('--actualizar');
  const sembrar = argumentos.includes('--sembrar');
  if (actualizar && sembrar) throw new Error(`--actualizar y --sembrar se excluyen\n${USO}`);
  if ((actualizar || sembrar) && !trinquete) throw new Error(`--actualizar y --sembrar exigen --trinquete\n${USO}`);
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
    if (trinquete) {
      const medido = {
        ...medicionDeDominio(raiz, PAQUETES_RAIZ, mensaje(resultadoRaiz.error)),
        ...medicionDeDominio(consola, [PAQUETE_CONSOLA], mensaje(resultadoConsola.error)),
        ...medicionDeAdapter(adapter, mensaje(resultadoAdapter.error)),
      };
      fallos.push(...aplicarTrinquete(medido, { actualizar, sembrar }));
    }
    if (fallos.length > 0) {
      console.error(`\nCOBERTURA FALLIDA: la tabla parcial no acredita un gate verde.`);
      for (const fallo of fallos) console.error(`  - ${mensaje(fallo)}`);
      throw new AggregateError(fallos, `${String(fallos.length)} fallo(s) de cobertura`);
    }
  } finally {
    rmSync(salida, { recursive: true, force: true });
  }
}

function invocadoDirecto() {
  const ejecutado = process.argv[1];
  if (ejecutado === undefined) return false;
  try {
    return realpathSync(ejecutado) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invocadoDirecto()) principal(process.argv.slice(2));
