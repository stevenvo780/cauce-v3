#!/usr/bin/env node
// Genera docs/grafo.md: el grafo de dependencias del repo (quien referencia a quien).
// Fuentes de aristas: imports TS/JS, package.json scripts, compose, Dockerfile, systemd, invocaciones sh/py.
// Deterministico y regenerable: `pnpm grafo`.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const esFuente = f => /\.(ts|tsx|mjs|cjs|py|sh|yaml|yml|json|conf)$/.test(f) && !f.includes('node_modules');
const contenido = {};
for (const f of files) { if (esFuente(f)) try { contenido[f] = readFileSync(f, 'utf8'); } catch {} }

// nodo = directorio de primer nivel, o segundo nivel para services/packages/apps/ops/deploy
function nodo(f) {
  const p = f.split('/');
  if (p.length === 1) return '(raiz)';
  if (['services', 'packages', 'apps'].includes(p[0])) return p.slice(0, 2).join('/');
  if (p[0] === 'ops' || p[0] === 'deploy' || p[0] === 'tests' || p[0] === 'scripts' || p[0] === 'docs') return p.length > 2 ? p.slice(0, 2).join('/') : p[0];
  return p[0];
}

const aristas = new Map(); // "A -> B" => count
const entrantes = new Map(); // fichero => count de referencias entrantes
function arista(fDesde, fHasta, peso = 1) {
  entrantes.set(fHasta, (entrantes.get(fHasta) ?? 0) + 1);
  const a = nodo(fDesde), b = nodo(fHasta);
  if (a === b) return;
  const k = `${a} --> ${b}`;
  aristas.set(k, (aristas.get(k) ?? 0) + peso);
}

// indice por basename para resolver referencias por nombre
const porBase = new Map();
for (const f of files) {
  const b = f.split('/').pop();
  if (!porBase.has(b)) porBase.set(b, []);
  porBase.get(b).push(f);
}

const IMPORT_RE = /from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)|import\(['"]([^'"]+)['"]\)/g;
const ALIAS = { '@cauce/protocol': 'packages/protocol', '@cauce/store': 'packages/store', '@cauce/adapter-sdk': 'packages/adapter-sdk' };
for (const [f, txt] of Object.entries(contenido)) {
  if (/\.(ts|tsx|mjs|cjs)$/.test(f)) {
    for (const m of txt.matchAll(IMPORT_RE)) {
      const esp = m[1] ?? m[2] ?? m[3];
      if (!esp) continue;
      if (ALIAS[esp]) { arista(f, ALIAS[esp] + '/src/index.ts'); continue; }
      if (esp.startsWith('.')) {
        const base = dirname(f);
        let ruta = new URL(esp, 'file:///' + base + '/').pathname.slice(1);
        for (const cand of [ruta, ruta.replace(/\.js$/, '.ts'), ruta.replace(/\.js$/, '.tsx'), ruta + '.ts', ruta + '.tsx', ruta + '/index.ts', ruta + '/index.tsx', ruta.replace(/\.js$/, '.mjs')])
          if (cand in contenido || files.includes(cand)) { arista(f, cand); break; }
      }
    }
  }
  // referencias por ruta textual (compose, Dockerfile, sh, py, json, systemd): cualquier ruta tracked mencionada
  for (const m of txt.matchAll(/[\w.\/-]*\/(?:[\w.-]+\.(?:mjs|sh|py|yaml|yml|json|conf|ts))/g)) {
    let r = m[0].replace(/^\.\//, '').replace(/^\/app\//, '').replace(/^\.\.\//, '');
    if (r !== f && files.includes(r)) arista(f, r);
  }
}

// metricas
const dirs = new Map();
for (const f of files) { if (!esFuente(f)) continue; const n = nodo(f); dirs.set(n, (dirs.get(n) ?? 0) + 1); }
const huerfanos = Object.keys(contenido).filter(f =>
  !(entrantes.get(f) > 0) && !/\.(test|spec)\.|^tests\/|\/tests?\//.test(f) &&
  !/(main|index)\.(ts|mjs)$|^scripts\/|^ordenes|^plan|^docs|\.md$|^\.github|package\.json|tsconfig|eslint|vitest/.test(f));
const hubs = [...entrantes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
const top = [...aristas.entries()].sort((a, b) => b[1] - a[1]);

let md = `# Grafo de dependencias del repo\n\nGenerado por \`pnpm grafo\` (determinista — regenerar tras reordenar). Nodo = directorio; arista A→B = ficheros de A que referencian ficheros de B (peso = nº de referencias).\n\n## El grafo (aristas con peso ≥2)\n\n\`\`\`mermaid\ngraph LR\n`;
for (const [k, v] of top) if (v >= 2) md += `  ${k.replace(/[\/.()-]/g, '_').replace(' --> ', ' --> ')}\n`.replace(/(\w+) --> (\w+)/, `$1 -->|${v}| $2`);
md += '```\n\n## Aristas completas\n\n| Desde | Hacia | Refs |\n|---|---|---|\n';
for (const [k, v] of top) { const [a, b] = k.split(' --> '); md += `| ${a} | ${b} | ${v} |\n`; }
md += '\n## Hubs (los 15 ficheros más referenciados)\n\n';
for (const [f, n] of hubs) md += `- ${f} ← ${n}\n`;
md += `\n## Candidatos huérfanos (fuente sin UNA referencia entrante detectada — verificar antes de tocar)\n\n`;
for (const f of huerfanos.sort()) md += `- ${f}\n`;
md += `\n## Tamaño por nodo\n\n| Nodo | Ficheros |\n|---|---|\n`;
for (const [d, n] of [...dirs.entries()].sort((a, b) => b[1] - a[1])) md += `| ${d} | ${n} |\n`;
writeFileSync('docs/grafo.md', md);
console.log(`grafo: ${aristas.size} aristas dir-a-dir, ${huerfanos.length} candidatos huerfanos, ${hubs[0]?.[0]} es el hub mayor -> docs/grafo.md`);
