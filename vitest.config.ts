import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const RAIZ = fileURLToPath(new URL('.', import.meta.url));

const paquete = (nombre: string): string => resolve(RAIZ, `packages/${nombre}/src/index.ts`);

const EXCLUSIONES = ['**/node_modules/**', '**/dist/**', '.claude/**'];

const SUITES_RAPIDAS = [
  'tests/unit',
  'packages/protocol/test',
  'packages/store/src',
  'packages/mcp-fleet-monitor',
  'services/dispatcher/test',
  'services/gateway/src',
  'services/telegram-bridge/test',
  'services/terminal-relay/src'
];

const DIRECTORIOS_DE_DATOS = [
  'packages/store/test',
  'tests/store-hardening',
  'tests/gateway-hardening',
  'tests/integration',
  'tests/e2e',
  'tests/terminal-pty'
];

const FICHEROS_DE_DATOS = [
  'services/dispatcher/test/index.test.ts',
  'services/dispatcher/test/metrics.test.ts',
  'services/gateway/src/health-progress.test.ts',
  'services/gateway/src/health-schema037.pg.test.ts',
  'services/gateway/src/secret-handoff.plugin.test.ts',
  'services/telegram-bridge/test/ingress-postgres.test.ts',
  'services/telegram-bridge/test/postgres.test.ts'
];

// Suite paths are written against the repository, but vitest roots itself at the working
// directory: `pnpm --filter @cauce/gateway test` runs `vitest run src` from services/gateway.
const bajoLaRaizDeLaCorrida = (rutas: readonly string[]): string[] =>
  rutas
    .map((ruta) => relative(process.cwd(), resolve(RAIZ, ruta)))
    .filter((ruta) => !ruta.startsWith('..'));

const patrones = (rutas: readonly string[]): string[] =>
  rutas.map((ruta) => `${ruta === '' ? '' : `${ruta}/`}**/*.test.?(c|m)[jt]s?(x)`);

const RAPIDAS = bajoLaRaizDeLaCorrida(SUITES_RAPIDAS);
const CARPETAS_DE_DATOS = bajoLaRaizDeLaCorrida(DIRECTORIOS_DE_DATOS);
const SUELTOS_DE_DATOS = bajoLaRaizDeLaCorrida(FICHEROS_DE_DATOS);
const DE_DATOS = [...CARPETAS_DE_DATOS, ...SUELTOS_DE_DATOS];

const COMANDOS = new Set(['run', 'watch', 'dev', 'related', 'bench', 'list', 'init']);

const filtrosDeLaCorrida = (): string[] => {
  const sueltos = process.argv.slice(2).filter((argumento) => !argumento.startsWith('-'));
  const primero = sueltos[0];
  return primero !== undefined && COMANDOS.has(primero) ? sueltos.slice(1) : sueltos;
};

const absoluta = (ruta: string): string => resolve(process.cwd(), ruta);

const dentroDe = (hijo: string, padre: string): boolean =>
  hijo === padre || hijo.startsWith(`${padre}/`);

const esRapida = (filtro: string): boolean =>
  RAPIDAS.some((ruta) => dentroDe(absoluta(filtro), absoluta(ruta)));

const alcanzaDatos = (filtro: string): boolean =>
  DE_DATOS.some(
    (ruta) =>
      ruta.includes(filtro)
      || dentroDe(absoluta(filtro), absoluta(ruta))
      || dentroDe(absoluta(ruta), absoluta(filtro))
  );

const filtros = filtrosDeLaCorrida();
// One worker pool per run (not per project) and filters match as path substrings: parallel only
// when no filter can reach a data directory or a data file (`src/health` reaches two), else serial.
const EN_PARALELO =
  DE_DATOS.length === 0 ||
  (filtros.length > 0 && filtros.every((filtro) => esRapida(filtro) && !alcanzaDatos(filtro)));

const proyectos = [
  {
    extends: true as const,
    test: {
      name: 'rapido',
      include: patrones(RAPIDAS),
      exclude: [...EXCLUSIONES, ...SUELTOS_DE_DATOS]
    }
  },
  {
    extends: true as const,
    test: { name: 'datos', include: [...patrones(CARPETAS_DE_DATOS), ...SUELTOS_DE_DATOS] }
  }
].filter((proyecto) => proyecto.test.include.length > 0);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@cauce\/protocol$/, replacement: paquete('protocol') },
      { find: /^@cauce\/store$/, replacement: paquete('store') },
      { find: /^@cauce\/adapter-sdk$/, replacement: paquete('adapter-sdk') }
    ]
  },
  test: {
    globals: true,
    pool: 'forks',
    fileParallelism: EN_PARALELO,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    // Agent worktrees live under .claude/ INSIDE the checkout: a naive collection ran the suite
    // once per worktree, against stale code and with the ports and containers of the real run.
    exclude: EXCLUSIONES,
    ...(proyectos.length > 0 ? { projects: proyectos } : {}),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: [
        'packages/*/src/**/*.ts',
        'services/*/src/**/*.ts',
        'console/src/**/*.ts',
        'console/src/**/*.tsx'
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/test/**',
        '**/migrations/**',
        '**/__mocks__/**',
        '.claude/**'
      ]
    }
  }
});
