import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Los paquetes del monorepo se resuelven a ESTE árbol, no al del checkout vecino.
 *
 * `node_modules/` de cada worktree es un ENLACE al del checkout principal, y dentro de él
 * `@cauce/protocol` es a su vez un enlace RELATIVO (`../../packages/protocol`) que se resuelve
 * desde la ruta real del enlace — o sea, desde el checkout principal. Sin estos alias, todo
 * `import ... from '@cauce/*'` de un worktree carga el código de OTRA RAMA.
 *
 * Medido el 2026-08-25 en `/workspace/wt-ed-gateway`: `packages/protocol/src/schemas.ts` de este
 * árbol y el del principal son inodos distintos (15239919 vs 28193992). `tests/unit/agent-profile.test.ts`
 * daba 21 de 21 en rojo probando código que estaba presente y correcto en este árbol, y un recurso
 * recién añadido al esquema seguía «sin existir» después de reconstruir el `dist`.
 *
 * La dirección peligrosa es la contraria y no tiene síntoma: una rama que BORRA una guarda sale
 * verde porque la guarda sigue viva en el árbol del vecino. `tests/unit/paquetes-de-este-arbol.test.ts`
 * lo comprueba por identidad de objeto, con su control negativo.
 *
 * Apuntan a `src/` y no a `dist/`: el `dist` es un artefacto que hay que acordarse de reconstruir
 * antes de cada corrida, y una prueba que mide un `dist` viejo es la misma clase de fallo que este
 * alias viene a cerrar — sólo que más difícil de ver, porque ahí las dos copias sí son del mismo
 * árbol.
 */
const paquete = (nombre: string): string =>
  fileURLToPath(new URL(`./packages/${nombre}/src/index.ts`, import.meta.url));

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
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    // Agent worktrees live under .claude/worktrees/ INSIDE the checkout, so a bare
    // `vitest run tests/...` collected every branch's copy of the same file and ran the suite
    // once per worktree — against stale code, with the ports and containers of the real run.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    coverage: { reporter: ['text', 'json-summary'] }
  }
});
