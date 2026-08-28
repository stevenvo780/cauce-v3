import { describe, expect, it } from 'vitest';
import { countCodePoints } from '@cauce/protocol';
import { countCodePoints as countCodePointsDeEsteArbol } from '../../packages/protocol/src/schemas.js';

/**
 * Checks that the resolution of `@cauce/*` points to the modules of THIS tree by comparing the
 * imported object identity via the package alias and via the relative path.
 */

describe('resolución de los paquetes del monorepo', () => {
  it('`@cauce/protocol` es el de ESTE árbol, no el del checkout vecino', () => {
    expect(countCodePoints).toBe(countCodePointsDeEsteArbol);
  });

  /**
   * NEGATIVE CONTROL of the test above: the identity comparison CAN actually say no.
   *
   * Without this, a `toBe` between two imports that the bundler might have merged would always
   * go green and the guard would prove nothing. Here the case to be rejected is fabricated
   * (two functions with the same body and name) and the assertion is checked to tell them apart.
   */
  it('dos copias del mismo código NO son el mismo objeto (el aserto puede dar rojo)', () => {
    const unaCopia = (text: string): number => [...text].length;
    const otraCopia = (text: string): number => [...text].length;
    expect(unaCopia('abc')).toBe(otraCopia('abc'));
    expect(unaCopia).not.toBe(otraCopia);
  });
});
