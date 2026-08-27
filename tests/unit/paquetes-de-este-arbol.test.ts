import { describe, expect, it } from 'vitest';
import { countCodePoints } from '@cauce/protocol';
import { countCodePoints as countCodePointsDeEsteArbol } from '../../packages/protocol/src/schemas.js';

/**
 * Comprueba que la resolución de `@cauce/*` apunte a los módulos del árbol local
 * comparando la identidad de objeto importado por alias de paquete y por ruta relativa.
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
