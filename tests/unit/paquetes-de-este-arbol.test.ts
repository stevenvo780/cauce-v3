import { describe, expect, it } from 'vitest';
import { countCodePoints } from '@cauce/protocol';
import { countCodePoints as countCodePointsDeEsteArbol } from '../../packages/protocol/src/schemas.js';

/**
 * LA PRUEBA CORRE CONTRA EL CÓDIGO DE ESTE ÁRBOL, NO CONTRA EL DE OTRO WORKTREE.
 *
 * ── El fallo, medido ─────────────────────────────────────────────────────────────────────────
 *
 * `node_modules/` de cada worktree es un ENLACE al `node_modules/` del checkout principal, y
 * dentro de él `@cauce/protocol` es a su vez un enlace relativo `../../packages/protocol`. Ese
 * relativo se resuelve desde la ruta REAL del enlace, o sea desde el checkout principal: cualquier
 * `import ... from '@cauce/protocol'` de un worktree cargaba el `packages/protocol` de OTRA RAMA.
 *
 * Medido el 2026-08-25 en `/workspace/wt-ed-gateway`: `packages/protocol/src/schemas.ts` de este
 * árbol y el del checkout principal son inodos DISTINTOS (15239919 vs 28193992), y el segundo no
 * tenía el recurso que este árbol acababa de añadir. Efecto: `tests/unit/agent-profile.test.ts`
 * —que vino con la rama del perfil y prueba código que SÍ está acá— daba 21 de 21 en rojo, y una
 * prueba nueva del esquema seguía en rojo después de implementarlo y reconstruir el `dist`.
 *
 * ── Por qué esto es peor que un fallo ────────────────────────────────────────────────────────
 *
 * No se parece a su causa. La suite no dice «cargué otro fichero»: dice que tu código no hace lo
 * que hace. En la dirección contraria es todavía peor —una rama que borra una guarda puede salir
 * VERDE porque la guarda sigue viva en el árbol del vecino—, y ahí no hay ningún síntoma que mirar.
 *
 * ── Cómo se comprueba ────────────────────────────────────────────────────────────────────────
 *
 * Por IDENTIDAD DE OBJETO, no por existencia. Se importa la misma función por las dos vías —por
 * nombre de paquete y por ruta relativa dentro de este árbol— y se exige que sean EL MISMO objeto.
 * Dos copias del mismo fichero en dos checkouts exportan funciones que hacen lo mismo y NO son
 * idénticas, así que comparar comportamiento no distinguiría nada: la identidad sí.
 *
 * Se usa `countCodePoints` a propósito, y no algo que este árbol acabe de añadir: tiene que existir
 * en las dos copias para que lo único que el test pueda detectar sea la PROCEDENCIA. Comprobar un
 * símbolo nuevo mediría «¿está mi cambio?» y volvería a pasar el día que el vecino lo tenga.
 */

describe('resolución de los paquetes del monorepo', () => {
  it('`@cauce/protocol` es el de ESTE árbol, no el del checkout vecino', () => {
    expect(countCodePoints).toBe(countCodePointsDeEsteArbol);
  });

  /**
   * CONTROL NEGATIVO de la prueba de arriba: la comparación por identidad SÍ sabe decir que no.
   *
   * Sin esto, un `toBe` entre dos importaciones que el empaquetador hubiera fusionado siempre daría
   * verde y la guarda no probaría nada. Acá se fabrica a mano el caso que tiene que rechazar —dos
   * funciones con el mismo cuerpo y el mismo nombre— y se comprueba que el aserto lo distingue.
   */
  it('dos copias del mismo código NO son el mismo objeto (el aserto puede dar rojo)', () => {
    const unaCopia = (text: string): number => [...text].length;
    const otraCopia = (text: string): number => [...text].length;
    expect(unaCopia('abc')).toBe(otraCopia('abc'));
    expect(unaCopia).not.toBe(otraCopia);
  });
});
