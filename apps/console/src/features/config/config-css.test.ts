import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guardias de HOJA para `/config`. Existen porque los dos defectos más caros de esta vista no eran
 * de lógica: no los veía el typecheck, no los veía el lint y no los veía ninguna de las 646 pruebas.
 *
 *  1. **La pastilla del «SÍ» era invisible.** El tema claro redefine `--mint-dim` a un menta muy
 *     pálido pero `.badge-online` conservaba el color de texto del tema oscuro (`#8ff0d3`).
 *     MEDIDO en Chrome contra el snapshot real de producción: 1,15:1 —WCAG AA exige 4,5:1— en las
 *     195 instancias de las seis pestañas, mientras su gemela `.badge-offline` («NO») daba 4,98:1.
 *     El operador que barría la rejilla de permisos veía todos los negativos y ninguno de los
 *     positivos, que es justo el estado que importa.
 *
 *  2. **La hoja apuntaba a una clase que la vista ya no escribe.** Cuando `/config` pasó a
 *     pestañas, el contenedor dejó de llamarse `.config-grid` y pasó a `.config-area`; las seis
 *     reglas quedaron inertes, y con ellas el `min-width: 0` que hacía funcionar el
 *     `overflow-x: auto` de las tablas. Resultado MEDIDO: un documento de 3130px en un viewport de
 *     1280, con la barra lateral quedándose atrás al arrastrar. Un `className` es una cadena y una
 *     regla sin destinatario no es un error para nadie.
 *
 * Se comprueba leyendo el TEXTO de las hojas, no `getComputedStyle`: jsdom no resuelve la cascada
 * ni las media queries, así que preguntarle a él sería preguntarle a quien no sabe.
 */

const RAIZ = resolve(process.cwd(), 'src');
const GLOBAL = readFileSync(join(RAIZ, 'styles.css'), 'utf8');
const PROPIA = readFileSync(join(RAIZ, 'features', 'config', 'config.css'), 'utf8');

function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** El bloque `@media (prefers-color-scheme: light)`, que es el que estaba a medio escribir. */
function bloqueClaro(css: string): string {
  const inicio = css.indexOf('@media (prefers-color-scheme: light)');
  expect(inicio).toBeGreaterThan(-1);
  let profundidad = 0;
  for (let i = css.indexOf('{', inicio); i < css.length; i += 1) {
    if (css[i] === '{') profundidad += 1;
    if (css[i] === '}') {
      profundidad -= 1;
      if (profundidad === 0) return css.slice(inicio, i);
    }
  }
  throw new Error('el bloque de modo claro no cierra');
}

/** Las declaraciones de la PRIMERA regla cuyo selector menciona esa clase. */
function declaraciones(css: string, clase: string): Record<string, string> {
  for (const regla of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectores = regla[1].split(',').map((parte) => parte.trim());
    if (!selectores.some((selector) => selector.split(/\s+/).some((parte) => parte === clase))) continue;
    const salida: Record<string, string> = {};
    for (const declaracion of regla[2].split(';')) {
      const corte = declaracion.indexOf(':');
      if (corte < 0) continue;
      salida[declaracion.slice(0, corte).trim()] = declaracion.slice(corte + 1).trim();
    }
    return salida;
  }
  return {};
}

/** Las variables del `:root` de un bloque, para resolver `var(--mint-dim)`. */
function variables(css: string): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const declaracion of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    mapa.set(declaracion[1], declaracion[2].trim());
  }
  return mapa;
}

function resolver(valor: string, vars: Map<string, string>): string {
  const referencia = valor.match(/var\((--[\w-]+)\)/);
  if (!referencia) return valor;
  const resuelto = vars.get(referencia[1]);
  expect(resuelto, `${referencia[1]} no está definida en el modo claro`).toBeDefined();
  return resuelto!;
}

function canal(hex: string): number[] {
  const limpio = hex.trim().replace('#', '');
  const largo = limpio.length === 3 ? 1 : 2;
  return [0, 1, 2].map((indice) => {
    const trozo = limpio.slice(indice * largo, indice * largo + largo);
    return parseInt(largo === 1 ? trozo + trozo : trozo, 16);
  });
}

/** Contraste WCAG 2.x. La misma fórmula con la que se midió el 1,15:1 en Chrome. */
export function contraste(frente: string, fondo: string): number {
  const luminancia = (color: string) => canal(color)
    .map((valor) => valor / 255)
    .map((valor) => (valor <= 0.03928 ? valor / 12.92 : ((valor + 0.055) / 1.055) ** 2.4))
    .reduce((suma, valor, indice) => suma + valor * [0.2126, 0.7152, 0.0722][indice], 0);
  const uno = luminancia(frente);
  const otro = luminancia(fondo);
  return (Math.max(uno, otro) + 0.05) / (Math.min(uno, otro) + 0.05);
}

const PASTILLAS = ['.badge-online', '.badge-done', '.badge-running', '.badge-info', '.badge-danger', '.badge-warning', '.badge-offline'];

describe('las pastillas de estado en modo claro', () => {
  const claro = sinComentarios(bloqueClaro(sinComentarios(GLOBAL)));
  const vars = variables(claro);

  it.each(PASTILLAS)('%s se lee: contraste AA (>= 4,5:1) sobre su propio fondo', (clase) => {
    const regla = declaraciones(claro, clase);
    expect(Object.keys(regla), `${clase} no tiene regla propia en el modo claro`).not.toEqual([]);
    const texto = resolver(regla.color, vars);
    const fondo = resolver(regla.background, vars);
    expect(contraste(texto, fondo)).toBeGreaterThanOrEqual(4.5);
  });

  it('la pastilla es de un tamaño con el que se puede exigir contraste (>= 12px)', () => {
    const base = declaraciones(sinComentarios(GLOBAL), '.badge');
    const rem = Number.parseFloat(base['font-size'].replace('rem', ''));
    expect(rem * 16).toBeGreaterThanOrEqual(12);
  });

  /**
   * CONTROL NEGATIVO del propio cálculo. Un medidor que aprueba cualquier par de colores es peor
   * que no tenerlo: acá se le da de comer el par EXACTO que estaba en producción —menta sobre
   * menta— y se exige que lo repruebe con el 1,15 que se midió en Chrome.
   */
  it('el medidor reprueba el par que estaba desplegado (#8ff0d3 sobre #d8f3ea)', () => {
    expect(contraste('#8ff0d3', '#d8f3ea')).toBeLessThan(1.2);
    expect(contraste('#a8d1ff', '#dfedfb')).toBeLessThan(1.4);
  });
});

/**
 * El resto del texto del tema claro. El barrido de contraste sobre las seis pestañas con el
 * snapshot real de producción daba 399 nodos por debajo de AA, y sólo 195 eran pastillas: el otro
 * montón eran rótulos, cabeceras de columna y botones que conservaban el hex del tema OSCURO.
 * Cada par de acá se midió en Chrome antes y después.
 */
describe('el texto del tema claro', () => {
  const claro = sinComentarios(bloqueClaro(sinComentarios(GLOBAL)));
  const vars = variables(claro);
  /** El fondo más oscuro sobre el que ese texto se pinta en modo claro: el caso peor. */
  const SOBRE: ReadonlyArray<[string, string, string]> = [
    ['--faint', 'var(--surface-2)', 'cabeceras de columna (`th`) y `.muted`'],
    ['label', 'var(--surface)', 'rótulos de formulario'],
    ['.button.secondary', 'var(--surface)', '«Actualizar» y «Cerrar sesión»'],
    ['.config-records code', '#f8fafd', 'el JSON de «Ver crudo»'],
  ];

  it.each(SOBRE)('%s se lee sobre %s (%s)', (que, fondo) => {
    const texto = que.startsWith('--')
      ? vars.get(que)
      : declaraciones(claro, que.split(' ').pop()!).color;
    expect(texto, `${que} no está redefinido en el modo claro`).toBeDefined();
    expect(contraste(resolver(texto!, vars), resolver(fondo, vars))).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * El tema OSCURO es el de por defecto (`:root { color-scheme: dark }`), así que su `--faint`
   * —cabeceras de columna y `.muted`— es lo que ve la mayoría. Medido: 4,20:1, por debajo de AA.
   * Se guarda acá y no en otro fichero para que arreglar un tema y olvidar el otro no pase dos
   * veces.
   */
  it('`--faint` del tema OSCURO también llega a AA sobre la superficie del panel', () => {
    const oscuro = variables(sinComentarios(GLOBAL).slice(0, sinComentarios(GLOBAL).indexOf('@media')));
    expect(contraste(oscuro.get('--faint')!, oscuro.get('--surface')!)).toBeGreaterThanOrEqual(4.5);
  });

  /** CONTROL NEGATIVO: los tres hex del tema oscuro que estaban desplegados. */
  it('el medidor reprueba los tres colores que estaban desplegados', () => {
    expect(contraste('#c4d0e1', '#ffffff')).toBeLessThan(2);
    expect(contraste('#c6d2e6', '#ffffff')).toBeLessThan(2);
    expect(contraste('#b9cae0', '#f8fafd')).toBeLessThan(2);
    expect(contraste('#718198', '#edf2f7')).toBeLessThan(4.5);
    expect(contraste('#64758f', '#0d1422')).toBeLessThan(4.5);
  });
});

describe('el contenedor de las pestañas de /config', () => {
  const global = sinComentarios(GLOBAL);

  /**
   * Las dos piezas del arreglo del desborde, y ninguna alcanza sola: `minmax(0, 1fr)` baja el
   * mínimo de la PISTA (un `1fr` pelado es `minmax(auto, 1fr)`, y ese `auto` es el min-content del
   * panel) y `min-width: 0` baja el mínimo automático del ITEM.
   */
  it('declara la pista con `minmax(0, 1fr)` y no con un `1fr` pelado', () => {
    expect(declaraciones(global, '.config-area')['grid-template-columns']).toBe('minmax(0, 1fr)');
    for (const regla of global.matchAll(/\.config-area\s*\{([^{}]*)\}/g)) {
      expect(regla[1]).not.toMatch(/grid-template-columns\s*:\s*1fr/);
    }
  });

  it('deja el panel con `min-width: 0` para que el envoltorio de tabla pueda recortar', () => {
    expect(declaraciones(global, '.config-area')['grid-template-columns']).toBeDefined();
    const panel = global.match(/\.config-area\s+\.panel\s*\{([^{}]*)\}/);
    expect(panel, '.config-area .panel no existe').not.toBeNull();
    expect(panel![1]).toMatch(/min-width\s*:\s*0/);
  });

  /** El layout no puede estar definido en dos hojas: la segunda gana y la primera se queda atrás. */
  it('no está redefinido en la hoja propia de la vista', () => {
    expect(sinComentarios(PROPIA)).not.toMatch(/\.config-area\s*\{/);
  });
});

describe('las reglas `.config-*` de las hojas', () => {
  function clasesDeLaHoja(): Set<string> {
    const clases = new Set<string>();
    for (const css of [GLOBAL, PROPIA]) {
      for (const encontrada of sinComentarios(css).matchAll(/\.(config-[\w-]+)/g)) clases.add(encontrada[1]);
    }
    return clases;
  }

  function clasesQuePintaLaVista(): Set<string> {
    const clases = new Set<string>();
    const pendientes = [RAIZ];
    while (pendientes.length) {
      const directorio = pendientes.pop()!;
      for (const entrada of readdirSync(directorio, { withFileTypes: true })) {
        const ruta = join(directorio, entrada.name);
        if (entrada.isDirectory()) { pendientes.push(ruta); continue; }
        if (!entrada.name.endsWith('.tsx') || entrada.name.includes('.test.')) continue;
        for (const uso of readFileSync(ruta, 'utf8').matchAll(/className=(?:"([^"]*)"|\{`([^`$]*))/g)) {
          for (const clase of (uso[1] ?? uso[2] ?? '').split(/\s+/)) if (clase) clases.add(clase);
        }
      }
    }
    return clases;
  }

  it('no hay ninguna que apunte a una clase que ningún componente escribe', () => {
    const pintadas = clasesQuePintaLaVista();
    expect([...clasesDeLaHoja()].filter((clase) => !pintadas.has(clase))).toEqual([]);
  });

  /** CONTROL NEGATIVO: la clase exacta que quedó huérfana y costó el desborde de 3130px. */
  it('`.config-grid` ya no existe en ninguna hoja, y `.config-area` sí', () => {
    expect(clasesDeLaHoja().has('config-grid')).toBe(false);
    expect(clasesDeLaHoja().has('config-area')).toBe(true);
  });
});
