import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The production compiler may only consume files copied into the Docker build stage.
 * Use `tsc --listFiles` so this follows compiler resolution instead of duplicating its glob model.
 */

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');

function copySources(line: string): string[] {
  const copy = /^COPY\s+(.+)$/u.exec(line.trim());
  const argumentsText = copy?.[1];
  if (argumentsText === undefined) return [];

  const tokens = argumentsText.split(/\s+/u).filter(token => token.length > 0);
  if (tokens.some(token => token === '--from' || token.startsWith('--from='))) return [];

  const paths = tokens.filter(token => !token.startsWith('--'));
  return paths.length < 2 ? [] : paths.slice(0, -1);
}

function imageBuildSources(): string[] {
  const dockerfile = readFileSync(resolve(REPOSITORY_ROOT, 'deploy/Dockerfile'), 'utf8');
  const stage = dockerfile.slice(
    dockerfile.indexOf('AS build'),
    dockerfile.indexOf('AS production-dependencies'),
  );
  const sources = new Set<string>();
  for (const line of stage.split('\n')) {
    for (const source of copySources(line)) sources.add(source);
  }
  return [...sources];
}

function sourceCoversFile(source: string, file: string): boolean {
  const normalized = source.replace(/^\.\//u, '').replace(/\/$/u, '') || '.';
  if (normalized === '.') return true;
  if (normalized.includes('*') || normalized.includes('?') || normalized.includes('[')) {
    return globSync(normalized, { cwd: REPOSITORY_ROOT })
      .some(match => sourceCoversFile(match, file));
  }
  const absolute = resolve(REPOSITORY_ROOT, normalized);
  if (!existsSync(absolute)) return false;
  return statSync(absolute).isDirectory()
    ? file.startsWith(`${normalized}/`)
    : file === normalized;
}

function isCopiedBuildFile(file: string, sources: string[]): boolean {
  return sources.some(source => sourceCoversFile(source, file));
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
    const sources = imageBuildSources();
    expect(sources).toContain('packages');
    expect(sources).toContain('services');
    expect(isCopiedBuildFile('tests/unit/parametros.test.ts', sources)).toBe(false);

    const outside = buildFiles().filter(file => !isCopiedBuildFile(file, sources));
    expect(outside, `estos ficheros no existen dentro de la imagen: ${outside.join(', ')}`).toEqual([]);
  }, 120_000);

  it('reconoce rutas COPY exactas y directorios sin cubrir pruebas no copiadas', () => {
    const sources = imageBuildSources();
    expect(sources).toContain('tests/terminal-pty/certs.mjs');
    expect(sources).toContain('tests/terminal-pty/certs.d.mts');
    expect(isCopiedBuildFile('tests/terminal-pty/certs.d.mts', sources)).toBe(true);
    expect(sourceCoversFile('tests/terminal-pty', 'tests/terminal-pty/certs.d.mts')).toBe(true);
    expect(sourceCoversFile('tests/terminal-pty/certs.mjs', 'tests/terminal-pty/certs.d.mts')).toBe(false);
    expect(isCopiedBuildFile('tests/unit/parametros.test.ts', sources)).toBe(false);
  });

  it('no trata rutas de otra etapa como fuentes del host', () => {
    expect(copySources('COPY --chown=node:node --from=build /app/dist ./dist')).toEqual([]);
    expect(copySources('COPY --from=build --chown=node:node /app/dist ./dist')).toEqual([]);
    expect(copySources('COPY packages/protocol ./packages/protocol')).toEqual(['packages/protocol']);
  });

  // Negative control: an empty compiler listing would make the subset assertion pass falsely.
  it('el listado del compilador no viene vacío', () => {
    const files = buildFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('packages/protocol/src/schemas.ts');
  }, 120_000);
});
