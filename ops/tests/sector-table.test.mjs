// G9: every versioned first/second-level directory must match a row of the sector table in
// ordenes/00-PROTOCOLO.md — ownerless code is the gateway to collisions.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tabla = readFileSync(resolve(root, 'ordenes/00-PROTOCOLO.md'), 'utf8');

const patrones = [...tabla.matchAll(/`([^`]+?)`/g)].map((m) => m[1])
  .filter((p) => p.includes('/') || p.endsWith('**'))
  .flatMap((p) => {
    const braces = p.match(/^(.*)\{([^}]+)\}(.*)$/);
    if (braces) return braces[2].split(',').map((x) => braces[1] + x + braces[3]);
    return [p];
  })
  .map((p) => p.replace(/\/?\*\*$/, '').replace(/\/$/, ''));

const cubierto = (dir) => patrones.some((p) => dir === p || dir.startsWith(p + '/') || p.startsWith(dir + '/'));

const ficheros = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const dirs = new Set();
for (const f of ficheros) {
  const partes = f.split('/');
  if (partes.length < 2) continue; // loose files at the root: integrator's by convention
  dirs.add(partes[0]);
  if (partes.length > 2) dirs.add(partes[0] + '/' + partes[1]);
}
// zones the table covers by global convention, not by their own row
const EXENTOS = new Set(['docs', 'ordenes', 'plan-reestructura', 'tests', 'deploy', '.github', '.claude']);

const huerfanos = [...dirs].filter((d) => !EXENTOS.has(d.split('/')[0]) && !cubierto(d)).sort();
assert.deepEqual(huerfanos, [],
  `directorios versionados sin fila en la tabla de sectores de 00-PROTOCOLO.md: ${huerfanos.join(', ')}`);
console.log(`sector-table ok: ${dirs.size} directorios, todos con dueño o exentos por convenio`);
