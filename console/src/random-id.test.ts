import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId } from './lib';
import { randomUuid } from './random-id';

/* The console is opened over plain HTTP on a LAN address often enough that this is not theoretical:
   there, `crypto.randomUUID` is absent and an unguarded call threw before React mounted, so every
   view was a blank page. These cases pin the fallback, including its CONTROL NEGATIVO. */

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => { vi.unstubAllGlobals(); });

/** A crypto object missing exactly what a non-secure context withholds. */
function sinRandomUuid(): Crypto {
  const real = globalThis.crypto;
  return {
    getRandomValues: real.getRandomValues.bind(real),
  } as unknown as Crypto;
}

describe('randomUuid sobrevive fuera de un contexto seguro', () => {
  it('usa crypto.randomUUID cuando el navegador lo ofrece', () => {
    expect(randomUuid()).toMatch(V4);
  });

  it('sin randomUUID, compone un v4 con getRandomValues y NO se rompe', () => {
    vi.stubGlobal('crypto', sinRandomUuid());
    expect(randomUuid()).toMatch(V4);
  });

  it('sin randomUUID, sigue dando identificadores distintos', () => {
    vi.stubGlobal('crypto', sinRandomUuid());
    const vistos = new Set(Array.from({ length: 500 }, () => randomUuid()));
    expect(vistos.size).toBe(500);
  });

  it('createId, que es de donde salían los id de los tooltips, tampoco se rompe', () => {
    vi.stubGlobal('crypto', sinRandomUuid());
    expect(createId('tooltip')).toMatch(/^tooltip-[0-9a-f-]{36}$/);
  });

  it('CONTROL NEGATIVO — sin ninguna fuente de aleatoriedad falla con una frase, no con un TypeError', () => {
    vi.stubGlobal('crypto', {});
    expect(() => randomUuid()).toThrowError(/aleatoriedad/);
  });
});
