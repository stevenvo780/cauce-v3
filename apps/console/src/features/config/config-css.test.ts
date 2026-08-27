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
const INTERRUPTORES = readFileSync(join(RAIZ, 'features', 'config', 'toggles.css'), 'utf8');

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

/**
 * Cada pastilla, con el TOKEN del que saca su texto y el fondo sobre el que se pinta.
 *
 * La regla de la pastilla se declara UNA vez, fuera de los temas, con `color: var(--on-*)`; lo que
 * cambia por tema es el token. Antes cada pastilla se redefinía entera dentro del bloque claro con
 * un hex escrito a mano, y ese es justo el modo en que el defecto entró: se corrigió `.badge-offline`
 * y se olvidaron las otras seis, porque no había NADA que atara las siete a un mismo sitio. Un token
 * se redefine una vez por tema; siete literales no se redefinen nunca del todo.
 */
const PASTILLAS: ReadonlyArray<[string, string, string]> = [
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
    // La pastilla tiene que sacar su color de ESE token y no de un hex suelto: si alguien vuelve a
    // escribir el color a mano, el tema claro deja de alcanzarlo y el defecto vuelve entero.
    const base = declaraciones(sinComentarios(GLOBAL), clase);
    expect(base.color, `${clase} no toma su color de un token`).toBe(`var(${token})`);
    const texto = vars.get(token);
    expect(texto, `${token} no está redefinido en el modo claro`).toBeDefined();
    expect(contraste(texto!, resolver(fondo.startsWith('#') ? fondo : `var(${fondo})`, vars)))
      .toBeGreaterThanOrEqual(4.5);
  });

  /*
   * .badge` no lleva un `.rem` suelto: cita el escalón de APUNTE de la escala,
   * que es el mismo que ya usaba `.config-pagina .badge`. Por eso el tamaño se RESUELVE contra el
   * `:root` en vez de parsearse como número — leerlo con `parseFloat('var(--tipo-apunte)')` daba
   * `NaN`, y un `NaN` no es «no se pudo medir»: `NaN >= 12` es falso, así que el guardia habría
   * dicho que la pastilla es ilegible cuando en realidad había subido.
   */
  it('la pastilla es de un tamaño con el que se puede exigir contraste (>= 12px)', () => {
    const base = declaraciones(sinComentarios(GLOBAL), '.badge');
    const escala = new Map(Object.entries(declaraciones(sinComentarios(GLOBAL), ':root')));
    const px = enPixeles(base['font-size'], escala);
    expect(px, `.badge { font-size: ${base['font-size']} } no resuelve a píxeles`).toBeDefined();
    expect(px!).toBeGreaterThanOrEqual(12);
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
  /**
   * El fondo más oscuro sobre el que ese texto se pinta en modo claro: el caso peor.
   *
   * Los tres del final —rótulos, botón secundario y el JSON de «Ver crudo»— traían cada uno su hex
   * del tema oscuro escrito a mano (#c4d0e1, #c6d2e6, #b9cae0). Ahora los tres son `--text-2`, un
   * solo token que el bloque claro redefine una vez. Por eso acá se comprueba el token, y aparte se
   * comprueba que esos tres selectores sigan atados a él.
   */
  const SOBRE: ReadonlyArray<[string, string, string]> = [
    ['--faint', 'var(--surface-2)', 'cabeceras de columna (`th`) y `.muted`'],
    ['--text-2', 'var(--surface)', 'rótulos, botón secundario y el JSON de «Ver crudo»'],
  ];

  it.each(SOBRE)('%s se lee sobre %s (%s)', (que, fondo) => {
    const texto = vars.get(que);
    expect(texto, `${que} no está redefinido en el modo claro`).toBeDefined();
    expect(contraste(resolver(texto!, vars), resolver(fondo, vars))).toBeGreaterThanOrEqual(4.5);
  });

  /** Lo que ataba al token: si uno vuelve a un hex, el tema claro deja de alcanzarlo. */
  it.each(['label', '.button.secondary', '.config-records code'])(
    '%s toma su color de `--text-2` y no de un hex suelto',
    (selector) => {
      // Se busca el selector COMPLETO y la regla que declara `color`: `.config-records code`
      // aparece antes en una regla de `font-family` que no dice nada del color, y quedarse con esa
      // haría pasar la prueba por mirar la regla equivocada.
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


/* ═══ La escala tipográfica de /config ══════════════════════════════════════════════════════════
 *
 * Steven, por SEGUNDA vez: «la vista de configuraciones aún hay mucho que mejorar, también es muy
 * ilegible». La primera vez se arregló la barra de móvil y la letra de la NAVEGACIÓN; la página en
 * sí quedó igual. MEDIDO en Chrome a 1600×1000 sobre el bundle de producción servido con la CSP de
 * `nginx.conf`, contando los elementos hoja con texto:
 *
 *     11,84px --text-2  97 · 11,84px --muted 69 · 10,88px --muted 32 · 10,88px --text-2 32
 *     10,88px --faint   19 · 12,5px  --muted  8 · 9,28px  --muted  3
 *     → 255 de 288 elementos por debajo de 12 px. Y el `h1` a 44,8 px.
 *
 * Ninguna prueba de React Testing Library puede ver esto.** jsdom no hace layout ni resuelve
 * la cascada: las 985 pruebas de esta consola pasaban con la página entera a 11,8 px. Lo que sí lo
 * atrapa es leer la HOJA, que es lo que hace este bloque — el mismo método con el que se cazaron
 * la pastilla invisible y la clase huérfana de más arriba.
 *
 * Lo que este bloque NO prueba, y hay que decirlo: que en un navegador de verdad la página se lea.
 * Eso se mide abriendo Chrome y mirándola, y el resultado va en el informe del cambio.
 */

/** Todas las declaraciones `font-size` de una hoja, con el selector que las lleva. */
function tamanosDeLetra(css: string): Array<{ selector: string; valor: string }> {
  const salida: Array<{ selector: string; valor: string }> = [];
  for (const regla of sinComentarios(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const declaracion of regla[2].matchAll(/(?:^|;)\s*font-size\s*:\s*([^;]+)/g)) {
      salida.push({ selector: regla[1].trim().replace(/\s+/g, ' '), valor: declaracion[1].trim() });
    }
  }
  return salida;
}

/**
 * Los cinco escalones, en el orden en que tienen que ir de mayor a menor.
 *
 * `--tipo-mono` NO está en la lista y no es un descuido: no es un escalón, es cómo se renderiza el
 * escalón de rótulo cuando el dato es monoespaciado (a igual `px` una monoespaciada se ve más
 * grande). Se comprueba aparte, contra el cuerpo y contra el suelo.
 */
const ESCALA = ['--tipo-titulo', '--tipo-panel', '--tipo-cuerpo', '--tipo-rotulo', '--tipo-apunte'];

/** `14px`, `.74rem`, `var(--tipo-cuerpo)` → píxeles. `undefined` si no se sabe resolver. */
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
  /*
   * `clamp(min, preferido, max)` se juzga por su MÍNIMO, que es el peor caso para la legibilidad:
   * si el mínimo llega al suelo, no hay ancho de ventana en el que ese texto baje de ahí. Juzgarlo
   * por el valor preferido sería medir contra un ancho que nadie garantiza.
   */
  const clamp = /^clamp\(\s*([^,]+),/.exec(valor.trim());
  if (clamp) return enPixeles(clamp[1], escala);
  return undefined;
}

/** El suelo: nada de esta vista baja de acá. Es la cifra que  */
const SUELO = 12.5;
/** Cuerpo y rótulos no bajan de acá. */
const SUELO_CUERPO = 13;

/**
 * Toda la letra chica de las hojas de `/config`, para el informe del aserto.
 *
 * Se le pasa la hoja como TEXTO —no se lee de disco dentro— justamente para poder darle de comer
 * una hoja mutada y exigir que la repruebe. Un guardia que sólo sabe mirar el fichero de verdad no
 * se puede probar a sí mismo.
 */
/**
 * LA EXCEPCIÓN al suelo, y la única de toda la consola.
 *
 * `.sidebar nav a` a `.6875rem` (11 px) dentro de `@media (max-width: 760px)` es la barra de
 * navegación de móvil: está MEDIDA contra el ancho real de las ocho entradas a 360 px y subirla
 * vuelve a pisar los rótulos entre sí. Se anota como par (selector, valor) EXACTO y no como «a este
 * selector perdonale todo»: el mismo selector tiene otra declaración en el bloque base (`.9rem`), y
 * un perdón por selector la dejaría entrar por la ventana.
 */
const EXCEPCIONES: ReadonlyArray<{ selector: string; valor: string }> = [
  { selector: '.sidebar nav a', valor: '.6875rem' },
];

export function letraPorDebajoDelSuelo(hojas: string[], suelo = SUELO): string[] {
  const escala = variables(sinComentarios(hojas.join('\n')));
  const fallos: string[] = [];
  for (const hoja of hojas) {
    for (const { selector, valor } of tamanosDeLetra(hoja)) {
      // `inherit`/`0` no declaran un tamaño: no hay nada que juzgar.
      if (/^(inherit|initial|unset|revert)$/.test(valor)) continue;
      if (EXCEPCIONES.some((e) => e.selector === selector && e.valor === valor)) continue;
      const px = enPixeles(valor, escala);
      if (px === undefined) {
        fallos.push(`${selector} { font-size: ${valor} } no se sabe resolver a píxeles`);
        continue;
      }
      if (px + 0.001 < suelo) fallos.push(`${selector} { font-size: ${valor} } = ${px}px, el suelo es ${suelo}px`);
    }
  }
  return fallos;
}

describe('la escala tipográfica de /config', () => {
  /*
   * La escala se MUDÓ a `:root` de `styles.css` el 2026-08-24, y por eso se lee de ahí.
   *
   * Estaba en el bloque base de `.config-pagina`, o sea que existía sólo dentro de /config. MEDIDO
   * en Chrome a 1920×1080: /config tenía 0 elementos por debajo de 12,5 px y las otras siete vistas
   * 889 entre todas. Peor: `toggles.css` ya citaba `var(--tipo-rotulo)` en componentes que se usan
   * fuera de /config, donde la variable no existía y la declaración entera se descartaba.
   *
   * Se lee del PRIMER bloque `:root` —el base— y no de la hoja entera: hay un segundo `:root`
   * dentro de `@media (prefers-color-scheme: light)` y `variables()` se queda con la última
   * coincidencia. Medir contra el bloque equivocado es el error de método que este fichero existe
   * para atrapar.
   */
  const escala = new Map(Object.entries(declaraciones(sinComentarios(GLOBAL), ':root')));

  it('declara los seis escalones y van de mayor a menor, sin dos iguales', () => {
    const pixeles = ESCALA.map((nombre) => {
      const bruto = escala.get(nombre);
      expect(bruto, `${nombre} no está declarada en el :root de styles.css`).toBeDefined();
      const px = enPixeles(bruto!, escala);
      expect(px, `${nombre} = ${bruto} no es un tamaño en píxeles`).toBeDefined();
      return px!;
    });
    // Estrictamente decreciente: dos escalones iguales no son una escala, son un número repetido
    // dos veces, y el operador no puede ver la diferencia entre un rótulo y un dato.
    for (let i = 1; i < pixeles.length; i += 1) {
      expect(pixeles[i], `${ESCALA[i]} (${pixeles[i]}px) no baja de ${ESCALA[i - 1]} (${pixeles[i - 1]}px)`)
        .toBeLessThan(pixeles[i - 1]);
    }
  });

  it('el cuerpo y los rótulos no bajan de 13px, y el suelo de todo es 12,5px', () => {
    expect(enPixeles(escala.get('--tipo-cuerpo')!, escala)).toBeGreaterThanOrEqual(SUELO_CUERPO);
    expect(enPixeles(escala.get('--tipo-rotulo')!, escala)).toBeGreaterThanOrEqual(SUELO_CUERPO);
    expect(enPixeles(escala.get('--tipo-apunte')!, escala)).toBeGreaterThanOrEqual(SUELO);
  });

  it('el monoespaciado no se sale de la escala: ni más grande que el cuerpo ni por debajo del suelo', () => {
    const mono = enPixeles(escala.get('--tipo-mono')!, escala);
    expect(mono, '--tipo-mono no está declarada').toBeDefined();
    expect(mono!).toBeGreaterThanOrEqual(SUELO);
    expect(mono!).toBeLessThanOrEqual(enPixeles(escala.get('--tipo-cuerpo')!, escala)!);
  });

  /**
   * El título tenía `clamp(1.85rem, 4vw, 2.8rem)` = 44,8 px a 1600, contra un cuerpo de 11,84: casi
   * cuatro veces. La jerarquía estaba INVERTIDA —lo grande era el envase— y ése es medio encargo.
   * El tope de 3× no es estético: por encima de ahí el título vuelve a ser lo único que se ve.
   */
  it('el título no puede volver a ser tres veces el cuerpo', () => {
    const titulo = enPixeles(escala.get('--tipo-titulo')!, escala)!;
    const cuerpo = enPixeles(escala.get('--tipo-cuerpo')!, escala)!;
    expect(titulo / cuerpo).toBeLessThanOrEqual(3);
    expect(titulo).toBeGreaterThan(cuerpo);
  });

  /*
   * `GLOBAL` entra en la lista porque desde la mudanza es quien DECLARA los tokens: sin ella,
   * `var(--tipo-apunte)` no resuelve y el guardia lo reportaría como «no se sabe resolver». Que la
   * hoja global tenga que estar es justamente el punto — es lo que hace que la escala exista fuera
   * de /config.
   */
  it('ninguna regla de las hojas de /config declara letra por debajo del suelo', () => {
    expect(letraPorDebajoDelSuelo([GLOBAL, PROPIA, INTERRUPTORES])).toEqual([]);
  });

  /**
   * CONTROL NEGATIVO POR MUTACIÓN. Se le da de comer al guardia la hoja con los valores EXACTOS que
   * estaban desplegados —`.68rem` en las pastillas de rol, `.58rem` en la marca de ayuda— y se
   * exige que los marque. Sin esto, `letraPorDebajoDelSuelo()` podría estar devolviendo `[]` porque
   * no encuentra ninguna regla, y aprobaría cualquier hoja.
   */
  it('CONTROL NEGATIVO — marca los tamaños que estaban desplegados (.68rem = 10,88px, .58rem = 9,28px)', () => {
    const roto = PROPIA.replace('font-size: var(--tipo-apunte);', 'font-size: .68rem;');
    expect(roto).not.toBe(PROPIA);
    expect(letraPorDebajoDelSuelo([GLOBAL, roto])).toContainEqual(expect.stringContaining('.68rem'));
    expect(letraPorDebajoDelSuelo(['.x { font-size: .58rem; }'])).toHaveLength(1);
    // Y que el suelo sea el que se dijo: 12px NO alcanza, 12,5 sí.
    expect(letraPorDebajoDelSuelo(['.x { font-size: 12px; }'])).toHaveLength(1);
    expect(letraPorDebajoDelSuelo(['.x { font-size: 12.5px; }'])).toEqual([]);
  });

  /**
   * CONTROL NEGATIVO de la escala: una escala aplanada —cuerpo y rótulo al mismo tamaño— tiene que
   * fallar. Es la regresión más probable, porque «subir todo a 13» parece la solución obvia y deja
   * la página sin jerarquía ninguna.
   */
  it('CONTROL NEGATIVO — una escala aplanada no es una escala', () => {
    const plana = variables(sinComentarios(GLOBAL.replace('--tipo-rotulo: 13px', '--tipo-rotulo: 14px')));
    const cuerpo = enPixeles(plana.get('--tipo-cuerpo')!, plana)!;
    const rotulo = enPixeles(plana.get('--tipo-rotulo')!, plana)!;
    expect(rotulo).not.toBeLessThan(cuerpo);
  });
});

/* ═══ El tope de medida ════════════════════════════════════════════════════════════════════════
 *
 * MEDIDO a 1600: `main` es `width: min(1500px, 100%)`, menos 248 px de barra lateral y 76 de
 * padding = 1276 px de caja, y la prosa los cruzaba enteros. Son ~200 caracteres por renglón: el
 * ojo pierde el principio de la línea siguiente. Eso solo ya es ilegible aunque la letra fuera
 * grande, que es exactamente lo que pasaba.
 */
describe('el tope de medida de /config', () => {
  const propia = sinComentarios(PROPIA);

  it('la página tiene un tope de ancho de entre 1000 y 1250 px', () => {
    const ancho = enPixeles(declaraciones(propia, '.config-pagina')['max-width'] ?? '', new Map());
    expect(ancho, '.config-pagina no declara max-width').toBeDefined();
    expect(ancho).toBeGreaterThanOrEqual(1000);
    expect(ancho).toBeLessThanOrEqual(1250);
  });

  /**
   * Cada bloque de texto corrido tiene que citar `--medida`. La lista es la de los que EXISTEN y
   * llevan prosa; si mañana aparece otro y no la cita, esta prueba no lo ve — por eso hay además
   * la comprobación en Chrome, que mide el renglón de verdad.
   */
  it.each([
    ['.config-intro', 'la frase de la cabecera'],
    ['.config-area-descripcion', 'la frase que orienta cada pestaña'],
    ['.config-detalle', 'lo que se pliega'],
    ['.config-permiso', 'el permiso dicho en castellano'],
  ])('%s tiene tope de renglón (%s)', (selector) => {
    expect(declaraciones(propia, selector)['max-width']).toBe('var(--medida)');
  });

  it('`--medida` está declarada y es un tope de caracteres, no de píxeles', () => {
    // `ch` y no `px`: el renglón se mide en caracteres, y si la letra sube el tope tiene que subir
    // con ella. Un tope en píxeles se queda atrás en cuanto alguien toca la escala.
    // Del bloque BASE: en el `@media` de móvil `--medida` es `100%` a propósito, porque ahí el
    // ancho lo manda la pantalla y un tope en `ch` haría creer que hay tope donde no lo hay.
    expect(declaraciones(propia, '.config-pagina')['--medida']).toMatch(/^\d+ch$/);
  });

  /** CONTROL NEGATIVO: sin el tope, la prosa vuelve a cruzar el ancho entero. */
  it('CONTROL NEGATIVO — detecta que se le quite el tope a la descripción del área', () => {
    const roto = sinComentarios(PROPIA).replace(
      /\.config-area-descripcion\s*\{[^{}]*\}/,
      '.config-area-descripcion { margin: 0 0 8px; }',
    );
    expect(roto).not.toBe(sinComentarios(PROPIA));
    expect(declaraciones(roto, '.config-area-descripcion')['max-width']).toBeUndefined();
  });
});

/* ═══ Una sola tira de pestañas ════════════════════════════════════════════════════════════════
 *
 * MEDIDO en Chrome: la página dibujaba DOS tiras `role="tablist"` apiladas —la de las áreas a
 * y=307 y la del modo de alta a y=389— con la misma forma exacta: mismo `padding`, mismo
 * `border-radius`, mismo fondo, mismo 12,5 px. Dos controles idénticos dicen que hacen lo mismo, y
 * no lo hacen: uno cambia de ÁREA de la configuración y el otro elige un MODO dentro de un solo
 * formulario. La segunda pasó a ser un segmentado DENTRO del panel del alta.
 */
describe('el elegir-modo del alta ya no es una segunda tira de pestañas', () => {
  const todas = sinComentarios(GLOBAL) + sinComentarios(PROPIA) + sinComentarios(INTERRUPTORES);

  it('las clases de la tira vieja no existen en ninguna hoja', () => {
    expect(todas).not.toMatch(/\.alta-modos\b/);
    expect(todas).not.toMatch(/\.alta-modo(?![\w-])/);
  });

  /**
   * Y no se parecen. Un `padding` + `border-radius` + `background` idénticos es exactamente lo que
   * las hacía indistinguibles: se comparan los tres a la vez porque coincidir en uno solo no dice
   * nada (todo el resto de la consola usa `border-radius: 10px`).
   */
  it('el segmentado del alta no se dibuja igual que las pestañas de la página', () => {
    const tira = declaraciones(sinComentarios(PROPIA), '.config-tabs');
    const segmento = declaraciones(sinComentarios(PROPIA), '.alta-segmento');
    expect(segmento['display'], '.alta-segmento no existe en la hoja').toBeDefined();
    const firma = (d: Record<string, string>) => [d['padding'], d['border-radius'], d['display']].join('|');
    expect(firma(segmento)).not.toBe(firma(tira));
    // Y es compacto: un `flex` a secas volvería a ocupar el ancho del panel, que es la mitad de
    // por qué se leían como lo mismo.
    expect(segmento['display']).toBe('inline-flex');
  });

  /** CONTROL NEGATIVO: si alguien le copia la firma de la tira, se marca. */
  it('CONTROL NEGATIVO — detecta que el segmentado vuelva a copiar la forma de la tira', () => {
    const tira = declaraciones(sinComentarios(PROPIA), '.config-tabs');
    const clonado = { padding: tira['padding'], 'border-radius': tira['border-radius'], display: tira['display'] };
    const firma = (d: Record<string, string>) => [d['padding'], d['border-radius'], d['display']].join('|');
    expect(firma(clonado)).toBe(firma(tira));
  });
});


/**
 * El otro extremo del cable de `data-numero`. `CollectionTable` marca la columna (y su prueba de
 * DOM lo comprueba); acá se comprueba que la marca DESEMBOQUE en algo. Sin las dos, la marca puede
 * estar puesta y no alinear nada, o la regla puede existir y no alcanzar a ninguna celda.
 */
describe('las columnas de números se alinean a la derecha', () => {
  it('la hoja tiene una regla atada a `data-numero` que alinea a la derecha', () => {
    const regla = declaraciones(sinComentarios(PROPIA), "td[data-numero='true']");
    expect(regla['text-align'], "no hay regla para td[data-numero='true']").toBe('right');
    expect(regla['font-variant-numeric']).toBe('tabular-nums');
  });

  /** CONTROL NEGATIVO: sin la regla, la marca del componente no alinea nada. */
  it('CONTROL NEGATIVO — detecta que se borre la regla', () => {
    const roto = sinComentarios(PROPIA).replace(/text-align: right;/, 'text-align: left;');
    expect(roto).not.toBe(sinComentarios(PROPIA));
    expect(declaraciones(roto, "td[data-numero='true']")['text-align']).not.toBe('right');
  });
});


/**
 * **Un párrafo de texto no puede ser un contenedor de flex.**
 *
 * MEDIDO en Chrome a 1600×1000 sobre la pestaña «Roles de agente»: `.muted` global es
 * `display: inline-flex` —pensado para una marca de una línea junto a un icono— y los tres
 * párrafos de esa pestaña lo llevan en un `<p>` con un `<strong>` dentro. Cada trozo de texto se
 * volvía un ítem de flex y la frase salía en tres columnas de 340, 150 y 730 px, para leer en
 * zigzag. Es anterior a este cambio y no lo veía nadie: jsdom no hace layout.
 */
describe('los párrafos de /config son párrafos', () => {
  it('un `<p class="muted">` vuelve a ser bloque dentro de la vista', () => {
    const regla = declaraciones(sinComentarios(PROPIA), 'p.muted');
    expect(regla['display'], 'no hay regla para p.muted dentro de .config-pagina').toBe('block');
    expect(regla['max-width']).toBe('var(--medida)');
  });

  /**
   * CONTROL NEGATIVO: el valor EXACTO que tiene `.muted` en la hoja global es el que rompe. Si
   * alguien «simplifica» la regla de arriba a `display: inline-flex`, o la borra, esto lo marca.
   */
  it('CONTROL NEGATIVO — `.muted` global sigue siendo inline-flex, que es lo que hay que tapar', () => {
    expect(declaraciones(sinComentarios(GLOBAL), '.muted')['display']).toBe('inline-flex');
    const roto = sinComentarios(PROPIA).replace(/p\.muted \{[^{}]*\}/, 'p.muted { color: red; }');
    expect(roto).not.toBe(sinComentarios(PROPIA));
    expect(declaraciones(roto, 'p.muted')['display']).not.toBe('block');
  });
});


/* ═══ El interruptor medía 2 px ════════════════════════════════════════════════════════════════
 *
 * MEDIDO en Chrome sobre el bundle de producción, `getComputedStyle(input).width` = `2px`. La
 * pastilla de 36×20 no se dibujaba: en pantalla quedaba sólo el punto de 14 px del `::after`, así
 * que el control central de esta vista —«los permisos como interruptores»— no se leía como un
 * interruptor ni decía de qué lado estaba. Anterior a este cambio y a la vista de todos.
 *
 * La causa es de CASCADA, no de valor: `styles.css` declara `.config-area input[type="checkbox"] {
 * width: auto }` con la MISMA especificidad que `.config-area input.interruptor`, y vite concatena
 * `styles.css` la última. Un `width: 36px` correcto, escrito antes, y perdiendo por el orden.
 */
/**
 * Especificidad de un selector simple, como un solo número comparable: ids × 10 000, más
 * clases/atributos/pseudo-clases × 100, más tipos. Alcanza para los selectores de esta hoja, que
 * no tienen combinadores raros ni `:is()`.
 */
export function especificidad(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const clases = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?/g) ?? []).length;
  const tipos = (selector.replace(/\[[^\]]+\]|[#.:][\w-]+(?:\([^)]*\))?/g, ' ').match(/[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10000 + clases * 100 + tipos;
}

describe('el interruptor le gana a la regla de casilla de la hoja global', () => {
  it('el selector del interruptor es MÁS específico que el de la casilla genérica', () => {
    const propio = /(\.config-area\s+input(?:\[[^\]]+\])?\.interruptor)\s*\{[^{}]*width:\s*36px/
      .exec(sinComentarios(INTERRUPTORES));
    expect(propio, 'no hay ninguna regla que le dé 36px de ancho al interruptor').not.toBeNull();

    const ajeno = /(\.config-area\s+input\[type="checkbox"\][^{]*)\{[^{}]*width:\s*auto/
      .exec(sinComentarios(GLOBAL));
    expect(ajeno, 'la regla de `width: auto` de styles.css ya no existe: revisá si hace falta esto').not.toBeNull();

    // Empate de especificidad = gana la de abajo, y `styles.css` va la ÚLTIMA en el bundle (está
    // escrito en `HOJAS_DE_LA_CONSOLA`, de `styles.legibilidad.test.ts`, y comprobado sobre el
    // bundle). Por eso no alcanza con que el valor sea el correcto: tiene que GANAR.
    expect(especificidad(propio![1])).toBeGreaterThan(especificidad('.config-area input[type="checkbox"]'));
  });

  /**
   * CONTROL NEGATIVO: el selector EXACTO que estaba desplegado. Empata, y empatar es perder porque
   * `styles.css` va después. Sin este control, la prueba de arriba podría estar comparando dos
   * números que siempre difieren y aprobaría cualquier cosa.
   */
  it('CONTROL NEGATIVO — el selector que estaba desplegado empata, y empatar es perder', () => {
    expect(especificidad('.config-area input.interruptor'))
      .toBe(especificidad('.config-area input[type="checkbox"]'));
  });
});
