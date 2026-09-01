import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const coverageScript = join(repository, 'scripts/cobertura.mjs');
const temporaryRoots: string[] = [];
const summary = JSON.stringify({
  total: {
    lines: { total: 10, covered: 8, skipped: 0, pct: 80 },
    branches: { total: 5, covered: 4, skipped: 0, pct: 80 },
    functions: { total: 2, covered: 2, skipped: 0, pct: 100 },
    statements: { total: 10, covered: 8, skipped: 0, pct: 80 },
  },
  '/tmp/source.ts': {
    lines: { total: 50, covered: 40, skipped: 0, pct: 80 },
    branches: { total: 5, covered: 4, skipped: 0, pct: 80 },
    functions: { total: 2, covered: 2, skipped: 0, pct: 100 },
    statements: { total: 50, covered: 40, skipped: 0, pct: 80 },
  },
});

interface Fixture {
  readonly log: string;
  readonly staleOutputs: string[];
  run: (environment?: Record<string, string>) => {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cauce-coverage-fail-closed-'));
  temporaryRoots.push(root);
  const bin = join(root, 'bin');
  const script = join(root, 'scripts/cobertura.mjs');
  const log = join(root, 'commands.log');
  const staleOutputs = [
    join(root, 'packages/protocol/dist/stale.js'),
    join(root, 'packages/mcp-fleet-monitor/dist/stale.js'),
    join(root, 'packages/adapter-sdk/dist/stale.js'),
  ];
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(dirname(script), { recursive: true }),
    mkdir(join(root, 'console'), { recursive: true }),
    ...staleOutputs.map((path) => mkdir(dirname(path), { recursive: true })),
  ]);
  await copyFile(coverageScript, script);
  await Promise.all(staleOutputs.map((path) => writeFile(path, 'stale output\n')));

  await executable(join(bin, 'pnpm'), [
    '#!/bin/sh',
    'printf \'pnpm:%s\\n\' "$*" >> "$CAUCE_FAKE_LOG"',
    'if [ "$*" = "$CAUCE_FAKE_FAIL_BUILD" ]; then',
    '  printf \'synthetic build failure\\n\' >&2',
    '  exit "${CAUCE_FAKE_BUILD_EXIT:-7}"',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  await executable(join(bin, 'npx'), [
    '#!/bin/sh',
    'printf \'npx:%s:%s\\n\' "$PWD" "$*" >> "$CAUCE_FAKE_LOG"',
    "output=''",
    'for argument in "$@"; do',
    '  case "$argument" in',
    '    --coverage.reportsDirectory=*) output=${argument#*=} ;;',
    '  esac',
    'done',
    'domain=root',
    'case "$PWD" in',
    '  */console) domain=console ;;',
    'esac',
    'if [ "$CAUCE_FAKE_OMIT_REPORT" != "$domain" ]; then',
    '  mkdir -p "$output"',
    '  printf \'%s\\n\' "$CAUCE_FAKE_COVERAGE_JSON" > "$output/coverage-summary.json"',
    'fi',
    'if [ "$domain" = root ]; then',
    '  exit "${CAUCE_FAKE_ROOT_EXIT:-0}"',
    'fi',
    'exit "${CAUCE_FAKE_CONSOLE_EXIT:-0}"',
    '',
  ].join('\n'));
  await executable(join(bin, 'node'), [
    '#!/bin/sh',
    'printf \'node:%s\\n\' "$*" >> "$CAUCE_FAKE_LOG"',
    "printf '%s\\n' '# source.ts | 90.00 | 80.00 | 70.00 |' '# all files | 90.00 | 80.00 | 70.00 |'",
    "printf 'synthetic adapter diagnostic\\n' >&2",
    'exit "${CAUCE_FAKE_ADAPTER_EXIT:-0}"',
    '',
  ].join('\n'));

  return {
    log,
    staleOutputs,
    run: (environment = {}) => {
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          CAUCE_FAKE_LOG: log,
          CAUCE_FAKE_COVERAGE_JSON: summary,
          ...environment,
        },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

describe('cobertura fail-closed', () => {
  it('mantiene el resultado verde cuando builds, suites e informes son válidos', async () => {
    const test = await fixture();
    const result = test.run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CIFRA FUSIONADA  lineas 16/20 = 80.00%');
    expect(result.stdout).toContain('lineas 90.00%   ramas 80.00%   funciones 70.00%');
    expect(result.stderr).toBe('');
  });

  it('borra dist antes de compilar y no ejecuta suites cuando un build falla', async () => {
    const test = await fixture();
    const result = test.run({ CAUCE_FAKE_FAIL_BUILD: 'prepare:runtime', CAUCE_FAKE_BUILD_EXIT: '7' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('synthetic build failure');
    expect(result.stderr).toContain('build de protocol falló (exit 7)');
    expect(await readFile(test.log, 'utf8')).toBe('pnpm:prepare:runtime\n');
    for (const stale of test.staleOutputs) expect(existsSync(stale)).toBe(false);
  });

  it('conserva la tabla parcial pero falla si la suite raíz termina roja', async () => {
    const test = await fixture();
    const result = test.run({ CAUCE_FAKE_ROOT_EXIT: '9' });
    const commands = await readFile(test.log, 'utf8');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('CIFRA FUSIONADA  lineas 16/20 = 80.00%');
    expect(result.stdout).toContain('lineas 90.00%   ramas 80.00%   funciones 70.00%');
    expect(result.stderr).toContain('COBERTURA FALLIDA');
    expect(result.stderr).toContain('suite raíz falló (exit 9)');
    expect(commands.match(/^npx:/gmu)).toHaveLength(2);
    expect(commands).toContain('node:--enable-source-maps');
  });

  it('no acredita el adapter aunque Node alcance a imprimir cobertura antes de fallar', async () => {
    const test = await fixture();
    const result = test.run({ CAUCE_FAKE_ADAPTER_EXIT: '4' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('lineas 90.00%   ramas 80.00%   funciones 70.00%');
    expect(result.stderr).toContain('synthetic adapter diagnostic');
    expect(result.stderr).toContain('suite adapter-sdk falló (exit 4)');
  });

  it('falla si una suite verde no deja el informe que dice haber medido', async () => {
    const test = await fixture();
    const result = test.run({ CAUCE_FAKE_OMIT_REPORT: 'root' });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/raiz\s+NO DISPONIBLE/u);
    expect(result.stdout).toContain('CIFRA FUSIONADA  NO DISPONIBLE');
    expect(result.stderr).toContain('COBERTURA FALLIDA');
    expect(result.stderr).toContain('la corrida no dejó');
  });
});
