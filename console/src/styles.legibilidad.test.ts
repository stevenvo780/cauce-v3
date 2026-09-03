import { describe, expect, it } from 'vitest';
import { leerCss } from './test/leer-css';
import { NAV_ENTRIES } from './nav';
import {
  bloqueMedia,
  declaraciones,
  reglasDe,
  type ReglaCss,
  sinComentarios,
  valor,
} from './test/css-parser';

export { reglasDe, type ReglaCss };

const GLOBAL = leerCss('styles.css');

const HOJAS_DE_LA_CONSOLA = [
  'features/live/live.css',
  'features/live/live-hypergraph.css',
  'features/messages/messages.css',
  'features/terminal/terminal-panel.css',
  'features/config/config.css',
  'features/landing/landing.css',
  'features/audit/audit.css',
  'features/accounts/licenses.css',
  'features/auth/auth.css',
  'styles.css',
];

const CONFIG = leerCss('features/config/config.css');

function minimoDeUnaPista(pista: string): number {
  const t = pista.trim();
  const rango = /^minmax\(([^,]+),(.*)\)$/.exec(t);
  if (rango) return minimoDeUnaPista(rango[1]);
  const px = /^(\d+(?:\.\d+)?)px$/.exec(t);
  if (px) return Number(px[1]);
  const rem = /^(\d+(?:\.\d+)?)rem$/.exec(t);
  if (rem) return Number(rem[1]) * 16;
  return 0;
}

function partirEnPistas(valorCss: string): string[] {
  const salida: string[] = [];
  let profundidad = 0;
  let actual = '';
  for (const caracter of valorCss) {
    if (caracter === '(') profundidad += 1;
    if (caracter === ')') profundidad -= 1;
    if (/\s/.test(caracter) && profundidad === 0) {
      if (actual.trim()) salida.push(actual.trim());
      actual = '';
    } else actual += caracter;
  }
  if (actual.trim()) salida.push(actual.trim());
  return salida;
}

export function anchoMinimoDeLaReja(valorCss: string): number {
  let total = 0;
  let resto = valorCss;
  for (const encontrado of [...valorCss.matchAll(/repeat\(\s*([\w-]+)\s*,\s*((?:[^()]|\([^()]*\))*)\)/g)]) {
    const veces = /^\d+$/.test(encontrado[1]) ? Number(encontrado[1]) : 1;
    total += veces * partirEnPistas(encontrado[2]).reduce((suma, p) => suma + minimoDeUnaPista(p), 0);
    resto = resto.replace(encontrado[0], ' ');
  }
  for (const pista of partirEnPistas(resto)) total += minimoDeUnaPista(pista);
  return total;
}

function mediaAplica(media: string, viewport: number): boolean {
  const topes = [...media.matchAll(/max-width:\s*(\d+)px/g)].map((m) => Number(m[1]));
  const pisos = [...media.matchAll(/min-width:\s*(\d+)px/g)].map((m) => Number(m[1]));
  if (topes.length && viewport > Math.min(...topes)) return false;
  return !(pisos.length && viewport < Math.max(...pisos));
}

/** The last declaration that wins at `viewport`, walking the sheet in cascade order. */
function declaracionEfectiva(
  css: string, coincide: (parte: string) => boolean, propiedad: string, viewport: number,
): string | undefined {
  let ultima: string | undefined;
  for (const regla of reglasDe(css)) {
    if (!mediaAplica(regla.media, viewport)) continue;
    if (!regla.selector.split(',').some((parte) => coincide(parte.trim()))) continue;
    const encontrado = valor(regla.cuerpo, propiedad);
    if (encontrado !== undefined) ultima = encontrado;
  }
  return ultima;
}

/* The two numbers the budget is made of used to be typed in here, so moving the sidebar or the page
   padding left every figure in this file quietly wrong. They are READ from the sheet instead: the
   first track of `.app-shell` when it is still a grid —at the compact step it is a block and the
   nav goes to the bottom— and the horizontal half of `main { padding }`. `[data-sidebar="rail"]`
   is deliberately not matched: that is the operator folding the bar, not the width the view has. */
const ES_ARMAZON = (parte: string) => parte === '.app-shell' || parte === '.app-shell[data-sidebar]';
const ES_MAIN = (parte: string) => parte === 'main';

export function anchoDeLaBarra(css: string, viewport: number): number {
  if (declaracionEfectiva(css, ES_ARMAZON, 'display', viewport) !== 'grid') return 0;
  const columnas = declaracionEfectiva(css, ES_ARMAZON, 'grid-template-columns', viewport);
  return columnas ? minimoDeUnaPista(partirEnPistas(columnas)[0]) : 0;
}

export function rellenoDelMain(css: string, viewport: number): number {
  const pistas = partirEnPistas(declaracionEfectiva(css, ES_MAIN, 'padding', viewport) ?? '');
  const horizontal = pistas.length >= 2 ? pistas.at(1) : pistas.at(0);
  return 2 * minimoDeUnaPista(horizontal ?? '0');
}

export function presupuestoDe(css: string, viewport: number): number {
  return viewport - anchoDeLaBarra(css, viewport) - rellenoDelMain(css, viewport);
}

function presupuesto(viewport: number): number {
  return presupuestoDe(GLOBAL, viewport);
}

function rejasEfectivas(hojas: { hoja: string; css: string }[], viewport: number): Map<string, { regla: ReglaCss; minimo: number }> {
  const efectiva = new Map<string, { regla: ReglaCss; minimo: number }>();
  for (const { hoja, css } of hojas) {
    for (const regla of reglasDe(css, hoja)) {
      const columnas = valor(regla.cuerpo, 'grid-template-columns');
      if (!columnas) continue;
      const topes = [...regla.media.matchAll(/max-width:\s*(\d+)px/g)].map((m) => Number(m[1]));
      const pisos = [...regla.media.matchAll(/min-width:\s*(\d+)px/g)].map((m) => Number(m[1]));
      if (topes.length && viewport > Math.min(...topes)) continue;
      if (pisos.length && viewport < Math.max(...pisos)) continue;
      efectiva.set(regla.selector, { regla, minimo: anchoMinimoDeLaReja(columnas) });
    }
  }
  return efectiva;
}

export function rejasQueNoCaben(hojas: { hoja: string; css: string }[], viewport: number): string[] {
  const tope = presupuesto(viewport);
  const fallos: string[] = [];
  for (const [selector, { regla, minimo }] of rejasEfectivas(hojas, viewport)) {
    if (minimo > tope) {
      fallos.push(
        `a ${String(viewport)}px, ${selector} exige ${String(minimo)}px y el hueco es ${String(tope)}px `
        + `(${regla.hoja}${regla.media ? ` · ${regla.media}` : ''}): ${valor(regla.cuerpo, 'grid-template-columns') ?? ''}`,
      );
    }
  }
  return fallos;
}

function hojasReales(): { hoja: string; css: string }[] {
  return HOJAS_DE_LA_CONSOLA.map((hoja) => ({ hoja, css: leerCss(hoja) }));
}

describe('ninguna reja exige más ancho del que su vista tiene', () => {
  it.each([360, 760, 1100, 1265, 1440, 1920, 2560])('a %ipx de ventana, todas las rejas caben', (viewport) => {
    expect(rejasQueNoCaben(hojasReales(), viewport)).toEqual([]);
  });

  it('el hueco sale de la hoja: la barra y el relleno son los que `base.css` declara', () => {
    expect([anchoDeLaBarra(GLOBAL, 1440), rellenoDelMain(GLOBAL, 1440)]).toEqual([248, 76]);
    expect([anchoDeLaBarra(GLOBAL, 1100), rellenoDelMain(GLOBAL, 1100)]).toEqual([78, 76]);
    // Al paso compacto el armazón deja de ser una reja: la navegación baja y no ocupa ancho.
    expect([anchoDeLaBarra(GLOBAL, 360), rellenoDelMain(GLOBAL, 360)]).toEqual([0, 30]);
  });

  it('CONTROL NEGATIVO — ensanchar la barra en la hoja mueve el hueco, no lo deja escrito acá', () => {
    const ancha = GLOBAL.replace(
      '.app-shell { display: grid; min-height: 100vh; grid-template-columns: 248px minmax(0, 1fr); }',
      '.app-shell { display: grid; min-height: 100vh; grid-template-columns: 420px minmax(0, 1fr); }',
    );
    expect(ancha).not.toBe(GLOBAL);
    expect(anchoDeLaBarra(ancha, 1440)).toBe(420);
    expect(presupuestoDe(ancha, 1440)).toBe(presupuestoDe(GLOBAL, 1440) - 172);
  });

  it('CONTROL NEGATIVO — marca la reja de /terminal de antes: 1018px de mínimo en 941 de hueco', () => {
    const hojas = hojasReales().map(({ hoja, css }) => ({
      hoja,
      css: css.replace(
        /\.ultimate-terminal-shell \{ display: grid; grid-template-columns:[^;]+;/,
        '.ultimate-terminal-shell { display: grid; grid-template-columns: 272px minmax(460px, 1fr) 286px;',
      ),
    }));
    expect(hojas.map((h) => h.css).join()).not.toBe(hojasReales().map((h) => h.css).join());
    expect(rejasQueNoCaben(hojas, 1265)).toContainEqual(expect.stringContaining('.ultimate-terminal-shell exige 1018px'));
  });

  it('CONTROL NEGATIVO — marca que se le quite a un móvil el corte que colapsa `.config-form`', () => {
    const hojas = hojasReales().map(({ hoja, css }) => ({
      hoja,
      css: hoja === 'styles.css' ? css.replace('  .config-form { grid-template-columns: 1fr; }\n', '') : css,
    }));
    expect(rejasQueNoCaben(hojas, 360)).toContainEqual(expect.stringContaining('.config-form exige 360px'));
  });

  it('`auto-fit` cuenta como UNA columna, que es lo que de verdad exige', () => {
    expect(anchoMinimoDeLaReja('repeat(auto-fit, minmax(272px, 1fr))')).toBe(272);
    expect(anchoMinimoDeLaReja('repeat(5, minmax(0, 1fr))')).toBe(0);
    expect(anchoMinimoDeLaReja('272px minmax(460px, 1fr) 286px')).toBe(1018);
    expect(anchoMinimoDeLaReja('minmax(0, 236px) minmax(0, 1fr) minmax(0, 264px)')).toBe(0);
  });
});

export function defectosDeAnchoPuntuales(global: string, config: string): string[] {
  const defectos: string[] = [];
  const limpio = sinComentarios(global);
  const propia = sinComentarios(config);

  const base = propia.slice(0, propia.indexOf('@media'));
  const areaGlobal = declaraciones(base, '.config-area');
  const columnas = valor(areaGlobal, 'grid-template-columns');
  if (!columnas || anchoMinimoDeLaReja(columnas) !== 0) {
    defectos.push(
      '.config-area no declara columnas que puedan encogerse: su pista implícita `auto` toma el '
      + 'mínimo de contenido del panel y se lleva el documento entero de lado en un teléfono',
    );
  }
  if (!/\bdisplay:\s*grid/.test(areaGlobal)) {
    defectos.push('.config-area ya no es una reja: esta comprobación quedó apuntando a nada');
  }

  if (valor(declaraciones(limpio, '.config-area > .panel, .panel'), 'min-width') !== '0') {
    defectos.push('`.panel` recuperó su mínimo automático de contenido: vuelve a poder desbordar a su contenedor');
  }

  return defectos;
}

function tokens(css: string): Record<string, string> {
  const tabla: Record<string, string> = {};
  for (const [, nombre, valorCrudo] of declaraciones(sinComentarios(css), ':root').matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
    tabla[nombre] = valorCrudo.trim();
  }
  return tabla;
}

function pixeles(expresion: string | undefined, tabla: Record<string, string>, saltos = 0): number {
  if (!expresion || saltos > 6) return Number.NaN;
  const referencia = /^var\(\s*(--[\w-]+)\s*\)$/.exec(expresion.trim());
  if (referencia) return pixeles(tabla[referencia[1]], tabla, saltos + 1);
  const px = /^(\d+(?:\.\d+)?)px$/.exec(expresion.trim());
  return px ? Number(px[1]) : Number.NaN;
}

/* The bar is a fixed strip `--nav-inferior-alto` tall with `overflow: visible`, so a row that does
   not fit is not cut: it is painted over the page and over the row above it. How many rows there
   are is not written anywhere — it comes out of the entry count divided by the declared columns —
   so the height is DERIVED here instead of being trusted to a comment. */
export function defectosDelMenuMovil(global: string, entradas = NAV_ENTRIES.length): string[] {
  const defectos: string[] = [];
  const estrecho = bloqueMedia(global, '@media (max-width: 760px)');
  if (!estrecho) return ['no hay bloque @media (max-width: 760px) en styles.css'];

  const lista = declaraciones(estrecho, '.sidebar nav ul');
  if (valor(lista, 'display') !== 'grid') {
    defectos.push(
      `el menú de móvil es ${valor(lista, 'display') ?? 'una caja sin display propio'} y no una reja: `
      + 'una tira que se arrastra esconde entradas sin decirlo',
    );
  }
  const columnas = valor(lista, 'grid-template-columns');
  const repeticion = columnas ? /repeat\(\s*(\d+)\s*,/.exec(columnas) : null;
  const cuantas = repeticion ? Number(repeticion[1]) : (columnas ? partirEnPistas(columnas).length : 0);
  if (cuantas < 3) {
    defectos.push(`el menú de móvil declara ${String(cuantas)} columnas: con ${String(entradas)} entradas no caben sin pisarse`);
  }

  const tabla = tokens(global);
  const filas = cuantas > 0 ? Math.ceil(entradas / cuantas) : 0;
  const altoFila = pixeles(valor(lista, 'grid-auto-rows'), tabla);
  const hueco = pixeles(valor(lista, 'gap'), tabla);
  const relleno = pixeles(valor(declaraciones(estrecho, '.sidebar'), 'padding'), tabla);
  const disponible = pixeles(tabla['--nav-inferior-alto'], tabla);
  const necesario = filas * altoFila + Math.max(0, filas - 1) * hueco + 2 * relleno;
  if ([altoFila, hueco, relleno, disponible].some(Number.isNaN) || filas === 0) {
    defectos.push('la barra inferior ya no declara alto de fila, hueco, relleno o `--nav-inferior-alto`: no se puede derivar si cabe');
  } else if (necesario > disponible) {
    defectos.push(
      `${String(entradas)} entradas en ${String(cuantas)} columnas son ${String(filas)} filas: `
      + `hacen falta ${String(necesario)}px y --nav-inferior-alto reserva ${String(disponible)}px, `
      + 'así que la fila sobrante se pinta encima de la página',
    );
  }

  const rotulo = declaraciones(estrecho, '.sidebar nav a span');
  if (valor(rotulo, 'white-space') !== 'normal') {
    defectos.push(
      `el rótulo del menú lleva white-space ${valor(rotulo, 'white-space') ?? 'heredado'}: sin permiso para `
      + 'partirse en dos renglones se sale de su enlace y se pisa con el de al lado',
    );
  }
  if (!valor(rotulo, 'min-height')) {
    defectos.push(
      'el rótulo no reserva sus dos renglones: la altura de la barra pasa a depender de qué palabras '
      + 'entren, y el compositor de /messages se ancla a un número que deja de ser cierto',
    );
  }
  return defectos;
}

describe('que quepa en la pantalla', () => {
  it('/config no puede irse de lado en un teléfono', () => {
    expect(defectosDeAnchoPuntuales(GLOBAL, CONFIG)).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca la vuelta a la reja implícita de `.config-area`', () => {
    const roto = CONFIG.replace(
      /\.config-area \{ display: grid; grid-template-columns:[^}]*\}/,
      '.config-area { display: grid; gap: 16px; }',
    );
    expect(roto).not.toBe(CONFIG);
    expect(defectosDeAnchoPuntuales(GLOBAL, roto)).toContainEqual(expect.stringContaining('.config-area no declara columnas'));
  });

  it('CONTROL NEGATIVO — marca que `.panel` recupere su mínimo de contenido', () => {
    const roto = GLOBAL.replace(
      '.config-area > .panel, .panel { min-width: 0; }',
      '.config-area > .panel, .panel { min-width: auto; }',
    );
    expect(roto).not.toBe(GLOBAL);
    expect(defectosDeAnchoPuntuales(roto, CONFIG)).toContainEqual(expect.stringContaining('`.panel` recuperó'));
  });

  it('el menú de móvil muestra sus entradas sin pisarse ni esconderse', () => {
    expect(defectosDelMenuMovil(GLOBAL)).toEqual([]);
  });

  it('CONTROL NEGATIVO — una entrada más de las que caben en dos filas se denuncia', () => {
    expect(defectosDelMenuMovil(GLOBAL, NAV_ENTRIES.length + 2))
      .toContainEqual(expect.stringContaining('filas'));
  });

  it('CONTROL NEGATIVO — marca volver a cuatro columnas, que con nueve entradas son tres filas', () => {
    const roto = GLOBAL.replace('grid-template-columns: repeat(5, minmax(0, 1fr)); grid-auto-rows: 57px;',
      'grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-rows: 57px;');
    expect(roto).not.toBe(GLOBAL);
    expect(defectosDelMenuMovil(roto)).toContainEqual(expect.stringContaining('--nav-inferior-alto reserva 130px'));
  });

  it('CONTROL NEGATIVO — marca la vuelta a la tira `flex` que se arrastra', () => {
    const roto = GLOBAL.replace(
      /\.sidebar nav ul \{ display: grid; grid-template-columns:[^}]*\}/,
      '.sidebar nav ul { display: flex; overflow-x: auto; gap: 4px; }',
    );
    expect(roto).not.toBe(GLOBAL);
    expect(defectosDelMenuMovil(roto)).toContainEqual(expect.stringContaining('no una reja'));
  });

  it('CONTROL NEGATIVO — marca el rótulo con `nowrap`, que es lo que hacía que se pisaran', () => {
    const roto = GLOBAL.replace(
      /(\.sidebar nav a span \{[^}]*?)white-space: normal;/,
      '$1white-space: nowrap;',
    );
    expect(roto).not.toBe(GLOBAL);
    expect(defectosDelMenuMovil(roto)).toContainEqual(expect.stringContaining('se pisa con el de al lado'));
  });
});
