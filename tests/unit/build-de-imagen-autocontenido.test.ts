import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The production build must compile ONLY files the image build stage actually copies.
 *
 * `deploy/Dockerfile` copies `packages`, `services`, `console` and `vitest.config.ts` into the
 * build stage — never the root `tests/` tree. A source file that `tsconfig.build.json` compiles
 * and that imports from `tests/` therefore typechecks locally and dies inside `docker build`,
 * where the module does not exist. That is exactly how `packages/store/test/postgres-suite.ts`
 * broke a deploy: the name-based excludes (the root `tests` dir, and the glob for files ending in
 * `.test.ts`) did not match a helper named `postgres-suite.ts` under `packages/store/test/`.
 *
 * Running the real `tsc --listFiles` is the point: it asks the compiler which files it would
 * compile rather than re-implementing its include/exclude resolution, which is what a
 * hand-rolled glob check would get subtly wrong.
 */

const RAIZ = resolve(import.meta.dirname, '../..');

/** Roots the image build stage copies, from `deploy/Dockerfile`. */
function raicesCopiadasPorLaImagen(): string[] {
  const dockerfile = readFileSync(resolve(RAIZ, 'deploy/Dockerfile'), 'utf8');
  const stage = dockerfile.slice(
    dockerfile.indexOf('AS build'),
    dockerfile.indexOf('AS production-dependencies'),
  );
  const raices = new Set<string>();
  for (const line of stage.split('\n')) {
    const copia = /^COPY\s+(?!--from)(.+)$/.exec(line.trim());
    const fuentes = copia?.[1];
    if (fuentes === undefined) continue;
    // The last token of a COPY is the destination; everything before it is a source.
    const tokens = fuentes.split(/\s+/).filter(Boolean).slice(0, -1);
    for (const token of tokens) raices.add(primerSegmento(token));
  }
  return [...raices];
}

/** First path segment, which is the tree root a COPY brings in (or a file at the root). */
function primerSegmento(path: string): string {
  return path.split('/')[0] ?? path;
}

/** Files inside the tree that `tsc -p tsconfig.build.json` would compile. */
function ficherosDelBuild(): string[] {
  const salida = execFileSync(
    'node',
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--listFiles', '--noEmit'],
    { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return salida.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith(RAIZ) && !line.includes('/node_modules/'))
    .map(line => relative(RAIZ, line));
}

describe('el build de la imagen es autocontenido', () => {
  it('no compila ningún fichero fuera de lo que el Dockerfile copia', () => {
    const raices = raicesCopiadasPorLaImagen();
    expect(raices).toContain('packages');
    expect(raices).toContain('services');
    // The guard only means something if the root `tests/` tree is genuinely absent from the stage.
    expect(raices).not.toContain('tests');

    const fuera = ficherosDelBuild().filter(file => !raices.includes(primerSegmento(file)));
    expect(fuera, `estos ficheros no existen dentro de la imagen: ${fuera.join(', ')}`).toEqual([]);
  }, 120_000);

  /**
   * NEGATIVE CONTROL: without it, a `--listFiles` that returned nothing (a `tsc` invocation that
   * silently failed, say) would make the assertion above pass while proving nothing at all.
   */
  it('el listado del compilador no viene vacío', () => {
    const ficheros = ficherosDelBuild();
    expect(ficheros.length).toBeGreaterThan(100);
    expect(ficheros).toContain('packages/protocol/src/schemas.ts');
  }, 120_000);
});
