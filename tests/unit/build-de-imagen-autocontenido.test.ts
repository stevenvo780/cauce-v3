import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The production compiler may only consume files copied into the Docker build stage.
 * Use `tsc --listFiles` so this follows compiler resolution instead of duplicating its glob model.
 */

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');

function imageBuildRoots(): string[] {
  const dockerfile = readFileSync(resolve(REPOSITORY_ROOT, 'deploy/Dockerfile'), 'utf8');
  const stage = dockerfile.slice(
    dockerfile.indexOf('AS build'),
    dockerfile.indexOf('AS production-dependencies'),
  );
  const roots = new Set<string>();
  for (const line of stage.split('\n')) {
    const copy = /^COPY\s+(?!--from)(.+)$/.exec(line.trim());
    const sources = copy?.[1];
    if (sources === undefined) continue;
    // The last token of a COPY is the destination; everything before it is a source.
    const tokens = sources.split(/\s+/).filter(Boolean).slice(0, -1);
    for (const token of tokens) roots.add(firstSegment(token));
  }
  return [...roots];
}

function firstSegment(path: string): string {
  return path.split('/')[0] ?? path;
}

function buildFiles(): string[] {
  const output = execFileSync(
    'node',
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--listFiles', '--noEmit'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return output.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith(REPOSITORY_ROOT) && !line.includes('/node_modules/'))
    .map(line => relative(REPOSITORY_ROOT, line));
}

describe('el build de la imagen es autocontenido', () => {
  it('no compila ningún fichero fuera de lo que el Dockerfile copia', () => {
    const roots = imageBuildRoots();
    expect(roots).toContain('packages');
    expect(roots).toContain('services');
    // The guard only means something if the root `tests/` tree is genuinely absent from the stage.
    expect(roots).not.toContain('tests');

    const outside = buildFiles().filter(file => !roots.includes(firstSegment(file)));
    expect(outside, `estos ficheros no existen dentro de la imagen: ${outside.join(', ')}`).toEqual([]);
  }, 120_000);

  // Negative control: an empty compiler listing would make the subset assertion pass falsely.
  it('el listado del compilador no viene vacío', () => {
    const files = buildFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('packages/protocol/src/schemas.ts');
  }, 120_000);
});
