import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Medida {
  readonly lineas_pct?: number;
  readonly no_disponible?: string;
}

interface EntradaDeBase {
  readonly lineas_pct: number | null;
  readonly pendiente_de_siembra?: boolean;
}

type Base = Record<string, EntradaDeBase>;

interface Fila {
  readonly paquete: string;
  readonly estado: string;
  readonly base?: number | null;
  readonly medido?: number;
  readonly diferencia?: number;
  readonly razon?: string;
  readonly pendiente?: boolean;
}

interface Comparacion {
  readonly filas: readonly Fila[];
  readonly fallos: readonly string[];
  readonly base: Base;
}

interface ResumenDeFichero {
  readonly lines: { readonly covered: number; readonly total: number };
}

interface ModuloCobertura {
  readonly TOLERANCIA: number;
  readonly PAQUETES_RAIZ: readonly string[];
  readonly PAQUETE_CONSOLA: string;
  readonly PAQUETE_ADAPTER: string;
  readonly compararCobertura: (medido: Record<string, Medida>, base: Base) => Comparacion;
  readonly baseActualizada: (
    medido: Record<string, Medida>,
    base: Base,
  ) => { readonly rechazado: readonly string[]; readonly base: Base };
  readonly agregarPaquetes: (
    datos: Record<string, ResumenDeFichero>,
    prefijos: readonly string[],
  ) => Record<string, { cubierto: number; total: number }>;
  readonly validarBase: (base: unknown) => Base;
}

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const modulo = (await import(new URL('../../scripts/cobertura.mjs', import.meta.url).href)) as ModuloCobertura;
const {
  PAQUETES_RAIZ, PAQUETE_ADAPTER, PAQUETE_CONSOLA, TOLERANCIA,
  agregarPaquetes, baseActualizada, compararCobertura, validarBase,
} = modulo;

const base: Base = { 'packages/store/src': { lineas_pct: 80 }, 'console/src': { lineas_pct: 60 } };

function medida(store: number, consola: number): Record<string, Medida> {
  return { 'packages/store/src': { lineas_pct: store }, 'console/src': { lineas_pct: consola } };
}

function paquetesEnDisco(): string[] {
  return ['packages', 'services'].flatMap((zona) => readdirSync(join(raiz, zona), { withFileTypes: true })
    .filter((entrada) => entrada.isDirectory() && existsSync(join(raiz, zona, entrada.name, 'src')))
    .map((entrada) => `${zona}/${entrada.name}/src`)).sort();
}

describe('trinquete de cobertura', () => {
  it('declara cada paquete con src del arbol: la lista no puede quedarse atras', () => {
    const enDisco = paquetesEnDisco();
    const declarados = new Set([...PAQUETES_RAIZ, `${PAQUETE_ADAPTER}/src`]);

    expect(enDisco.length).toBeGreaterThan(1);
    expect(enDisco.filter((paquete) => !declarados.has(paquete))).toEqual([]);
    expect(PAQUETES_RAIZ.filter((paquete) => !enDisco.includes(paquete))).toEqual([]);
  });

  it('la base del repositorio es valida y cubre exactamente los paquetes declarados', () => {
    const fichero = JSON.parse(readFileSync(join(raiz, 'scripts/cobertura-base.json'), 'utf8')) as Base;

    expect(() => validarBase(fichero)).not.toThrow();
    expect(Object.keys(fichero).sort()).toEqual(
      [...PAQUETES_RAIZ, PAQUETE_CONSOLA, PAQUETE_ADAPTER].sort(),
    );
  });

  it('agrega lineas cubiertas y totales por prefijo de paquete', () => {
    const agregado = agregarPaquetes({
      total: { lines: { covered: 999, total: 999 } },
      'packages/store/src/uno.ts': { lines: { covered: 5, total: 10 } },
      'packages/store/src/hondo/dos.ts': { lines: { covered: 3, total: 10 } },
      'packages/protocol/src/tres.ts': { lines: { covered: 9, total: 10 } },
      'services/gateway/src/cuatro.ts': { lines: { covered: 1, total: 2 } },
    }, ['packages/store/src', 'packages/protocol/src']);

    expect(agregado['packages/store/src']).toEqual({ cubierto: 8, total: 20 });
    expect(agregado['packages/protocol/src']).toEqual({ cubierto: 9, total: 10 });
    expect(Object.keys(agregado)).toEqual(['packages/store/src', 'packages/protocol/src']);
  });

  it('falla nombrando el paquete cuando cae un punto entero', () => {
    const resultado = compararCobertura(medida(79, 60), base);

    expect(resultado.fallos).toHaveLength(1);
    expect(resultado.fallos[0]).toContain('packages/store/src');
    expect(resultado.fallos[0]).toContain('80.00%');
    expect(resultado.fallos[0]).toContain('79.00%');
    expect(resultado.fallos[0]).toContain('-1.00 puntos');
  });

  it('acepta cualquier subida y la propone como base nueva', () => {
    const resultado = compararCobertura(medida(83.5, 60), base);

    expect(resultado.fallos).toEqual([]);
    expect(resultado.base['packages/store/src']).toEqual({ lineas_pct: 83.5 });
    expect(resultado.base['console/src']).toEqual({ lineas_pct: 60 });
  });

  it('tolera una caida de una decima sin bajar la base', () => {
    const resultado = compararCobertura(medida(79.9, 60), base);

    expect(TOLERANCIA).toBe(0.2);
    expect(resultado.fallos).toEqual([]);
    expect(resultado.base['packages/store/src']).toEqual({ lineas_pct: 80 });
  });

  it('falla en el borde: 0.20 pasa y 0.21 no', () => {
    expect(compararCobertura(medida(79.8, 60), base).fallos).toEqual([]);
    expect(compararCobertura(medida(79.79, 60), base).fallos).toHaveLength(1);
  });

  it('falla cuando un dominio no se pudo medir en vez de darlo por verde', () => {
    const resultado = compararCobertura(
      { 'packages/store/src': { no_disponible: 'la suite terminó roja: exit 9' } },
      base,
    );

    expect(resultado.fallos).toHaveLength(2);
    expect(resultado.fallos.join('\n')).toContain('packages/store/src: NO DISPONIBLE (la suite terminó roja: exit 9)');
    expect(resultado.fallos.join('\n')).toContain('console/src: AUSENTE (no aparece en esta corrida)');
    expect(resultado.base).toEqual(base);
  });

  it('falla el paquete declarado que no esta en la base: un hueco no es un verde', () => {
    const resultado = compararCobertura({ 'services/gateway/src': { lineas_pct: 3.2 } }, {});

    expect(resultado.filas[0]?.estado).toBe('NUEVO');
    expect(resultado.fallos).toHaveLength(1);
    expect(resultado.fallos[0]).toContain('services/gateway/src: NUEVO (mide 3.20%');
    expect(resultado.fallos[0]).toContain('--sembrar');
    expect(resultado.base).toEqual({});
  });

  it('falla el paquete marcado pendiente de siembra aunque mida alto', () => {
    const pendiente: Base = { 'packages/store/src': { lineas_pct: null, pendiente_de_siembra: true } };
    const resultado = compararCobertura({ 'packages/store/src': { lineas_pct: 99.9 } }, pendiente);
    const actualizacion = baseActualizada({ 'packages/store/src': { lineas_pct: 99.9 } }, pendiente);

    expect(resultado.filas[0]?.estado).toBe('PENDIENTE');
    expect(resultado.fallos).toHaveLength(1);
    expect(resultado.fallos[0]).toContain('packages/store/src: pendiente de siembra');
    expect(actualizacion.rechazado).toHaveLength(1);
    expect(actualizacion.base).toEqual(pendiente);
  });

  it('nombra la entrada corrupta de la base en vez de restar contra ella', () => {
    const corrupta = { 'packages/store/src': { lineas_pct: null } } as unknown as Base;
    const resultado = compararCobertura({ 'packages/store/src': { lineas_pct: 10 } }, corrupta);

    expect(resultado.filas[0]?.estado).toBe('BASE INVALIDA');
    expect(resultado.fallos).toEqual([
      'packages/store/src: la entrada de la base no trae un lineas_pct numerico: null',
    ]);
    expect(() => validarBase(corrupta)).toThrow(/la entrada "packages\/store\/src"/u);
    expect(() => validarBase({ 'packages/store/src': { lineas_pct: 80, ramas_pct: 70 } })).toThrow(/ramas_pct/u);
    expect(() => validarBase([])).toThrow(/objeto de paquete a cifra/u);
  });

  it('rechaza un --actualizar que intente bajar una entrada y deja la base intacta', () => {
    const resultado = baseActualizada(medida(79, 61), base);

    expect(resultado.rechazado).toHaveLength(1);
    expect(resultado.rechazado[0]).toContain('packages/store/src');
    expect(resultado.base).toEqual(base);
  });

  it('deja --actualizar escribir cuando todo sube o se mantiene', () => {
    const resultado = baseActualizada(medida(80, 61), base);

    expect(resultado.rechazado).toEqual([]);
    expect(resultado.base).toEqual({
      'packages/store/src': { lineas_pct: 80 },
      'console/src': { lineas_pct: 61 },
    });
  });
});
