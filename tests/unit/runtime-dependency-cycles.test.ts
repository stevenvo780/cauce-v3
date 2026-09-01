import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const cycleScript = join(repository, 'scripts/check-runtime-cycles.mjs');
const temporaryRoots: string[] = [];

interface GateResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runFixture(files: Readonly<Record<string, string>>): Promise<GateResult> {
  const root = await mkdtemp(join(tmpdir(), 'cauce-runtime-cycles-'));
  temporaryRoots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  const result = spawnSync(process.execPath, [cycleScript], { cwd: root, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('runtime dependency cycle gate', () => {
  it('acepta un grafo acíclico y omite tests, fixtures y dist', async () => {
    const result = await runFixture({
      'packages/example/src/a.ts': "import { b } from './b.js'; export const a = b;\n",
      'packages/example/src/b.ts': 'export const b = 1;\n',
      'packages/example/test/hidden.ts': "import './hidden-peer.js';\n",
      'packages/example/test/hidden-peer.ts': "import './hidden.js';\n",
      'services/example/src/ignored.fixture.ts': "import './ignored-peer.js';\n",
      'services/example/src/ignored-peer.ts': "import './ignored.fixture.js';\n",
      'console/dist/stale.js': "import './stale-peer.js';\n",
      'console/dist/stale-peer.js': "import './stale.js';\n",
    });

    expect(result).toEqual({
      status: 0,
      stdout: 'runtime-cycles: VERDE (3 archivos, 1 dependencias, 0 ciclos)\n',
      stderr: '',
    });
  });

  it('falla con un ciclo de dos archivos resuelto mediante index y una reexportación', async () => {
    const result = await runFixture({
      'services/example/src/a.ts': "export { b } from './b/index.js';\n",
      'services/example/src/b/index.ts': "import { a } from '../a.js'; export const b = a;\n",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('runtime-cycles: ROJO (1 ciclos, 2 archivos)');
    expect(result.stderr).toContain('services/example/src/a.ts -> services/example/src/b/index.ts -> services/example/src/a.ts');
    expect(result.stderr).toContain('SCC (2)');
  });

  it('falla con un ciclo de tres archivos y resuelve TSX, JS y JSX', async () => {
    const result = await runFixture({
      'console/src/a.ts': "import { b } from './b.js'; export const a = b;\n",
      'console/src/b.tsx': "import { c } from './c.jsx'; export const b = c;\n",
      'console/src/c.jsx': "import { a } from './a.js'; export const c = a;\n",
      'console/src/independent.js': 'export const independent = true;\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('console/src/a.ts -> console/src/b.tsx -> console/src/c.jsx -> console/src/a.ts');
    expect(result.stderr).toContain('SCC (3)');
  });

  it('ignora import type, export type y tipos inline cuando no hay binding de valor', async () => {
    const result = await runFixture({
      'packages/example/src/a.ts': [
        "import type { B } from './b.js';",
        "export type { B as PublicB } from './b.js';",
        "import { type B as InlineB } from './b.js';",
        'export const a = 1;',
        'export type A = B | InlineB;',
        '',
      ].join('\n'),
      'packages/example/src/b.ts': "import { a } from './a.js'; export interface B { value: typeof a }\n",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2 archivos, 1 dependencias, 0 ciclos');
    expect(result.stderr).toBe('');
  });

  it('cuenta un import mixto cuando conserva al menos un binding de valor', async () => {
    const result = await runFixture({
      'packages/example/src/a.ts': "import { type B, b } from './b.js'; export const a = b; export type A = B;\n",
      'packages/example/src/b.ts': "import { a } from './a.js'; export const b = a; export interface B {}\n",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/example/src/a.ts -> packages/example/src/b.ts -> packages/example/src/a.ts');
  });

  it('resuelve entradas de paquetes del workspace y detecta ciclos entre paquetes', async () => {
    const result = await runFixture({
      'packages/alpha/package.json': '{"name":"@fixture/alpha"}\n',
      'packages/alpha/src/index.ts': "import { beta } from '@fixture/beta'; export const alpha = beta;\n",
      'packages/beta/package.json': '{"name":"@fixture/beta"}\n',
      'packages/beta/src/index.ts': "import { alpha } from '@fixture/alpha'; export const beta = alpha;\n",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'packages/alpha/src/index.ts -> packages/beta/src/index.ts -> packages/alpha/src/index.ts',
    );
  });

  it('se puede importar sin ejecutar el CLI', () => {
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(cycleScript).href)})`,
    ], { encoding: 'utf8' });

    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it('mantiene el repositorio sin ciclos runtime internos', () => {
    const result = spawnSync(process.execPath, [cycleScript], { cwd: repository, encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^runtime-cycles: VERDE \(\d+ archivos, \d+ dependencias, 0 ciclos\)\n$/u);
    expect(result.stderr).toBe('');
  });
});
