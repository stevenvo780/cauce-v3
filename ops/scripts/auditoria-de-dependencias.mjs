#!/usr/bin/env node
// `pnpm audit` alone goes red on the first high without an upstream patch and stays red, so the
// reader learns to ignore the nightly. This gate keeps the red meaningful: every tolerated
// advisory is named in ops/auditoria-permitida.json with a reason and a review date, an entry the
// audit no longer reports is itself a failure, and so is an entry past its review date.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LISTA = process.env.CAUCE_AUDITORIA_PERMITIDOS || join(RAIZ, 'ops/auditoria-permitida.json');
const ENTRADA = process.env.CAUCE_AUDITORIA_ENTRADA || '';
const HOY = process.env.CAUCE_AUDITORIA_HOY || new Date().toISOString().slice(0, 10);
const GRAVES = new Set(['high', 'critical']);
const CAMPOS = ['advisory', 'paquete', 'razon', 'revisar_antes_de'];
const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function salidaDeAudit() {
  if (ENTRADA) return readFileSync(ENTRADA, 'utf8');
  // pnpm audit exits 1 whenever it finds anything, so the status says nothing: the JSON decides.
  const corrida = spawnSync('pnpm', ['audit', '--json', '--prod'], {
    cwd: RAIZ,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (corrida.error) throw new Error(`no se pudo ejecutar pnpm audit: ${corrida.error.message}`);
  if (!corrida.stdout.trim()) {
    throw new Error(`pnpm audit no devolvio JSON (codigo ${corrida.status}): ${(corrida.stderr || '').trim().slice(0, 400)}`);
  }
  return corrida.stdout;
}

function avisos(texto) {
  let documento;
  try {
    documento = JSON.parse(texto);
  } catch {
    throw new Error('la salida de pnpm audit no es JSON');
  }
  if (documento === null || typeof documento !== 'object') throw new Error('la salida de pnpm audit no es un objeto');
  const crudos = documento.advisories;
  if (crudos === undefined && documento.metadata !== undefined) return [];
  if (crudos === null || typeof crudos !== 'object') throw new Error('la salida de pnpm audit no trae "advisories"');
  return Object.values(crudos).map((aviso) => {
    const rutas = (aviso.findings ?? []).flatMap((hallazgo) => hallazgo.paths ?? []);
    const claves = [aviso.github_advisory_id, aviso.id].filter((valor) => valor !== undefined && valor !== null).map(String);
    return {
      claves: new Set(claves),
      advisory: aviso.github_advisory_id ?? String(aviso.id ?? 'sin-identificador'),
      paquete: aviso.module_name ?? 'sin-paquete',
      severidad: aviso.severity ?? 'unknown',
      titulo: aviso.title ?? '',
      url: aviso.url ?? '',
      rutas,
    };
  });
}

function permitidos() {
  let documento;
  try {
    documento = JSON.parse(readFileSync(LISTA, 'utf8'));
  } catch (error) {
    throw new Error(`no se pudo leer la lista de permitidos ${LISTA}: ${error.message}`);
  }
  const entradas = documento?.permitidos;
  if (!Array.isArray(entradas)) throw new Error(`${LISTA} debe tener un array "permitidos"`);
  const vistos = new Set();
  for (const entrada of entradas) {
    if (entrada === null || typeof entrada !== 'object' || Array.isArray(entrada)) {
      throw new Error(`${LISTA}: cada permiso debe ser un objeto`);
    }
    const claves = Object.keys(entrada).sort();
    if (claves.join(',') !== [...CAMPOS].sort().join(',')) {
      throw new Error(`${LISTA}: un permiso declara ${claves.join(', ') || 'nada'} y debe declarar exactamente ${CAMPOS.join(', ')}`);
    }
    for (const campo of CAMPOS) {
      if (typeof entrada[campo] !== 'string' || entrada[campo].trim() === '') {
        throw new Error(`${LISTA}: el permiso ${entrada.advisory ?? '(sin advisory)'} tiene "${campo}" vacio o no textual`);
      }
    }
    if (!FORMATO_FECHA.test(entrada.revisar_antes_de)) {
      throw new Error(`${LISTA}: el permiso ${entrada.advisory} usa una fecha de revision que no es AAAA-MM-DD`);
    }
    if (vistos.has(entrada.advisory)) throw new Error(`${LISTA}: el advisory ${entrada.advisory} esta permitido dos veces`);
    vistos.add(entrada.advisory);
  }
  return entradas;
}

function describir(aviso) {
  const extra = aviso.rutas.length > 1 ? ` (+${aviso.rutas.length - 1} rutas)` : '';
  const ruta = aviso.rutas[0] ?? 'sin ruta';
  return [
    `  ${aviso.severidad.padEnd(8)} ${aviso.paquete}  ${aviso.advisory}`,
    `      ruta: ${ruta}${extra}`,
    `      ${aviso.titulo}${aviso.url ? `  ${aviso.url}` : ''}`,
  ].join('\n');
}

function main() {
  const encontrados = avisos(salidaDeAudit());
  const lista = permitidos();
  const problemas = [];
  const tolerados = [];

  for (const permiso of lista) {
    const aviso = encontrados.find((candidato) => candidato.claves.has(permiso.advisory));
    if (aviso === undefined) {
      problemas.push(`permiso que sobra: ${permiso.advisory} (${permiso.paquete}) ya no aparece en la auditoria; retiralo de ${LISTA}`);
      continue;
    }
    if (aviso.paquete !== permiso.paquete) {
      problemas.push(`permiso mal dirigido: ${permiso.advisory} nombra "${permiso.paquete}" y la auditoria lo reporta sobre "${aviso.paquete}"`);
      continue;
    }
    if (permiso.revisar_antes_de < HOY) {
      problemas.push(`permiso vencido: ${permiso.advisory} (${permiso.paquete}) debia revisarse antes de ${permiso.revisar_antes_de}`);
      continue;
    }
    tolerados.push({ aviso, permiso });
  }

  const permitidoPorAdvisory = new Set(lista.map((permiso) => permiso.advisory));
  const graves = encontrados.filter(
    (aviso) => GRAVES.has(aviso.severidad) && ![...aviso.claves].some((clave) => permitidoPorAdvisory.has(clave)),
  );

  const conteo = new Map();
  for (const aviso of encontrados) conteo.set(aviso.severidad, (conteo.get(aviso.severidad) ?? 0) + 1);
  const resumen = [...conteo.entries()].sort().map(([severidad, cuantos]) => `${cuantos} ${severidad}`).join(', ');
  process.stdout.write(`auditoria de dependencias (--prod): ${encontrados.length} advisories${resumen ? ` — ${resumen}` : ''}\n`);

  if (tolerados.length > 0) {
    process.stdout.write(`\npermitidos vigentes (${tolerados.length}):\n`);
    for (const { aviso, permiso } of tolerados) {
      process.stdout.write(`${describir(aviso)}\n      permitido hasta ${permiso.revisar_antes_de}: ${permiso.razon}\n`);
    }
  }

  if (graves.length > 0) {
    process.stdout.write(`\nadvisories high/critical sin permiso (${graves.length}):\n`);
    for (const aviso of graves) process.stdout.write(`${describir(aviso)}\n`);
    problemas.push(`${graves.length} advisories high/critical sin permiso en ${LISTA}`);
  }

  if (problemas.length > 0) {
    process.stdout.write('\n');
    for (const problema of problemas) process.stdout.write(`FALLO: ${problema}\n`);
    return 1;
  }
  process.stdout.write('auditoria: VERDE (ningun high/critical fuera de la lista, y la lista no tiene permisos de sobra)\n');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`auditoria de dependencias: ${error.message}\n`);
  process.exitCode = 2;
}
