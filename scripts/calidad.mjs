#!/usr/bin/env node
// Gate determinista de calidad con TRINQUETE. Reglas:
//  1) lineas: ningun fichero fuente >800 lineas salvo los del baseline, que ademas NO pueden crecer.
//  2) fechas: ninguna fecha AAAA-MM-DD en lineas de comentario salvo el conteo del baseline (no puede crecer).
// `--update` regenera el baseline desde el estado actual (solo lo usa el integrador tras revisar).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error('calidad: PROHIBIDO correr el gate como root (deja residuos root:root que bloquean a las instancias). Usa: su stev -c "umask 022 && ..."');
  process.exit(1);
}

const BASE_PATH = 'scripts/calidad-base.json';
const MAX = 800;
const EXTS = /\.(ts|tsx|mjs|py|sh)$/;
const EXCLUIR = /^(packages\/store\/migrations\/|docs\/|node_modules\/)|\.sql$|\.md$/;
const COMENTARIO = /^\s*(\/\/|#|\*|\/\*)/;
const FECHA = /\b20\d{2}-\d{2}-\d{2}\b/;

const todos = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const conShebang = f => {
  if (/\.[a-z]+$/.test(f) || f.includes('.')) return false;
  try { return /^#!.*\b(bash|sh|python3?)\b/.test(readFileSync(f, 'utf8').slice(0, 80)); } catch { return false; }
};
const ficheros = todos.filter(f => !EXCLUIR.test(f) && (EXTS.test(f) || conShebang(f)));

const estado = {};
for (const f of ficheros) {
  let texto; try { texto = readFileSync(f, 'utf8'); } catch { continue; }
  const lineas = texto.split('\n');
  const fechas = lineas.filter(l => COMENTARIO.test(l) && FECHA.test(l)).length;
  const comentarios = lineas.filter(l => COMENTARIO.test(l)).length;
  estado[f] = { lineas: lineas.length, fechas, comentarios };
}

if (process.argv.includes('--update')) {
  const base = { lineas: {}, fechas: {}, comentarios: {} };
  for (const [f, v] of Object.entries(estado)) {
    if (v.lineas > MAX) base.lineas[f] = v.lineas;
    if (v.fechas > 0) base.fechas[f] = v.fechas;
    if (v.comentarios > 0) base.comentarios[f] = v.comentarios;
  }
  writeFileSync(BASE_PATH, JSON.stringify(base, null, 1) + '\n');
  console.log(`calidad: baseline actualizado (${Object.keys(base.lineas).length} ficheros >${MAX}, ${Object.keys(base.fechas).length} con fechas en comentarios)`);
  process.exit(0);
}

let base = { lineas: {}, fechas: {}, comentarios: {} };
try { base = JSON.parse(readFileSync(BASE_PATH, 'utf8')); } catch { /* sin baseline: todo estricto */ }

const fallos = [];
for (const [f, v] of Object.entries(estado)) {
  const tope = base.lineas[f] ?? MAX;
  if (v.lineas > tope) fallos.push(`${f}: ${v.lineas} lineas (tope ${tope}${base.lineas[f] ? ', trinquete' : ''})`);
  const topeF = base.fechas[f] ?? 0;
  if (v.fechas > topeF) fallos.push(`${f}: ${v.fechas} fechas en comentarios (tope ${topeF})`);
  // Comentarios: los existentes solo pueden BAJAR; un fichero nuevo tolera hasta 15% de densidad.
  const topeC = base.comentarios?.[f] ?? Math.ceil(v.lineas * 0.15);
  if (v.comentarios > topeC) fallos.push(`${f}: ${v.comentarios} lineas de comentario (tope ${topeC}${f in (base.comentarios ?? {}) ? ', trinquete' : ', 15% para nuevos'})`);
}
for (const f of Object.keys(base.lineas)) if (!(f in estado)) delete base.lineas[f];
const rancias = [];
for (const [f, tope] of Object.entries(base.lineas)) {
  if (f in estado && estado[f].lineas < tope * 0.9) rancias.push(`${f}: baseline ${tope} pero mide ${estado[f].lineas} (poda con --update)`);
}
if (rancias.length) console.error('calidad: AVISO trinquete rancio\n' + rancias.map(x => '  ~ ' + x).join('\n'));

const CITA = /([\w./-]+\.(?:ts|tsx|mjs|py|sh|sql|yaml|json)):(\d+)\b/g;
const versionados = new Set(todos);
const citasRotas = [];
for (const [f, ] of Object.entries(estado)) {
  let texto; try { texto = readFileSync(f, 'utf8'); } catch { continue; }
  for (const l of texto.split('\n')) {
    if (!COMENTARIO.test(l)) continue;
    for (const m of l.matchAll(CITA)) {
      const [ , ruta, num ] = m;
      if (!versionados.has(ruta)) {
        if ([...versionados].some(v => v.endsWith('/' + ruta))) continue;
        if (ruta.includes('/')) citasRotas.push(`${f}: cita ${ruta}:${num} — fichero inexistente`);
      } else if (estado[ruta] && Number(num) > estado[ruta].lineas) {
        citasRotas.push(`${f}: cita ${ruta}:${num} — el fichero tiene ${estado[ruta].lineas} lineas`);
      }
    }
  }
}
if (citasRotas.length) console.error(`calidad: AVISO ${citasRotas.length} citas fichero:linea rotas (G7, pasara a ERROR)\n` + citasRotas.slice(0, 12).map(x => '  ~ ' + x).join('\n'));

if (fallos.length) {
  console.error('calidad: ROJO\n' + fallos.map(x => '  - ' + x).join('\n'));
  console.error('Regla: partir el fichero o limpiar las fechas. El baseline solo baja (integrador: --update tras revisar).');
  process.exit(1);
}
console.log(`calidad: VERDE (${ficheros.length} ficheros; trinquete: ${Object.keys(base.lineas).length} >800, ${Object.keys(base.fechas).length} con fechas, ${Object.keys(base.comentarios ?? {}).length} con comentarios acotados)`);
