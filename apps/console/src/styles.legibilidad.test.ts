import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * QUE SE PUEDA LEER Y QUE QUEPA EN LA PANTALLA, COMPROBADO SOBRE LAS HOJAS.
 *
 * Steven, textual: «esta interfaz está demasiado abarrotada sin aportar mucha info en sí». Detrás
 * de esa frase había cinco defectos MEDIDOS con Chrome sobre la consola servida en modo mock —no
 * leídos en el código— y los cinco pasaban las 646 pruebas de esta consola sin despeinarse:
 *
 *   · el botón secundario a 1,53:1 sobre blanco, o sea «Previsualizar el alta» invisible al lado
 *     de un «Crear» verde sólido: el camino seguro escondido y la trampa iluminada;
 *   · 71 elementos por debajo de AA en /accounts, 70 en /live, 20 en /observability;
 *   · el menú de móvil con los ocho rótulos pisándose entre sí («La flota ahoCuentas y cuota…»);
 *   · /config midiendo 699 px de ancho dentro de un teléfono de 360;
 *   · el inspector de /terminal 25 px FUERA de la pantalla, con «ALLOWED» leído «ALLO…».
 *
 * 🔴 **jsdom no tiene layout.** No hay `getBoundingClientRect` que valga, ni color calculado, ni
 * `scrollWidth`. Por eso ninguna prueba de DOM podía ver nada de esto, y por eso este fichero
 * comprueba las HOJAS como texto: es lo barato que sí atrapa la regresión. Cada afirmación lleva
 * su CONTROL NEGATIVO POR MUTACIÓN —se le da de comer la hoja rota y se exige que la marque—
 * porque un guardia que aprueba cualquier cosa es peor que no tenerlo.
 *
 * Lo que este fichero NO prueba, y hay que decirlo: que en un navegador real la pantalla se lea.
 * Eso se mide con `ops/console-legibilidad/medir.mjs`, que levanta vite en modo mock, abre Chrome
 * por CDP y calcula el contraste y los desbordes sobre el DOM de verdad, a 1280 y a 360.
 */

const RAIZ = resolve(process.cwd(), 'src');
const GLOBAL = readFileSync(resolve(RAIZ, 'styles.css'), 'utf8');

/* ------------------------------------------------------------------ lectura de la hoja ------ */

function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** El cuerpo de un `@media` contando llaves: dentro hay reglas anidadas. */
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

/** La ÚLTIMA declaración de un selector dentro de un bloque: en CSS gana la de más abajo. */
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

/* ------------------------------------------------------------------ color y contraste ------- */

interface Rgb { r: number; g: number; b: number; a: number }

function leerColor(texto: string): Rgb | undefined {
  const t = texto.trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(t);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(t);
  if (rgb) {
    const partes = rgb[1].split(/[\s,/]+/).filter(Boolean);
    const n = (v: string) => (v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : Number(v));
    const [r, g, b] = partes.slice(0, 3).map(Number);
    const a = partes.length > 3 ? n(partes[3]) : 1;
    if ([r, g, b, a].some(Number.isNaN)) return undefined;
    return { r, g, b, a };
  }
  return undefined;
}

/** Una capa translúcida compuesta sobre la de abajo. Sin esto, un tinte al 20% se mide como si no
 *  estuviera, y ese tinte es justo lo que le come 0,35 de ratio a la esquina superior derecha. */
function sobre(capa: Rgb, fondo: Rgb): Rgb {
  return {
    r: capa.r * capa.a + fondo.r * (1 - capa.a),
    g: capa.g * capa.a + fondo.g * (1 - capa.a),
    b: capa.b * capa.a + fondo.b * (1 - capa.a),
    a: 1,
  };
}

function luminancia({ r, g, b }: Rgb): number {
  const canal = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

/** WCAG 2.1 §1.4.3, tal cual: (Lmás claro + 0,05) / (Lmás oscuro + 0,05). */
export function contraste(frente: Rgb, fondo: Rgb): number {
  const a = luminancia(frente.a < 1 ? sobre(frente, fondo) : frente);
  const b = luminancia(fondo);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ------------------------------------------------------------------ los tokens del tema ----- */

function tokensDe(bloque: string): Record<string, string> {
  const tabla: Record<string, string> = {};
  for (const [, nombre, contenido] of bloque.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tabla[nombre] = contenido.trim();
  }
  return tabla;
}

/** Resuelve `var(--x)` en cadena; devuelve el color o `undefined` si el token no existe. */
function resolver(expresion: string, tabla: Record<string, string>, saltos = 0): Rgb | undefined {
  if (saltos > 8) return undefined;
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(expresion.trim());
  if (ref) {
    const destino = tabla[ref[1]] ?? ref[2];
    return destino === undefined ? undefined : resolver(destino, tabla, saltos + 1);
  }
  return leerColor(expresion);
}

/** El texto de una hoja SIN sus bloques `@media`: lo que vale cuando ninguna consulta encaja. */
function soloNivelSuperior(css: string): string {
  const limpio = sinComentarios(css);
  let salida = '';
  let profundidad = 0;
  let cabecera = '';
  let cursor = 0;
  while (cursor < limpio.length) {
    const caracter = limpio[cursor];
    if (caracter === '{') {
      if (profundidad === 0 && cabecera.trim().startsWith('@')) {
        // saltar el bloque entero
        let p = 1;
        let fin = cursor + 1;
        while (fin < limpio.length && p > 0) {
          if (limpio[fin] === '{') p += 1;
          else if (limpio[fin] === '}') p -= 1;
          fin += 1;
        }
        cabecera = '';
        cursor = fin;
        continue;
      }
      salida += cabecera + caracter;
      cabecera = '';
      profundidad += 1;
    } else if (caracter === '}') {
      profundidad -= 1;
      salida += caracter;
    } else if (profundidad > 0) salida += caracter;
    else cabecera += caracter;
    cursor += 1;
  }
  return salida;
}

interface Tema { nombre: string; tokens: Record<string, string>; tintes: Rgb[] }

/**
 * Los dos temas de la consola. El claro NO es una hoja aparte: es el `:root` de dentro de
 * `@media (prefers-color-scheme: light)` redefiniendo los mismos tokens, así que hereda todo lo
 * que ese bloque no toque. Esa herencia es exactamente por donde entraron los defectos: cinco
 * literales de texto escritos a mano en el tema oscuro que el bloque claro no redefinía nunca.
 */
function temas(css: string): [Tema, Tema] {
  /*
   * 🔴 El tema oscuro se lee del NIVEL SUPERIOR, no de la hoja entera. `declaraciones()` se queda
   * con la última coincidencia, y la última regla `body` del fichero está DENTRO del bloque de
   * modo claro: leyendo la hoja entera, el tema oscuro se medía contra el degradado del tema
   * claro. Es el mismo error de método que este fichero existe para atrapar —un dato fresco
   * medido contra el objeto equivocado— y da falsos positivos, que son los que ciegan al resto.
   */
  const superior = soloNivelSuperior(css);
  const raizOscura = tokensDe(declaraciones(superior, ':root'));
  const bloqueClaro = bloqueMedia(css, '@media (prefers-color-scheme: light)');
  const raizClara = { ...raizOscura, ...tokensDe(declaraciones(bloqueClaro, ':root')) };
  return [
    { nombre: 'oscuro', tokens: raizOscura, tintes: tintesDelFondo(declaraciones(superior, 'body'), raizOscura) },
    { nombre: 'claro', tokens: raizClara, tintes: tintesDelFondo(declaraciones(bloqueClaro, 'body'), raizClara) },
  ];
}

/**
 * El PEOR fondo de la página no es `--bg`: es `--bg` más el degradado decorativo del `body`. En la
 * esquina superior derecha ese tinte le come ~0,35 de ratio a todo lo que caiga encima —y ahí es
 * donde viven el estado de sesión y los avisos—, así que entra en la cuenta como un fondo más.
 */
function tintesDelFondo(cuerpoBody: string, tabla: Record<string, string>): Rgb[] {
  const fondo = valor(cuerpoBody, 'background');
  const base = resolver('var(--bg)', tabla);
  if (!base) return [];
  const capas = fondo
    ? [...fondo.matchAll(/rgba?\([^)]*\)/g)]
      .map((m) => leerColor(m[0]))
      .filter((c): c is Rgb => Boolean(c) && (c as Rgb).a > 0 && (c as Rgb).a < 1)
    : [];
  // Cada capa por separado —los degradados de la portada no se solapan— y `--bg` desnudo, que es
  // lo que se ve en el centro de la página. Decide el PEOR de todos, y lo decide el aserto, que
  // es el único que conoce el color del texto.
  return [base, ...capas.map((capa) => sobre(capa, base))];
}

/* ------------------------------------------------------------------ la tabla de parejas ----- */

/**
 * Cada fila es una pareja (texto, fondo) que EXISTE en la consola y que se midió en Chrome. No es
 * un producto cartesiano: `--mint` sobre `--surface-3` daría 4,25 y no está en la tabla porque no
 * hay texto verde sobre esa superficie en ninguna vista. Un guardia que inventa parejas obliga a
 * oscurecer colores que nadie usa, y eso ES bajar la calidad para que pase una prueba.
 *
 * `fondos` admite `TINTE`, que es «`--bg` más el degradado decorativo del body».
 */
const TINTE = '@tinte';
const AA_TEXTO_NORMAL = 4.5;

interface Pareja { texto: string; fondos: string[]; minimo?: number; porque: string }

const PAREJAS: Pareja[] = [
  {
    texto: '--text', fondos: ['--bg', '--surface', '--surface-2', TINTE],
    porque: 'el texto de la página',
  },
  {
    texto: '--muted', fondos: ['--bg', '--surface', '--surface-2', '--amber-dim', TINTE],
    porque: 'descripciones de panel, pies de tarjeta, pestañas INACTIVAS de `.view-tabs`',
  },
  {
    texto: '--faint', fondos: ['--bg', '--surface', '--surface-2', '--surface-3', TINTE],
    porque: 'cabeceras de tabla, sublíneas, `dt`, el color de MÁS elementos de toda la consola',
  },
  {
    texto: '--text-2', fondos: ['--bg', '--surface', '--surface-2', '--surface-3', TINTE],
    porque: 'celdas de tabla, `dd`, rótulos de formulario y el BOTÓN SECUNDARIO (defecto 1)',
  },
  {
    texto: '--on-mint', fondos: ['--mint-dim'],
    porque: 'las insignias ONLINE / ENABLED / FRESCO: 135 elementos a 1,15:1 antes de esto',
  },
  { texto: '--on-blue', fondos: ['--blue-dim'], porque: 'insignias EN COLA / TRABAJANDO / SERVER' },
  { texto: '--on-amber', fondos: ['--amber-dim'], porque: 'insignias de aviso y el cartel MOCK API' },
  { texto: '--on-red', fondos: ['--red-dim'], porque: 'insignias COLGADO / ACK vencido / DISABLED' },
  {
    texto: '--mint', fondos: ['--bg', '--surface', TINTE],
    porque: 'el `.eyebrow` de cada página y el nombre de la sesión en la barra superior',
  },
  { texto: '--blue', fondos: ['--bg', '--surface', TINTE], porque: 'enlaces y el icono de estado de entrega' },
  { texto: '--amber', fondos: ['--bg', '--surface', '--amber-dim', TINTE], porque: 'avisos y valores UNKNOWN' },
  { texto: '--red', fondos: ['--bg', '--surface', TINTE], porque: 'errores y `.error-copy`' },
  { texto: '--violet', fondos: ['--bg', TINTE], porque: 'la delegación en el hipergrafo de /live' },
  { texto: '--lime', fondos: ['--bg', TINTE], porque: 'la respuesta cerrada en el hipergrafo de /live' },
];

function fondosDe(nombre: string, tema: Tema): Rgb[] {
  if (nombre === TINTE) return tema.tintes;
  const color = resolver(`var(${nombre})`, tema.tokens);
  return color ? [color] : [];
}

/** El informe completo, no un booleano: el control negativo exige la pareja concreta. */
export function parejasBajoAA(css: string): string[] {
  const fallos: string[] = [];
  for (const tema of temas(css)) {
    for (const pareja of PAREJAS) {
      const texto = resolver(`var(${pareja.texto})`, tema.tokens);
      if (!texto) {
        fallos.push(`[${tema.nombre}] ${pareja.texto} no está declarado o no resuelve a un color`);
        continue;
      }
      for (const nombreFondo of pareja.fondos) {
        const fondos = fondosDe(nombreFondo, tema);
        if (!fondos.length) {
          fallos.push(`[${tema.nombre}] el fondo ${nombreFondo} no resuelve a un color`);
          continue;
        }
        const ratio = Math.min(...fondos.map((fondo) => contraste(texto, fondo)));
        const minimo = pareja.minimo ?? AA_TEXTO_NORMAL;
        if (ratio + 0.005 < minimo) {
          fallos.push(
            `[${tema.nombre}] ${pareja.texto} sobre ${nombreFondo} = ${ratio.toFixed(2)}:1, `
            + `hace falta ${minimo} — ${pareja.porque}`,
          );
        }
      }
    }
  }
  return fallos;
}

describe('contraste de los tokens de color (WCAG 2.1 AA)', () => {
  it('ninguna pareja (texto, fondo) que la consola usa de verdad baja de 4,5:1, en los DOS temas', () => {
    expect(parejasBajoAA(GLOBAL)).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca el `--faint` de antes, que dejaba las cabeceras de tabla a 3,66:1', () => {
    const roto = GLOBAL.replace(
      /(@media \(prefers-color-scheme: light\)[\s\S]*?)--faint: #[0-9a-f]{6};/,
      '$1--faint: #718198;',
    );
    expect(roto).not.toBe(GLOBAL);
    expect(parejasBajoAA(roto)).toContainEqual(expect.stringContaining('[claro] --faint sobre'));
  });

  it('CONTROL NEGATIVO — marca la insignia ONLINE de antes: verde claro sobre verde claro, 1,15:1', () => {
    const roto = GLOBAL.replace(/(@media \(prefers-color-scheme: light\)[\s\S]*?)--on-mint: #[0-9a-f]{6};/, '$1--on-mint: #8ff0d3;');
    expect(roto).not.toBe(GLOBAL);
    expect(parejasBajoAA(roto)).toContainEqual(expect.stringContaining('[claro] --on-mint sobre --mint-dim'));
  });

  it('CONTROL NEGATIVO — marca que se borre un token entero en vez de arreglarlo', () => {
    const roto = GLOBAL.replace(/\s*--text-2: #[0-9a-f]{6};/g, '');
    expect(roto).not.toBe(GLOBAL);
    expect(parejasBajoAA(roto)).toContainEqual(expect.stringContaining('--text-2 no está declarado'));
  });

  it('el degradado decorativo del body ENTRA en la cuenta: es un fondo real de la página', () => {
    const [oscuro, claro] = temas(GLOBAL);
    for (const tema of [oscuro, claro]) {
      const base = resolver('var(--bg)', tema.tokens) as Rgb;
      // Si el degradado se ignorara, la lista sería sólo `--bg` y la tabla mediría de menos: en
      // modo claro ese tinte azul le come ~0,35 de ratio a la esquina donde vive la sesión.
      expect(tema.tintes.length).toBeGreaterThan(1);
      expect(tema.tintes.slice(1).some((t) => Math.abs(luminancia(t) - luminancia(base)) > 0.005)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ anchos y desbordes ------ */

const HOJAS_DE_LA_CONSOLA = [
  'features/live/live.css',
  'features/live/live-hypergraph.css',
  'features/topology/hypergraph.css',
  'features/messages/messages.css',
  'features/terminal/terminal-panel.css',
  'features/config/config.css',
  'features/licenses/licenses.css',
  'features/auth/auth.css',
  // `styles.css` va la ÚLTIMA a propósito: es el orden en que vite las concatena (COMPROBADO
  // sobre el bundle de producción), y por eso una regla suya gana a igual especificidad.
  'styles.css',
];

interface ReglaCss { hoja: string; selector: string; cuerpo: string; media: string }

/** Todas las reglas de una hoja, con la consulta `@media` en la que viven (o ''). */
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

/** El mínimo en píxeles de una pista: `1fr`, `auto`, `%` y `minmax(0, …)` valen 0; un `px` vale. */
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

/** El ancho mínimo que una `grid-template-columns` le EXIGE a su contenedor. */
export function anchoMinimoDeLaReja(valorCss: string): number {
  let total = 0;
  let resto = valorCss;
  for (const encontrado of [...valorCss.matchAll(/repeat\(\s*([\w-]+)\s*,\s*((?:[^()]|\([^()]*\))*)\)/g)]) {
    // `auto-fit` y `auto-fill` sólo exigen UNA columna: por eso son la forma segura de repetir.
    const veces = /^\d+$/.test(encontrado[1]) ? Number(encontrado[1]) : 1;
    total += veces * partirEnPistas(encontrado[2]).reduce((suma, p) => suma + minimoDeUnaPista(p), 0);
    resto = resto.replace(encontrado[0], ' ');
  }
  for (const pista of partirEnPistas(resto)) total += minimoDeUnaPista(pista);
  return total;
}

/**
 * El presupuesto de ancho de una vista. No es el viewport: hay que descontar la barra lateral y el
 * padding de `main`, que es justo lo que nadie descontó cuando escribió `272px minmax(460px,1fr)
 * 286px` = 1018 px de mínimo para un hueco de 941.
 */
function presupuesto(viewport: number): number {
  if (viewport <= 760) return viewport - 30; // main: padding 15px a cada lado, sin barra lateral
  if (viewport <= 1100) return viewport - 78 - 76; // barra lateral colapsada a iconos
  return viewport - 248 - 76;
}

/** La regla que MANDA para un selector a un ancho dado: la última cuya consulta encaja. */
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
  return HOJAS_DE_LA_CONSOLA.map((hoja) => ({ hoja, css: readFileSync(resolve(RAIZ, hoja), 'utf8') }));
}

describe('ninguna reja exige más ancho del que su vista tiene', () => {
  /*
   * 1265 y no 1280: en un escritorio con barra de desplazamiento clásica el `clientWidth` de un
   * ventana de 1280 es 1265, y esos 15 px eran parte de los 64 que faltaban. Medir contra el
   * número redondo del catálogo en vez de contra el que da el navegador es cómo se llega a un
   * inspector 25 px fuera de la pantalla creyendo que entra.
   */
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

/* ------------------------------------------------------------------ el resto de los cinco --- */

/**
 * Lo que el barrido de rejas NO puede ver, porque no es una reja demasiado ancha sino la ausencia
 * de una: `.config-area` es `display: grid` SIN `grid-template-columns`, y una pista implícita
 * `auto` tiene por mínimo el MÍNIMO DE CONTENIDO de su ítem. Con un panel dentro, ese mínimo era
 * 684 px y arrastraba el documento entero a 699 dentro de un teléfono de 360.
 */
export function defectosDeAnchoPuntuales(global: string, config: string): string[] {
  const defectos: string[] = [];
  const limpio = sinComentarios(global);

  const areaGlobal = declaraciones(limpio, '.config-area');
  const columnas = valor(areaGlobal, 'grid-template-columns');
  if (!columnas || anchoMinimoDeLaReja(columnas) !== 0) {
    defectos.push(
      '.config-area no declara columnas que puedan encogerse: su pista implícita `auto` toma el '
      + 'mínimo de contenido del panel y se lleva el documento entero de lado en un teléfono',
    );
  }
  if (!/\bdisplay:\s*grid/.test(declaraciones(sinComentarios(config), '.config-area'))) {
    defectos.push('.config-area ya no es una reja: esta comprobación quedó apuntando a nada');
  }

  // El cinturón general: un panel metido en una reja o en un flex no puede imponer su ancho.
  if (valor(declaraciones(limpio, '.config-area > .panel, .config-grid > .panel, .panel'), 'min-width') !== '0') {
    defectos.push('`.panel` recuperó su mínimo automático de contenido: vuelve a poder desbordar a su contenedor');
  }

  return defectos;
}

/**
 * El menú de móvil. El defecto no era que fuera estrecho: era que los rótulos, con `nowrap` y sin
 * recorte, se salían de su propio enlace y se PISABAN con el de al lado, y que la tira sumaba
 * 493 px en 344 de hueco, así que dos entradas sólo se alcanzaban arrastrando y nada lo decía.
 */
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
  const CONFIG = readFileSync(resolve(RAIZ, 'features/config/config.css'), 'utf8');

  it('/config no puede irse de lado en un teléfono', () => {
    expect(defectosDeAnchoPuntuales(GLOBAL, CONFIG)).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca la vuelta a la reja implícita de `.config-area`', () => {
    const roto = GLOBAL.replace(/\.config-area \{ grid-template-columns:[^}]*\}/, '.config-area { gap: 16px; }');
    expect(roto).not.toBe(GLOBAL);
    expect(defectosDeAnchoPuntuales(roto, CONFIG)).toContainEqual(expect.stringContaining('.config-area no declara columnas'));
  });

  it('CONTROL NEGATIVO — marca que `.panel` recupere su mínimo de contenido', () => {
    const roto = GLOBAL.replace(
      '.config-area > .panel, .config-grid > .panel, .panel { min-width: 0; }',
      '.config-area > .panel, .config-grid > .panel, .panel { min-width: auto; }',
    );
    expect(roto).not.toBe(GLOBAL);
    expect(defectosDeAnchoPuntuales(roto, CONFIG)).toContainEqual(expect.stringContaining('`.panel` recuperó'));
  });

  it('el menú de móvil muestra las ocho entradas sin pisarse ni esconderse', () => {
    expect(defectosDelMenuMovil(GLOBAL)).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca la vuelta a la tira `flex` que se arrastra', () => {
    // La reja del menú de ESCRITORIO también empieza por `display: grid`: sin citar las columnas,
    // la mutación caía sobre ella y el bloque de móvil quedaba intacto — un control negativo que
    // muta la regla equivocada aprueba el defecto que venía a buscar.
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
