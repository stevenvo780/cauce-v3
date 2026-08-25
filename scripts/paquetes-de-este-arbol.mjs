#!/usr/bin/env node
/**
 * HACE QUE `@cauce/*` SE RESUELVA AL ÁRBOL EN EL QUE ESTÁS, y no al del worktree de al lado.
 *
 * Se usa como gancho de resolución de Node:
 *
 *     node --import ../../scripts/paquetes-de-este-arbol.mjs --test dist/test/*.test.js
 *
 * ── El fallo, medido el 2026-08-25 ───────────────────────────────────────────────────────────
 *
 * En `/workspace/wt-integra`, `packages/adapter-sdk/node_modules` NO es un directorio: es un
 * enlace a `/workspace/cauce-v3/packages/adapter-sdk/node_modules`. O sea que ese `node_modules`
 * lo COMPARTEN los cuarenta worktrees del disco. Y dentro estaba
 *
 *     @cauce/protocol -> /workspace/wt-perfil/packages/protocol
 *
 * una ruta ABSOLUTA a un tercer árbol, puesta a mano. La suite del adaptador de ESTE worktree
 * llevaba desde entonces midiendo el protocolo de `wt-perfil`; y como el `node_modules` es
 * compartido, el que lo "arreglaba" para su rama se lo rompía a las otras treinta y nueve.
 *
 * ── Por qué un gancho y no un enlace ─────────────────────────────────────────────────────────
 *
 * Escribir el enlace bien es imposible por construcción: hay UN solo `node_modules/@cauce` para
 * cuarenta árboles, así que cualquier valor que se le ponga está mal para treinta y nueve. El
 * gancho no toca el disco: resuelve dentro del proceso, y cada corrida queda atada a su propio
 * árbol sin pisarle nada a nadie.
 *
 * ── Por qué no bastaba el alias de vitest ────────────────────────────────────────────────────
 *
 * `vitest.config.ts` ya ata `@cauce` a los `src` de este árbol, y con eso la suite de vitest quedó
 * cubierta. Pero la del adaptador NO corre con vitest: corre con `node --test` sobre `dist/`,
 * donde no hay resolvedor que valga y manda el `node_modules` del disco. Un arreglo que cubre un
 * runner y deja el otro suelto es exactamente cómo esto se volvió invisible.
 *
 * ── La dirección peligrosa ───────────────────────────────────────────────────────────────────
 *
 * No es que la suite se ponga roja: eso se ve. Es que se ponga VERDE. Una rama que borre una
 * guarda del protocolo sale verde porque la guarda sigue viva en el árbol del vecino, y nadie se
 * entera hasta que se despliega.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./gancho-de-paquetes.mjs', import.meta.url, {
  data: { raiz: pathToFileURL(new URL('..', import.meta.url).pathname).href }
});
