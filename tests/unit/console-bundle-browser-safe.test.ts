import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/* The console bundle runs in the browser. Anything it imports at runtime from packages/protocol must not
   reach a `node:*` module, or `vite build` fails (docker build, stage `build`) while the local checkout,
   with stale dist files, still passes. The root index re-exports canonical/sealing/health-server (node:crypto,
   node:http), so the console may only use the node-free subpaths. */
const root = resolve(import.meta.dirname, '../..');
const protocolSrc = join(root, 'packages/protocol/src');
const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?'([^']+)'/g;

function runtimeSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const m of text.matchAll(IMPORT)) if (!m[2]) found.push(m[3]!);
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}

const exportsMap = (JSON.parse(readFileSync(join(root, 'packages/protocol/package.json'), 'utf8')) as {
  exports: Record<string, { types: string }>;
}).exports;

function protocolEntry(specifier: string): string | undefined {
  const key = specifier === '@cauce/protocol' ? '.' : `.${specifier.slice('@cauce/protocol'.length)}`;
  const types = exportsMap[key]?.types;
  return types ? resolve(root, 'packages/protocol', types) : undefined;
}

function nodeImportsReachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const hits: string[] = [];
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeSpecifiers(file)) {
      if (spec.startsWith('node:')) hits.push(`${relative(root, file)} imports ${spec}`);
      else if (spec.startsWith('.')) stack.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  }
  return hits;
}

describe('console bundle imports from packages/protocol', () => {
  const entries = new Map<string, string[]>(); // protocol entry file -> console files using it
  const offenders: string[] = [];
  for (const file of sourceFiles(join(root, 'console/src'))) {
    for (const spec of runtimeSpecifiers(file)) {
      let entry: string | undefined;
      if (spec === '@cauce/protocol') {
        offenders.push(`${relative(root, file)} imports the root '@cauce/protocol' (use a subpath)`);
        continue;
      }
      if (spec.startsWith('@cauce/protocol/')) {
        entry = protocolEntry(spec);
        if (!entry) offenders.push(`${relative(root, file)} imports unknown subpath ${spec}`);
      } else if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
        if (target.startsWith(protocolSrc + '/')) entry = target;
      }
      if (entry) entries.set(entry, [...(entries.get(entry) ?? []), relative(root, file)]);
    }
  }

  it('never imports the node-dependent root index at runtime', () => {
    expect(offenders).toEqual([]);
  });

  it('reaches no node:* module from any protocol entry it imports', () => {
    const hits = [...entries.keys()].flatMap((entry) => nodeImportsReachableFrom(entry).map((hit) => `${relative(root, entry)}: ${hit}`));
    expect(hits).toEqual([]);
    expect(entries.size).toBeGreaterThan(0);
  });
});
