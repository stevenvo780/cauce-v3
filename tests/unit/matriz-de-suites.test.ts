import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Paquete {
  readonly ruta: string;
  readonly nombre: string;
  readonly tieneTest: boolean;
}

interface Manifiesto {
  scripts: Record<string, string>;
}

interface Conteo {
  readonly ejecutados: number;
  readonly saltados: number;
}

interface Resultado {
  readonly code: number;
  readonly timedOut?: boolean;
  readonly conteo?: Conteo;
}

interface Contador {
  readonly empujar: (trozo: string) => void;
  readonly cerrar: () => Conteo | undefined;
}

interface ModuloDeMatriz {
  readonly SUITES: readonly string[];
  readonly SEPARATELY_GATED: ReadonlyMap<string, string>;
  readonly comprobarMatriz: (manifiesto: Manifiesto, paquetes: readonly Paquete[]) => void;
  readonly assertMatrixIsComplete: () => Promise<void>;
  readonly paquetesDelWorkspace: () => Promise<Paquete[]>;
  readonly verdictFor: (resultado: Resultado) => string;
  readonly contadorDeSuite: (nombre: string) => Contador;
}

const raiz = new URL('../../', import.meta.url);
const modulo = (await import(new URL('scripts/test-all.mjs', raiz).href)) as ModuloDeMatriz;
const {
  SEPARATELY_GATED, SUITES,
  assertMatrixIsComplete, comprobarMatriz, contadorDeSuite, paquetesDelWorkspace, verdictFor,
} = modulo;

const manifiesto = JSON.parse(
  readFileSync(fileURLToPath(new URL('package.json', raiz)), 'utf8'),
) as Manifiesto;
const paquetes = await paquetesDelWorkspace();

const conManifiesto = (cambios: Record<string, string>): Manifiesto =>
  ({ ...manifiesto, scripts: { ...manifiesto.scripts, ...cambios } });

const matrizSintetica = (cambios: Record<string, string>): Manifiesto =>
  ({ scripts: { ...Object.fromEntries(SUITES.map((nombre) => [nombre, 'true'])), ...cambios } });

describe('test:core es un escalón por commit, no una suite de la matriz', () => {
  it('está declarado aparte con su razón y nunca dentro de SUITES', () => {
    expect(SUITES).not.toContain('test:core');
    expect(SEPARATELY_GATED.get('test:core')).toMatch(/per-commit step/u);
  });

  it('el guion existe y encadena el preflight de Postgres antes de las dos mitades', () => {
    expect(manifiesto.scripts['test:core']).toBe(
      'node scripts/preflight-postgres.mjs && pnpm run test:services && pnpm run test:gateway-hardening',
    );
  });

  it('coverage:ratchet y coverage:seed también están declarados aparte', () => {
    expect(SEPARATELY_GATED.get('coverage:ratchet')).toMatch(/nightly and release closure/u);
    expect(SEPARATELY_GATED.get('coverage:seed')).toMatch(/nightly and release closure/u);
  });
});

describe('la comprobación de la matriz', () => {
  it('el árbol real la pasa', async () => {
    await expect(assertMatrixIsComplete()).resolves.toBeUndefined();
  });

  it('un --filter que no nombra a ningún paquete del workspace la rompe', () => {
    const roto = conManifiesto({
      'test:services': `${manifiesto.scripts['test:services'] ?? ''} --filter @cauce/no-existe`,
    });
    expect(() => { comprobarMatriz(roto, paquetes); })
      .toThrow(/filter a workspace package that does not exist: test:services: --filter @cauce\/no-existe/u);
  });

  // The hole that used to pass: the bare token `console` matched INSIDE another word, so a package
  // nobody ran any more kept the gate green as long as some command mentioned a longer name.
  it('un --filter=paquete (con igual) se reconoce igual que con espacio', () => {
    const conIgual = conManifiesto({
      'test:services': (manifiesto.scripts['test:services'] ?? '').replaceAll('--filter ', '--filter='),
    });
    expect(() => { comprobarMatriz(conIgual, paquetes); }).not.toThrow();
  });

  it('el respaldo por directorio ya no casa por subcadena', () => {
    const soloConsola: Paquete[] = [{ ruta: 'console/package.json', nombre: '@cauce/console', tieneTest: true }];
    expect(() => { comprobarMatriz(matrizSintetica({ 'test:unit': 'vitest run consoleta' }), soloConsola); })
      .toThrow(/no root test:\* ever invokes: @cauce\/console/u);
    expect(() => { comprobarMatriz(matrizSintetica({ 'test:unit': 'vitest run console/test' }), soloConsola); })
      .not.toThrow();
  });

  it('un guion coverage:* sin declarar tampoco pasa', () => {
    expect(() => { comprobarMatriz(conManifiesto({ 'coverage:invento': 'node scripts/cobertura.mjs' }), paquetes); })
      .toThrow(/neither in the matrix nor explicitly excluded: coverage:invento/u);
  });
});

describe('veredicto por conteo de tests', () => {
  it('cero ejecutados no es PASS: es VACIA', () => {
    expect(verdictFor({ code: 0, conteo: { ejecutados: 0, saltados: 214 } })).toBe('VACIA');
  });

  it('con ejecutados es PASS; sin conteo sólo para los ejecutores que no lo dan', () => {
    expect(verdictFor({ name: 'test:unit', code: 0, conteo: { ejecutados: 3, saltados: 214 } })).toBe('PASS');
    expect(verdictFor({ name: 'test:pty', code: 0 })).toBe('PASS');
    expect(verdictFor({ name: 'test:unit', code: 0 })).toBe('VACIA');
  });

  it('un rojo o un plantón mandan sobre el conteo', () => {
    expect(verdictFor({ code: 1, conteo: { ejecutados: 3, saltados: 0 } })).toBe('FAIL');
    expect(verdictFor({ code: 0, timedOut: true, conteo: { ejecutados: 0, saltados: 0 } })).toBe('TIMEOUT');
  });
});

describe('el contador lee la salida de los ejecutores', () => {
  const empujar = (nombre: string, texto: string): Conteo | undefined => {
    const contador = contadorDeSuite(nombre);
    contador.empujar(texto);
    return contador.cerrar();
  };

  it('suma los resúmenes de varias invocaciones de vitest', () => {
    expect(empujar('test:services', [
      ' Test Files  1 passed (1)',
      '      Tests  3 passed | 2 skipped (5)',
      '      Tests  7 passed (7)',
      '',
    ].join('\n'))).toEqual({ ejecutados: 10, saltados: 2 });
  });

  it('cuenta también los fallidos y la salida de node --test', () => {
    expect(empujar('test:unit', '      Tests  1 failed | 4 passed (5)\n# pass 689\n# skipped 3\n'))
      .toEqual({ ejecutados: 694, saltados: 3 });
  });

  it('«no tests» es un conteo de cero, no la ausencia de conteo', () => {
    expect(empujar('test:store-hardening', '      Tests  no tests\n')).toEqual({ ejecutados: 0, saltados: 0 });
  });

  it('sin resumen reconocible no inventa un conteo', () => {
    expect(empujar('test:terminal-pty', 'OK (skipped=3)\n')).toBeUndefined();
    expect(empujar('test:ops', '      Tests  3 passed (3)\n')).toBeUndefined();
  });
});
