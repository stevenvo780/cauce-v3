import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';
import { declaracionesDeClase as declaraciones, sinComentarios } from '../../test/css-parser';

const RAIZ = resolve(process.cwd(), 'src');
const GLOBAL = leerCss('styles.css');
const PROPIA = leerCss(join('features', 'config', 'config.css'));
const INTERRUPTORES = leerCss(join('features', 'config', 'toggles.css'));

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

function variables(css: string): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const declaracion of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    mapa.set(declaracion[1], declaracion[2].trim());
  }
  return mapa;
}

function resolver(valor: string, vars: Map<string, string>): string {
  const referencia = /var\((--[\w-]+)\)/.exec(valor);
  if (!referencia) return valor;
  const resuelto = vars.get(referencia[1]);
  expect(resuelto, `${referencia[1]} no está definida en el modo claro`).toBeDefined();
  return resuelto ?? '';
}

function canal(hex: string): number[] {
  const limpio = hex.trim().replace('#', '');
  const largo = limpio.length === 3 ? 1 : 2;
  return [0, 1, 2].map((indice) => {
    const trozo = limpio.slice(indice * largo, indice * largo + largo);
    return parseInt(largo === 1 ? trozo + trozo : trozo, 16);
  });
}

export function contraste(frente: string, fondo: string): number {
  const luminancia = (color: string) => canal(color)
    .map((valor) => valor / 255)
    .map((valor) => (valor <= 0.03928 ? valor / 12.92 : ((valor + 0.055) / 1.055) ** 2.4))
    .reduce((suma, valor, indice) => suma + valor * [0.2126, 0.7152, 0.0722][indice], 0);
  const uno = luminancia(frente);
  const otro = luminancia(fondo);
  return (Math.max(uno, otro) + 0.05) / (Math.min(uno, otro) + 0.05);
}

const PASTILLAS: readonly [string, string, string][] = [
  ['.badge-online', '--on-mint', '--mint-dim'],
  ['.badge-done', '--on-mint', '--mint-dim'],
  ['.badge-running', '--on-blue', '--blue-dim'],
  ['.badge-info', '--on-blue', '--blue-dim'],
  ['.badge-danger', '--on-red', '--red-dim'],
  ['.badge-warning', '--on-amber', '--amber-dim'],
  ['.badge-offline', '--on-neutral', '#eceff4'],
];

describe('las pastillas de estado en modo claro', () => {
  const claro = sinComentarios(bloqueClaro(sinComentarios(GLOBAL)));
  const vars = variables(claro);

  it.each(PASTILLAS)('%s se lee: contraste AA (>= 4,5:1) sobre su propio fondo', (clase, token, fondo) => {
    const base = declaraciones(sinComentarios(GLOBAL), clase);
    expect(base.color, `${clase} no toma su color de un token`).toBe(`var(${token})`);
    const texto = vars.get(token);
    expect(texto, `${token} no está redefinido en el modo claro`).toBeDefined();
    if (texto) {
      expect(contraste(texto, resolver(fondo.startsWith('#') ? fondo : `var(${fondo})`, vars)))
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it('la pastilla es de un tamaño con el que se puede exigir contraste (>= 12px)', () => {
    const base = declaraciones(sinComentarios(GLOBAL), '.badge');
    const escala = new Map(Object.entries(declaraciones(sinComentarios(GLOBAL), ':root')));
    const px = enPixeles(base['font-size'], escala);
    expect(px, `.badge { font-size: ${base['font-size']} } no resuelve a píxeles`).toBeDefined();
    if (px !== undefined) {
      expect(px).toBeGreaterThanOrEqual(12);
    }
  });

  it('el medidor reprueba el par que estaba desplegado (#8ff0d3 sobre #d8f3ea)', () => {
    expect(contraste('#8ff0d3', '#d8f3ea')).toBeLessThan(1.2);
    expect(contraste('#a8d1ff', '#dfedfb')).toBeLessThan(1.4);
  });
});

describe('el texto del tema claro', () => {
  const claro = sinComentarios(bloqueClaro(sinComentarios(GLOBAL)));
  const vars = variables(claro);
  const SOBRE: readonly [string, string, string][] = [
    ['--faint', 'var(--surface-2)', 'cabeceras de columna (`th`) y `.muted`'],
    ['--text-2', 'var(--surface)', 'rótulos, botón secundario y el JSON de «Ver crudo»'],
  ];

  it.each(SOBRE)('%s se lee sobre %s (%s)', (que, fondo) => {
    const texto = vars.get(que);
    expect(texto, `${que} no está redefinido en el modo claro`).toBeDefined();
    if (texto) {
      expect(contraste(resolver(texto, vars), resolver(fondo, vars))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(['label', '.button.secondary', '.config-records code'])(
    '%s toma su color de `--text-2` y no de un hex suelto',
    (selector) => {
      const escapado = selector.replace(/[.[\]()="^$*+?|\\/{}-]/g, (caracter) => `\\${caracter}`);
      const patron = new RegExp(`(?:^|[},])\\s*${escapado}\\s*\\{([^{}]*)\\}`, 'g');
      const colores = [...sinComentarios(GLOBAL).matchAll(patron)]
        .map((regla) => /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(regla[1])?.[1]?.trim())
        .filter((color): color is string => color !== undefined);
      expect(colores, `${selector} no declara ningún color propio`).not.toEqual([]);
      for (const color of colores) {
        expect(color, `${selector} no toma su color de --text-2`).toBe('var(--text-2)');
      }
    },
  );

  it('`--faint` del tema OSCURO también llega a AA sobre la superficie del panel', () => {
    const oscuro = variables(sinComentarios(GLOBAL).slice(0, sinComentarios(GLOBAL).indexOf('@media')));
    const faint = oscuro.get('--faint');
    const surface = oscuro.get('--surface');
    expect(faint).toBeDefined();
    expect(surface).toBeDefined();
    if (faint && surface) {
      expect(contraste(faint, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

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

  it('declara la pista con `minmax(0, 1fr)` y no con un `1fr` pelado', () => {
    expect(declaraciones(global, '.config-area')['grid-template-columns']).toBe('minmax(0, 1fr)');
    for (const regla of global.matchAll(/\.config-area\s*\{([^{}]*)\}/g)) {
      expect(regla[1]).not.toMatch(/grid-template-columns\s*:\s*1fr/);
    }
  });

  it('deja el panel con `min-width: 0` para que el envoltorio de tabla pueda recortar', () => {
    expect(declaraciones(global, '.config-area')['grid-template-columns']).toBeDefined();
    const panel = /\.config-area\s+\.panel\s*\{([^{}]*)\}/.exec(global);
    expect(panel, '.config-area .panel no existe').not.toBeNull();
    if (panel) {
      expect(panel[1]).toMatch(/min-width\s*:\s*0/);
    }
  });

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
      const directorio = pendientes.pop();
      if (!directorio) continue;
      for (const entrada of readdirSync(directorio, { withFileTypes: true })) {
        const ruta = join(directorio, entrada.name);
        if (entrada.isDirectory()) { pendientes.push(ruta); continue; }
        if (!entrada.name.endsWith('.tsx') || entrada.name.includes('.test.')) continue;
        for (const uso of readFileSync(ruta, 'utf8').matchAll(/className=(?:"([^"]*)"|\{`([^`$]*))/g)) {
          for (const clase of (uso[1] || uso[2] || '').split(/\s+/)) if (clase) clases.add(clase);
        }
      }
    }
    return clases;
  }

  it('no hay ninguna que apunte a una clase que ningún componente escribe', () => {
    const pintadas = clasesQuePintaLaVista();
    expect([...clasesDeLaHoja()].filter((clase) => !pintadas.has(clase))).toEqual([]);
  });

  it('`.config-grid` ya no existe en ninguna hoja, y `.config-area` sí', () => {
    expect(clasesDeLaHoja().has('config-grid')).toBe(false);
    expect(clasesDeLaHoja().has('config-area')).toBe(true);
  });
});

function tamanosDeLetra(css: string): { selector: string; valor: string }[] {
  const salida: { selector: string; valor: string }[] = [];
  for (const regla of sinComentarios(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const declaracion of regla[2].matchAll(/(?:^|;)\s*font-size\s*:\s*([^;]+)/g)) {
      salida.push({ selector: regla[1].trim().replace(/\s+/g, ' '), valor: declaracion[1].trim() });
    }
  }
  return salida;
}

const ESCALA = ['--tipo-titulo', '--tipo-panel', '--tipo-cuerpo', '--tipo-rotulo', '--tipo-apunte'];

export function enPixeles(valor: string, escala: Map<string, string>): number | undefined {
  const referencia = /^var\(\s*(--[\w-]+)\s*\)$/.exec(valor.trim());
  if (referencia) {
    const destino = escala.get(referencia[1]);
    return destino === undefined ? undefined : enPixeles(destino, escala);
  }
  const px = /^(\d*\.?\d+)px$/.exec(valor.trim());
  if (px) return Number(px[1]);
  const rem = /^(\d*\.?\d+)rem$/.exec(valor.trim());
  if (rem) return Number(rem[1]) * 16;
  const clamp = /^clamp\(\s*([^,]+),/.exec(valor.trim());
  if (clamp) return enPixeles(clamp[1], escala);
  return undefined;
}

const SUELO = 12.5;
const SUELO_CUERPO = 13;

const EXCEPCIONES: readonly { selector: string; valor: string }[] = [
  { selector: '.sidebar nav a', valor: '.6875rem' },
];

export function letraPorDebajoDelSuelo(hojas: string[], suelo = SUELO): string[] {
  const escala = variables(sinComentarios(hojas.join('\n')));
  const fallos: string[] = [];
  for (const hoja of hojas) {
    for (const { selector, valor } of tamanosDeLetra(hoja)) {
      if (/^(inherit|initial|unset|revert)$/.test(valor)) continue;
      if (EXCEPCIONES.some((e) => e.selector === selector && e.valor === valor)) continue;
      const px = enPixeles(valor, escala);
      if (px === undefined) {
        fallos.push(`${selector} { font-size: ${valor} } no se sabe resolver a píxeles`);
        continue;
      }
      if (px + 0.001 < suelo) fallos.push(`${selector} { font-size: ${valor} } = ${String(px)}px, el suelo es ${String(suelo)}px`);
    }
  }
  return fallos;
}

describe('la escala tipográfica de /config', () => {
  const escala = new Map(Object.entries(declaraciones(sinComentarios(GLOBAL), ':root')));

  it('declara los seis escalones y van de mayor a menor, sin dos iguales', () => {
    const pixeles = ESCALA.map((nombre) => {
      const bruto = escala.get(nombre);
      expect(bruto, `${nombre} no está declarada en el :root de styles.css`).toBeDefined();
      const px = bruto !== undefined ? enPixeles(bruto, escala) : undefined;
      expect(px, `${nombre} = ${bruto ?? ''} no es un tamaño en píxeles`).toBeDefined();
      return px ?? 0;
    });
    for (let i = 1; i < pixeles.length; i += 1) {
      expect(pixeles[i], `${ESCALA[i]} (${String(pixeles[i])}px) no baja de ${ESCALA[i - 1]} (${String(pixeles[i - 1])}px)`)
        .toBeLessThan(pixeles[i - 1]);
    }
  });

  it('el cuerpo y los rótulos no bajan de 13px, y el suelo de todo es 12,5px', () => {
    const cuerpo = enPixeles(escala.get('--tipo-cuerpo') ?? '', escala);
    const rotulo = enPixeles(escala.get('--tipo-rotulo') ?? '', escala);
    const apunte = enPixeles(escala.get('--tipo-apunte') ?? '', escala);
    expect(cuerpo).toBeGreaterThanOrEqual(SUELO_CUERPO);
    expect(rotulo).toBeGreaterThanOrEqual(SUELO_CUERPO);
    expect(apunte).toBeGreaterThanOrEqual(SUELO);
  });

  it('el monoespaciado no se sale de la escala: ni más grande que el cuerpo ni por debajo del suelo', () => {
    const mono = enPixeles(escala.get('--tipo-mono') ?? '', escala);
    const cuerpo = enPixeles(escala.get('--tipo-cuerpo') ?? '', escala);
    expect(mono, '--tipo-mono no está declarada').toBeDefined();
    if (mono !== undefined && cuerpo !== undefined) {
      expect(mono).toBeGreaterThanOrEqual(SUELO);
      expect(mono).toBeLessThanOrEqual(cuerpo);
    }
  });

  it('el título no puede volver a ser tres veces el cuerpo', () => {
    const titulo = enPixeles(escala.get('--tipo-titulo') ?? '', escala);
    const cuerpo = enPixeles(escala.get('--tipo-cuerpo') ?? '', escala);
    if (titulo !== undefined && cuerpo !== undefined) {
      expect(titulo / cuerpo).toBeLessThanOrEqual(3);
      expect(titulo).toBeGreaterThan(cuerpo);
    }
  });

  it('ninguna regla de las hojas de /config declara letra por debajo del suelo', () => {
    expect(letraPorDebajoDelSuelo([GLOBAL, PROPIA, INTERRUPTORES])).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca los tamaños que estaban desplegados (.68rem = 10,88px, .58rem = 9,28px)', () => {
    const roto = PROPIA.replace('font-size: var(--tipo-apunte);', 'font-size: .68rem;');
    expect(roto).not.toBe(PROPIA);
    expect(letraPorDebajoDelSuelo([GLOBAL, roto])).toContainEqual(expect.stringContaining('.68rem'));
    expect(letraPorDebajoDelSuelo(['.x { font-size: .58rem; }'])).toHaveLength(1);
    expect(letraPorDebajoDelSuelo(['.x { font-size: 12px; }'])).toHaveLength(1);
    expect(letraPorDebajoDelSuelo(['.x { font-size: 12.5px; }'])).toEqual([]);
  });

  it('CONTROL NEGATIVO — una escala aplanada no es una escala', () => {
    const plana = variables(sinComentarios(GLOBAL.replace('--tipo-rotulo: 13px', '--tipo-rotulo: 14px')));
    const cuerpo = enPixeles(plana.get('--tipo-cuerpo') ?? '', plana);
    const rotulo = enPixeles(plana.get('--tipo-rotulo') ?? '', plana);
    if (rotulo !== undefined && cuerpo !== undefined) {
      expect(rotulo).not.toBeLessThan(cuerpo);
    }
  });
});
