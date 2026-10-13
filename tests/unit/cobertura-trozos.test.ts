import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositorio = fileURLToPath(new URL('../../', import.meta.url));
const PAQUETES = [
  'packages/protocol/src', 'packages/store/src', 'packages/mcp-fleet-monitor/src',
  'services/dispatcher/src', 'services/gateway/src', 'services/telegram-bridge/src',
  'services/terminal-relay/src', 'services/decisiones/src',
];
const raices: string[] = [];

function ejecutable(ruta: string, lineas: string[]): void {
  writeFileSync(ruta, `${lineas.join('\n')}\n`, { mode: 0o755 });
}

/** Two statements on lines 1 and 2 of one file per root package; `golpes` says which one ran. */
function mapa(raiz: string, golpes: [number, number]): Record<string, unknown> {
  return Object.fromEntries(PAQUETES.map((paquete) => {
    const ruta = `${raiz}/${paquete}/modulo.ts`;
    return [ruta, {
      path: ruta, fnMap: {}, f: {}, branchMap: {}, b: {},
      statementMap: {
        0: { start: { line: 1, column: 0 }, end: { line: 1, column: 9 } },
        1: { start: { line: 2, column: 0 }, end: { line: 2, column: 9 } },
      },
      s: { 0: golpes[0], 1: golpes[1] },
    }];
  }));
}

function fixture(golpesDelTrozo2: [number, number] = [0, 1]) {
  const raiz = mkdtempSync(join(tmpdir(), 'cauce-cobertura-trozos-'));
  raices.push(raiz);
  const bin = join(raiz, 'bin');
  const mapas = join(raiz, 'mapas');
  const trozos = join(raiz, 'trozos');
  const log = join(raiz, 'ordenes.log');
  for (const directorio of [bin, mapas, join(raiz, 'scripts'), join(raiz, 'console'), join(raiz, 'packages/adapter-sdk')]) {
    mkdirSync(directorio, { recursive: true });
  }
  for (const script of ['cobertura.mjs', 'cobertura-trozos.mjs', 'trozos.mjs']) {
    copyFileSync(join(repositorio, 'scripts', script), join(raiz, 'scripts', script));
  }
  symlinkSync(join(repositorio, 'node_modules'), join(raiz, 'node_modules'));
  writeFileSync(join(raiz, 'scripts/cobertura-base.json'), JSON.stringify({
    ...Object.fromEntries(PAQUETES.map((paquete) => [paquete, { lineas_pct: 100 }])),
    'console/src': { lineas_pct: 80 }, 'packages/adapter-sdk': { lineas_pct: 90 },
  }));
  writeFileSync(join(mapas, 'raiz-1.json'), JSON.stringify(mapa(raiz, [1, 0])));
  writeFileSync(join(mapas, 'raiz-2.json'), JSON.stringify(mapa(raiz, golpesDelTrozo2)));
  const consola = {
    total: { lines: { total: 10, covered: 8, skipped: 0, pct: 80 }, branches: { total: 4, covered: 3, skipped: 0, pct: 75 } },
    [`${raiz}/console/src/vista.tsx`]: { lines: { total: 10, covered: 8, skipped: 0, pct: 80 }, branches: { total: 4, covered: 3, skipped: 0, pct: 75 } },
  };
  writeFileSync(join(mapas, 'consola.json'), JSON.stringify(consola));
  ejecutable(join(bin, 'pnpm'), ['#!/bin/sh', 'exit 0']);
  ejecutable(join(bin, 'npx'), [
    '#!/bin/sh',
    'printf \'npx %s trozo=%s suite=%s\\n\' "${PWD##*/}" "${CAUCE_TEST_SHARD:-}" "${CAUCE_TEST_SUITE:-}" >> "$FAKE_LOG"',
    'for argumento in "$@"; do case "$argumento" in --coverage.reportsDirectory=*) salida=${argumento#*=} ;; esac; done',
    'mkdir -p "$salida"',
    'if [ "${PWD##*/}" = console ]; then cp "$FAKE_MAPAS/consola.json" "$salida/coverage-summary.json"; exit 0; fi',
    'indice=${CAUCE_TEST_SHARD%%/*}',
    'cp "$FAKE_MAPAS/raiz-$indice.json" "$salida/coverage-final.json"',
    'printf \'{"total":{}}\\n\' > "$salida/coverage-summary.json"',
    '"$FAKE_NODE" --input-type=module -e "import { elegir, leerTrozo, registrarReparto } from \'$FAKE_RAIZ/scripts/trozos.mjs\'; const t = leerTrozo(); const f = [\'a.test.ts\', \'b.test.ts\', \'c.test.ts\']; registrarReparto(t, { suite: process.env.CAUCE_TEST_SUITE, cwd: \'\', ficheros: f, elegidos: elegir(f, t) });"',
    'exit "${FAKE_RAIZ_EXIT:-0}"',
  ]);
  ejecutable(join(bin, 'node'), [
    '#!/bin/sh',
    'printf \'node adapter trozo=%s\\n\' "${CAUCE_TEST_SHARD:-}" >> "$FAKE_LOG"',
    "printf '%s\\n' '# fuente.ts | 90.00 | 80.00 | 70.00 |' '# all files | 90.00 | 80.00 | 70.00 |'",
  ]);
  const correr = (entorno: Record<string, string>) => spawnSync(process.execPath, [join(raiz, 'scripts/cobertura.mjs'), '--trinquete'], {
    cwd: raiz, encoding: 'utf8',
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_LOG: log, FAKE_MAPAS: mapas, FAKE_RAIZ: raiz,
      FAKE_NODE: process.execPath, CAUCE_TEST_SHARD_DIR: trozos, ...entorno,
    },
  });
  const ordenes = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { raiz, trozos, correr, ordenes };
}

afterEach(() => {
  for (const raiz of raices.splice(0)) rmSync(raiz, { recursive: true, force: true });
});

describe('cobertura en trozos', () => {
  it('cada trozo mide su parte de la raiz y un dominio entero; la fusion une las lineas y aplica el trinquete', () => {
    const prueba = fixture();
    for (const trozo of ['1/2', '2/2']) {
      const corrida = prueba.correr({ CAUCE_TEST_SHARD: trozo });
      expect(corrida.status, corrida.stderr).toBe(0);
      expect(corrida.stdout).toContain(`cobertura — trozo ${trozo} (el trinquete se aplica en la fusion)`);
      expect(corrida.stdout).not.toContain('trinquete de cobertura (lineas por paquete');
    }
    expect(prueba.ordenes()).toEqual([
      'npx raiz-de-prueba trozo=1/2 suite=coverage:raiz'.replace('raiz-de-prueba', prueba.raiz.split('/').at(-1) ?? ''),
      'npx console trozo= suite=',
      'npx raiz-de-prueba trozo=2/2 suite=coverage:raiz'.replace('raiz-de-prueba', prueba.raiz.split('/').at(-1) ?? ''),
      'node adapter trozo=',
    ]);
    const guardado = JSON.parse(readFileSync(join(prueba.trozos, 'cobertura-raiz-1.json'), 'utf8')) as Record<string, { path: string }>;
    expect(Object.keys(guardado)).toContain('packages/protocol/src/modulo.ts');
    expect(Object.values(guardado).every((fichero) => !fichero.path.startsWith('/'))).toBe(true);

    const fusion = prueba.correr({ CAUCE_TEST_SHARD_MERGE: '2' });
    expect(fusion.status, `${fusion.stdout}\n${fusion.stderr}`).toBe(0);
    expect(fusion.stdout).toContain('reparto coverage:raiz #1 (.): 3 ficheros = 2+1');
    expect(fusion.stdout).toContain('raiz en 2 trozos fusionados');
    expect(fusion.stdout).toContain('CIFRA FUSIONADA  lineas 24/26 = 92.31%');
    expect(fusion.stdout).toContain('(aprox.)');
    expect(fusion.stdout).toMatch(/packages\/protocol\/src\s+OK\s+base 100\.00%\s+medido 100\.00%/u);
    expect(fusion.stdout).toContain('VERDE: ningun paquete cae mas de 0.20 puntos');
    expect(readdirSync(prueba.trozos).sort()).toEqual([
      'cobertura-raiz-1.json', 'cobertura-raiz-2.json', 'cobertura-trozo-1.json', 'cobertura-trozo-2.json',
      'reparto-1-coverage_raiz-1.json', 'reparto-2-coverage_raiz-1.json',
    ]);
  });

  it('una linea que ningun trozo cubrio baja el paquete y el trinquete sale rojo', () => {
    const prueba = fixture([0, 0]);
    for (const trozo of ['1/2', '2/2']) expect(prueba.correr({ CAUCE_TEST_SHARD: trozo }).status).toBe(0);
    const fusion = prueba.correr({ CAUCE_TEST_SHARD_MERGE: '2' });
    expect(fusion.status).toBe(1);
    expect(fusion.stderr).toContain('TRINQUETE DE COBERTURA ROJO');
    expect(fusion.stderr).toContain('packages/protocol/src: lineas cae de 100.00% a 50.00%');
  });

  it('sin todos los trozos, o con la raiz roja en uno, la fusion no acredita nada', () => {
    const incompleta = fixture();
    expect(incompleta.correr({ CAUCE_TEST_SHARD: '1/2' }).status).toBe(0);
    const sinTrozo = incompleta.correr({ CAUCE_TEST_SHARD_MERGE: '2' });
    expect(sinTrozo.status).toBe(1);
    expect(sinTrozo.stderr).toContain('falta la medicion del trozo 2/2');
    expect(sinTrozo.stderr).toContain('adapter: lo midieron 0 trozos y debia medirlo exactamente uno');

    const roja = fixture();
    expect(roja.correr({ CAUCE_TEST_SHARD: '1/2' }).status).toBe(0);
    const trozoRojo = roja.correr({ CAUCE_TEST_SHARD: '2/2', FAKE_RAIZ_EXIT: '1' });
    expect(trozoRojo.status).toBe(1);
    expect(trozoRojo.stdout).toContain('raiz      ROJA: suite raíz falló (exit 1)');
    const fusion = roja.correr({ CAUCE_TEST_SHARD_MERGE: '2' });
    expect(fusion.status).toBe(1);
    expect(fusion.stderr).toContain('suite raíz falló en el trozo 2/2: suite raíz falló (exit 1)');
    expect(fusion.stderr).toContain('NO DISPONIBLE (la suite terminó roja');
  });
});
