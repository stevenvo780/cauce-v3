/*
 * Coverage of the root domain measured in N shards and fused before the ratchet.
 *
 * Each shard runs a slice of the root vitest files (CAUCE_TEST_SHARD) and keeps the istanbul map
 * of its json reporter, with paths relative to its own checkout: the shards run in different
 * worktrees, and an absolute key would make one source file count once per shard. The fusion
 * merges the maps under the fusing checkout, so a line is covered when any shard covered it and
 * every file keeps the line set it has unsharded (v8 builds the statement map from the source).
 *
 * The console and adapter-sdk domains are not split: each runs whole in one shard.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

function libCobertura() {
  const requerir = createRequire(import.meta.url);
  return createRequire(requerir.resolve('@vitest/coverage-v8/package.json'))('istanbul-lib-coverage');
}

export function asignacionDeDominios(total) {
  return { consola: 1, adapter: Math.min(2, total) };
}

function relativizar(objeto, raiz) {
  const salida = {};
  for (const [clave, valor] of Object.entries(objeto)) {
    if (clave === 'total') {
      salida[clave] = valor;
      continue;
    }
    if (!clave.startsWith(`${raiz}/`)) throw new Error(`la cobertura trae ${clave}, fuera del arbol ${raiz}`);
    const relativa = clave.slice(raiz.length + 1);
    salida[relativa] = typeof valor?.path === 'string' ? { ...valor, path: relativa } : valor;
  }
  return salida;
}

function absolutizar(objeto, raiz) {
  const salida = {};
  for (const [clave, valor] of Object.entries(objeto)) {
    const absoluta = clave === 'total' ? clave : `${raiz}/${clave}`;
    salida[absoluta] = typeof valor?.path === 'string' ? { ...valor, path: absoluta } : valor;
  }
  return salida;
}

function textoDeFallo(fallo) {
  return fallo instanceof Error ? fallo.message : fallo ? String(fallo) : null;
}

function escribir(ruta, datos) {
  const contenido = `${JSON.stringify(datos)}\n`;
  writeFileSync(ruta, contenido);
  return createHash('sha256').update(contenido).digest('hex');
}

function guardarDominio(resultado, guardarValor) {
  if (resultado === undefined) return null;
  if (resultado.error) return { error: textoDeFallo(resultado.error) };
  return { ...guardarValor(resultado.valor), ms: resultado.valor.ms, fallo: textoDeFallo(resultado.valor.fallo) };
}

/** Writes what one shard measured; returns the files written with their sha256. */
export function guardarTrozo(directorio, trozo, raiz, resultados, salidaRaiz) {
  mkdirSync(directorio, { recursive: true });
  const huellas = [];
  const raizDelTrozo = guardarDominio(resultados.raiz, () => {
    const nombre = `cobertura-raiz-${String(trozo.indice)}.json`;
    const mapa = JSON.parse(readFileSync(join(salidaRaiz, 'coverage-final.json'), 'utf8'));
    huellas.push([nombre, escribir(join(directorio, nombre), relativizar(mapa, raiz))]);
    return { mapa: nombre };
  });
  const meta = {
    trozo: `${String(trozo.indice)}/${String(trozo.total)}`,
    raiz: raizDelTrozo,
    consola: guardarDominio(resultados.consola, (valor) => ({ resumen: relativizar(valor.resumen, raiz) })),
    adapter: guardarDominio(resultados.adapter, ({ lineas, ramas, funciones, ficheros }) => ({ lineas, ramas, funciones, ficheros })),
  };
  const nombre = `cobertura-trozo-${String(trozo.indice)}.json`;
  huellas.push([nombre, escribir(join(directorio, nombre), meta)]);
  return huellas;
}

export function resumenDeMapa(mapa) {
  const resumen = { total: mapa.getCoverageSummary().toJSON() };
  for (const fichero of mapa.files().sort()) resumen[fichero] = mapa.fileCoverageFor(fichero).toSummary().toJSON();
  return resumen;
}

export function fusionarMapas(mapas) {
  const fusion = libCobertura().createCoverageMap({});
  for (const mapa of mapas) fusion.merge(mapa);
  return fusion;
}

function errorDe(texto) {
  return texto === null || texto === undefined ? undefined : new Error(texto);
}

function dominioEntero(nombre, metas, raiz, leerValor) {
  const con = metas.filter((meta) => meta[nombre] !== null && meta[nombre] !== undefined);
  if (con.length !== 1) {
    return { problema: `${nombre}: lo midieron ${String(con.length)} trozos y debia medirlo exactamente uno` };
  }
  const guardado = con[0][nombre];
  if (guardado.error) return { resultado: { error: new Error(guardado.error) } };
  return { resultado: { valor: { ...leerValor(guardado, raiz), ms: guardado.ms, fallo: errorDe(guardado.fallo) } } };
}

function fusionarRaiz(directorio, metas, raiz) {
  const rotos = metas.filter((meta) => meta.raiz?.error);
  if (rotos.length > 0) {
    return { error: new Error(`la suite raiz no dejo cobertura en ${rotos.map((meta) => `${meta.trozo}: ${meta.raiz.error}`).join('; ')}`) };
  }
  const mapas = metas.map((meta) => absolutizar(JSON.parse(readFileSync(join(directorio, meta.raiz.mapa), 'utf8')), raiz));
  const fallos = metas.filter((meta) => meta.raiz.fallo).map((meta) => `${meta.trozo}: ${meta.raiz.fallo}`);
  return {
    valor: {
      resumen: resumenDeMapa(fusionarMapas(mapas)),
      ms: Math.max(...metas.map((meta) => meta.raiz.ms)),
      fallo: fallos.length === 0 ? undefined : new Error(`suite raíz falló en el trozo ${fallos.join('; ')}`),
    },
  };
}

/** Reads the N shards back as the three domain results the unsharded run produces. */
export function leerTrozos(directorio, total, raiz) {
  const problemas = [];
  const huellas = [];
  const metas = [];
  for (let indice = 1; indice <= total; indice += 1) {
    const ruta = join(directorio, `cobertura-trozo-${String(indice)}.json`);
    if (!existsSync(ruta)) {
      problemas.push(`falta la medicion del trozo ${String(indice)}/${String(total)} (${ruta})`);
      continue;
    }
    const contenido = readFileSync(ruta);
    huellas.push([ruta, createHash('sha256').update(contenido).digest('hex')]);
    const meta = JSON.parse(contenido.toString('utf8'));
    if (meta.trozo !== `${String(indice)}/${String(total)}`) problemas.push(`${ruta} es del trozo ${String(meta.trozo)}`);
    metas.push(meta);
  }
  const sinMedir = new Error(`la fusion no tiene los ${String(total)} trozos: ${problemas.join('; ')}`);
  const raizFusionada = problemas.length === 0 ? fusionarRaiz(directorio, metas, raiz) : { error: sinMedir };
  const consola = dominioEntero('consola', metas, raiz, (guardado) => ({ resumen: absolutizar(guardado.resumen, raiz) }));
  const adapter = dominioEntero('adapter', metas, raiz, ({ lineas, ramas, funciones, ficheros }) => ({ lineas, ramas, funciones, ficheros }));
  for (const dominio of [consola, adapter]) if (dominio.problema) problemas.push(dominio.problema);
  return {
    problemas, huellas,
    resultadoRaiz: raizFusionada,
    resultadoConsola: consola.resultado ?? { error: new Error(consola.problema) },
    resultadoAdapter: adapter.resultado ?? { error: new Error(adapter.problema) },
  };
}
