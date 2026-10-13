#!/usr/bin/env node
/*
 * Test sharding for the release gate: CAUCE_TEST_SHARD=i/N asks every test runner in the tree to
 * run only shard i of its own file set. The split is vitest's own --shard split (sha1 of the path
 * relative to the runner root, sorted, contiguous slices), so a shard is reproducible by hand.
 *
 * With CAUCE_TEST_SHARD_DIR set, every sharded invocation records its whole file set and the files
 * it kept. verificarReparto proves from those records that the shards together ran every file of
 * every invocation exactly once: none missing, none twice.
 *
 * CLI: `node scripts/trozos.mjs ejecutar <cmd> <args...>` runs a node --test style command with only
 * the test files of this shard (all of them without CAUCE_TEST_SHARD).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VARIABLES_DE_TROZO = ['CAUCE_TEST_SHARD', 'CAUCE_TEST_SHARD_DIR', 'CAUCE_TEST_SUITE'];
const FORMATO = /^([1-9]\d{0,3})\/([1-9]\d{0,3})$/u;
const REGISTRO = /^reparto-(\d+)-.+\.json$/u;
const FICHERO_DE_PRUEBA = /\.test\.[cm]?js$/u;

export function leerTrozo(valor = process.env.CAUCE_TEST_SHARD) {
  if (valor === undefined || valor === '') return undefined;
  const partes = FORMATO.exec(valor);
  const indice = Number(partes?.[1]);
  const total = Number(partes?.[2]);
  if (!partes || indice > total) throw new Error(`CAUCE_TEST_SHARD debe ser i/N con 1 <= i <= N (es '${valor}')`);
  return { indice, total };
}

export function sinTrozo(entorno = process.env) {
  const limpio = { ...entorno };
  for (const nombre of VARIABLES_DE_TROZO) delete limpio[nombre];
  return limpio;
}

export function elegir(rutas, { indice, total }) {
  const tamano = Math.ceil(rutas.length / total);
  return rutas
    .map((ruta) => ({ ruta, clave: createHash('sha1').update(`/${ruta}`).digest('hex') }))
    .sort((una, otra) => (una.clave < otra.clave ? -1 : una.clave > otra.clave ? 1 : 0))
    .slice(tamano * (indice - 1), tamano * indice)
    .map(({ ruta }) => ruta);
}

export function registrarReparto(trozo, { suite, cwd, ficheros, elegidos }, directorio = process.env.CAUCE_TEST_SHARD_DIR) {
  if (!directorio) return undefined;
  mkdirSync(directorio, { recursive: true });
  const nombre = suite.replaceAll(/[^\w.-]+/gu, '_');
  for (let orden = 1; ; orden += 1) {
    const ruta = join(directorio, `reparto-${String(trozo.indice)}-${nombre}-${String(orden)}.json`);
    const registro = {
      trozo: `${String(trozo.indice)}/${String(trozo.total)}`, suite, orden, cwd,
      ficheros: [...ficheros].sort(), elegidos: [...elegidos].sort(),
    };
    try {
      writeFileSync(ruta, `${JSON.stringify(registro)}\n`, { flag: 'wx' });
      return ruta;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
}

function leerRegistros(directorio) {
  if (!existsSync(directorio)) return [];
  return readdirSync(directorio).filter((nombre) => REGISTRO.test(nombre)).sort()
    .map((nombre) => ({ nombre, ...JSON.parse(readFileSync(join(directorio, nombre), 'utf8')) }));
}

function problemasDeInvocacion(clave, grupo, total) {
  const problemas = [];
  const indices = grupo.map((registro) => Number(registro.trozo.split('/')[0])).sort((a, b) => a - b);
  const esperados = Array.from({ length: total }, (_, posicion) => posicion + 1);
  if (indices.join(',') !== esperados.join(',')) {
    problemas.push(`${clave}: la vieron los trozos [${indices.join(',')}] y debian verla los ${String(total)}`);
  }
  const [primero] = grupo;
  const ficheros = JSON.stringify(primero.ficheros);
  if (grupo.some((registro) => registro.cwd !== primero.cwd || JSON.stringify(registro.ficheros) !== ficheros)) {
    problemas.push(`${clave}: los trozos no vieron el mismo conjunto de ficheros, asi que no partieron lo mismo`);
    return problemas;
  }
  const todos = new Set(primero.ficheros);
  const vistos = new Map();
  for (const registro of grupo) {
    for (const fichero of registro.elegidos) {
      if (!todos.has(fichero)) problemas.push(`${clave}: el trozo ${registro.trozo} corrio ${fichero}, que no es de la invocacion`);
      vistos.set(fichero, (vistos.get(fichero) ?? 0) + 1);
    }
  }
  const repetidos = [...vistos].filter(([, veces]) => veces > 1).map(([fichero]) => fichero);
  const ausentes = primero.ficheros.filter((fichero) => !vistos.has(fichero));
  if (repetidos.length > 0) problemas.push(`${clave}: ficheros corridos mas de una vez: ${repetidos.join(', ')}`);
  if (ausentes.length > 0) problemas.push(`${clave}: ficheros que ningun trozo corrio: ${ausentes.join(', ')}`);
  return problemas;
}

/** Proves that N shards ran every file of every recorded invocation exactly once. */
export function verificarReparto(directorio, total, suitesEsperadas = []) {
  const registros = leerRegistros(directorio);
  const grupos = new Map();
  const problemas = [];
  for (const registro of registros) {
    if (Number(registro.trozo.split('/')[1]) !== total) {
      problemas.push(`${registro.nombre}: es del reparto ${registro.trozo} y la fusion es de ${String(total)} trozos`);
      continue;
    }
    const clave = `${registro.suite} #${String(registro.orden)} (${registro.cwd || '.'})`;
    grupos.set(clave, [...(grupos.get(clave) ?? []), registro]);
  }
  const resumen = [];
  for (const [clave, grupo] of grupos) {
    problemas.push(...problemasDeInvocacion(clave, grupo, total));
    const reparto = [...grupo].sort((uno, otro) => uno.trozo.localeCompare(otro.trozo, 'en', { numeric: true }))
      .map((registro) => String(registro.elegidos.length)).join('+');
    resumen.push(`${clave}: ${String(grupo[0].ficheros.length)} ficheros = ${reparto}`);
  }
  for (const suite of suitesEsperadas) {
    if (!registros.some((registro) => registro.suite === suite)) {
      problemas.push(`${suite}: ningun trozo registro su reparto; un corredor que ignora CAUCE_TEST_SHARD la correria entera en cada trozo`);
    }
  }
  return { problemas, resumen };
}

function ficherosDeLaOrden(argumentos) {
  return argumentos.filter((argumento) => FICHERO_DE_PRUEBA.test(argumento) && existsSync(argumento));
}

function esperar(hijo) {
  const reenviar = (senal) => hijo.kill(senal);
  for (const senal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(senal, reenviar);
  return new Promise((settle, fail) => {
    hijo.on('error', fail);
    hijo.on('close', (codigo, senal) => settle(codigo ?? (senal ? 128 : 1)));
  });
}

export async function ejecutar([comando, ...argumentos]) {
  if (comando === undefined) throw new Error('uso: node scripts/trozos.mjs ejecutar <comando> <argumentos...>');
  const trozo = leerTrozo();
  let finales = argumentos;
  if (trozo) {
    const cwd = process.cwd();
    const relativa = (fichero) => relative(cwd, resolve(fichero));
    const ficheros = ficherosDeLaOrden(argumentos).map(relativa).sort();
    if (ficheros.length === 0) {
      process.stderr.write(`trozos: ninguna prueba en '${[comando, ...argumentos].join(' ')}'\n`);
      return 1;
    }
    const elegidos = new Set(elegir(ficheros, trozo));
    registrarReparto(trozo, {
      suite: process.env.CAUCE_TEST_SUITE ?? 'manual', cwd: relative(RAIZ, cwd), ficheros, elegidos,
    });
    process.stdout.write(`trozo ${String(trozo.indice)}/${String(trozo.total)}: ${String(elegidos.size)} de ${String(ficheros.length)} ficheros de prueba\n`);
    if (elegidos.size === 0) return 0;
    const deLaOrden = new Set(ficherosDeLaOrden(argumentos));
    finales = argumentos.filter((argumento) => !deLaOrden.has(argumento) || elegidos.has(relativa(argumento)));
  }
  return esperar(spawn(comando, finales, { stdio: 'inherit', env: sinTrozo() }));
}

const invocadoDirecto = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invocadoDirecto) {
  const [orden, ...resto] = process.argv.slice(2);
  if (orden !== 'ejecutar') {
    process.stderr.write('uso: node scripts/trozos.mjs ejecutar <comando> <argumentos...>\n');
    process.exitCode = 2;
  } else {
    process.exitCode = await ejecutar(resto);
  }
}
