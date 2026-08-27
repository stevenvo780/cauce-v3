import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAIZ = resolve(process.cwd(), 'src');
const leerCss = (ruta: string): string => {
  const abs = resolve(RAIZ, ruta);
  const contenido = readFileSync(abs, 'utf8');
  return contenido.replace(/@import\s+['"]([^'"]+)['"];/g, (_, importPath: string) => {
    const subAbs = resolve(abs, '..', importPath);
    return leerCss(subAbs);
  });
};
const GLOBAL = leerCss('styles.css');

function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function bloqueMedia(css: string, consulta: string): string {
  const limpio = sinComentarios(css);
  const inicio = limpio.indexOf(consulta);
  if (inicio < 0) return '';
  let cursor = limpio.indexOf('{', inicio);
  if (cursor < 0) return '';
  const desde = cursor + 1;
  let profundidad = 0;
  for (; cursor < limpio.length; cursor += 1) {
    if (limpio[cursor] === '{') profundidad += 1;
    else if (limpio[cursor] === '}') {
      profundidad -= 1;
      if (profundidad === 0) return limpio.slice(desde, cursor);
    }
  }
  return '';
}

function declaraciones(bloque: string, selector: string): string {
  const escapado = selector.replace(/[.[\]()="^$*+?|\\/{}-]/g, (c) => `\\${c}`);
  const patron = new RegExp(`(^|[},])\\s*${escapado}\\s*\\{([^{}]*)\\}`, 'g');
  let ultima = '';
  let encontrado: RegExpExecArray | null;
  while ((encontrado = patron.exec(bloque))) ultima = encontrado[2];
  return ultima;
}

function valor(declaracion: string, propiedad: string): string | undefined {
  const patron = new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`);
  return patron.exec(declaracion)?.[1]?.trim();
}

const HOJAS_DE_LA_CONSOLA = [
  'features/live/live.css',
  'features/live/live-hypergraph.css',
  'features/topology/hypergraph.css',
  'features/messages/messages.css',
  'features/terminal/terminal-panel.css',
  'features/config/config.css',
  'features/accounts/licenses.css',
  'features/auth/auth.css',
  'styles.css',
];

interface ReglaCss { hoja: string; selector: string; cuerpo: string; media: string }

export function reglasDe(css: string, hoja = ''): ReglaCss[] {
  const limpio = sinComentarios(css);
  const salida: ReglaCss[] = [];
  const pila: string[] = [];
  let cabecera = '';
  let cursor = 0;
  while (cursor < limpio.length) {
    const caracter = limpio[cursor];
    if (caracter === '{') {
      const titulo = cabecera.trim();
      cabecera = '';
      if (titulo.startsWith('@')) {
        pila.push(titulo);
        cursor += 1;
        continue;
      }
      let profundidad = 1;
      let fin = cursor + 1;
      while (fin < limpio.length && profundidad > 0) {
        if (limpio[fin] === '{') profundidad += 1;
        else if (limpio[fin] === '}') profundidad -= 1;
        fin += 1;
      }
      salida.push({
        hoja,
        selector: titulo,
        cuerpo: limpio.slice(cursor + 1, fin - 1),
        media: pila.filter((p) => p.startsWith('@media')).join(' Y '),
      });
      cursor = fin;
      continue;
    }
    if (caracter === '}') pila.pop();
    else cabecera += caracter;
    cursor += 1;
  }
  return salida;
}

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

function presupuesto(viewport: number): number {
  if (viewport <= 760) return viewport - 30;
  if (viewport <= 1100) return viewport - 78 - 76;
  return viewport - 248 - 76;
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
        `a ${viewport}px, ${selector} exige ${minimo}px y el hueco es ${tope}px `
        + `(${regla.hoja}${regla.media ? ` · ${regla.media}` : ''}): ${valor(regla.cuerpo, 'grid-template-columns')}`,
      );
    }
  }
  return fallos;
}

function hojasReales(): { hoja: string; css: string }[] {
  return HOJAS_DE_LA_CONSOLA.map((hoja) => ({ hoja, css: leerCss(hoja) }));
}

describe('ninguna reja exige más ancho del que su vista tiene', () => {
  it.each([360, 760, 1100, 1265, 1440])('a %ipx de ventana, todas las rejas caben', (viewport) => {
    expect(rejasQueNoCaben(hojasReales(), viewport)).toEqual([]);
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

export function defectosDeAnchoPuntuales(global: string): string[] {
  const defectos: string[] = [];
  const limpio = sinComentarios(global);

  const base = limpio.slice(0, limpio.indexOf('@media'));
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

export function defectosDelMenuMovil(global: string): string[] {
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
    defectos.push(`el menú de móvil declara ${cuantas} columnas: con ocho entradas no caben sin pisarse`);
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
    expect(defectosDeAnchoPuntuales(GLOBAL)).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca la vuelta a la reja implícita de `.config-area`', () => {
    const roto = GLOBAL.replace(
      /\.config-area \{ display: grid; grid-template-columns:[^}]*\}/,
      '.config-area { display: grid; gap: 16px; }',
    );
    expect(roto).not.toBe(GLOBAL);
    expect(defectosDeAnchoPuntuales(roto)).toContainEqual(expect.stringContaining('.config-area no declara columnas'));
  });

  it('CONTROL NEGATIVO — marca que `.panel` recupere su mínimo de contenido', () => {
    const roto = GLOBAL.replace(
      '.config-area > .panel, .panel { min-width: 0; }',
      '.config-area > .panel, .panel { min-width: auto; }',
    );
    expect(roto).not.toBe(GLOBAL);
    expect(defectosDeAnchoPuntuales(roto)).toContainEqual(expect.stringContaining('`.panel` recuperó'));
  });

  it('el menú de móvil muestra las ocho entradas sin pisarse ni esconderse', () => {
    expect(defectosDelMenuMovil(GLOBAL)).toEqual([]);
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
