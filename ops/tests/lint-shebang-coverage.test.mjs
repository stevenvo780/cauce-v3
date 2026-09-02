#!/usr/bin/env node
// Ruff only collects *.py/*.pyi, so an extensionless Python guard stays unanalysed unless ruff.toml
// names it in extend-include. That list rots both ways: arrivals unlinted under a green gate, and
// dangling entries for files that are gone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ficherosConShebang, ficherosVersionados } from '../scripts/ficheros-con-shebang.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function guardiasEnElArbol() {
  const relativos = new Map(ficherosVersionados(root).map(fichero => [path.join(root, fichero), fichero]));
  return ficherosConShebang('python', [...relativos.keys()]).map(absoluto => relativos.get(absoluto));
}

// Minimal TOML slice instead of a dependency: only the prelude before the first [table] header is
// read, so a same-named key inside [lint] can never be mistaken for the top-level one.
function extendIncludeDeRuff() {
  const texto = readFileSync(path.join(root, 'ruff.toml'), 'utf8');
  const preludio = texto.split(/^\s*\[/mu)[0];
  const arreglo = /^\s*extend-include\s*=\s*\[([^\]]*)\]/mu.exec(preludio);
  assert.ok(arreglo, 'ruff.toml has no top-level extend-include array');
  return [...arreglo[1].matchAll(/"([^"]+)"|'([^']+)'/gu)].map(par => par[1] ?? par[2]).sort();
}

// extend-include is inert for a path ruff never visits: the guards must sit under lint:py's roots.
function raicesDeLintPy() {
  const paquete = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const orden = paquete.scripts['lint:py'];
  assert.match(orden, /^ruff check /u, 'lint:py ya no empieza por `ruff check`');
  return orden.split(/\s+/u).slice(2).filter(raiz => !raiz.startsWith('-'));
}

const declarados = extendIncludeDeRuff();
const encontrados = guardiasEnElArbol();
const raices = raicesDeLintPy();
const fuera = encontrados.filter(ruta => !raices.some(raiz => ruta.startsWith(`${raiz}/`)));

assert.equal(new Set(declarados).size, declarados.length, 'ruff.toml extend-include tiene entradas repetidas');
assert.deepEqual(declarados, encontrados,
  `ruff.toml extend-include no coincide con el arbol: sobran [${declarados.filter(r => !encontrados.includes(r)).join(', ')}], faltan [${encontrados.filter(r => !declarados.includes(r)).join(', ')}]`);
assert.deepEqual(fuera, [], `guardias fuera de las raices de lint:py [${raices.join(' ')}]: ${fuera.join(', ')}`);

console.log(`lint-shebang-coverage ok: ${declarados.length} guardias python sin extension, todas en ruff.toml`);
