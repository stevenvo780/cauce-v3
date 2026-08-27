import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * LA ESCALA TIPOGRÁFICA DE TODA LA CONSOLA, COMPROBADA SOBRE LAS HOJAS.
 *
 * El arreglo de legibilidad de 2026-08-24 se aplicó a UNA vista de ocho. MEDIDO por mí en Chrome de
 * verdad (`/usr/bin/google-chrome` por CDP, vite en modo mock, 1920×1080, tema claro), contando los
 * elementos de texto HOJA dentro de `main` con `getComputedStyle().fontSize` por debajo de 12,5 px:
 *
 *     /config          0      ← la única arreglada
 *     live           299      (mínimo 9,28 px)
 *     accounts       186      (mínimo 9,92 px)
 *     terminal       177      (mínimo 8,00 px)   ← NO es de este cambio, ver PENDIENTES
 *     portada         75      (mínimo 9,92 px)
 *     messages        72      (mínimo 9,60 px)
 *     queues          43      (mínimo 9,60 px)
 *     observability   37      (mínimo 10,88 px)
 *     ───────────────────
 *     total          889
 *
 * La escala ya existía y estaba razonada, pero encerrada en `.config-pagina`. Este fichero guarda
 * que siga declarada en `:root` —o sea, disponible en las ocho vistas— y que ninguna hoja del
 * reparto vuelva a escribir un `font-size` por debajo del suelo.
 *
 * LO QUE ESTE FICHERO NO PUEDE AFIRMAR: que no haya desbordes.** jsdom no calcula layout, y no
 * es una creencia heredada: está MEDIDO abajo, en «la premisa», con una caja de 100 px que contiene
 * un hijo de 5000 px. jsdom devuelve `scrollWidth: 0` y `clientWidth: 0`, o sea `0 > 0` = falso
 * SIEMPRE. Una prueba de desborde escrita acá no podría dar rojo ni con la hoja rota a propósito, y
 * una prueba que no puede fallar es un verde falso. El desborde se mide en Chrome, con
 * `ops/console-legibilidad/medir-tipografia.mjs`, y el resultado va en el informe del cambio.
 *
 * Cada aserto lleva su CONTROL NEGATIVO POR MUTACIÓN: se le da de comer la hoja rota —con los
 * valores EXACTOS que estaban desplegados— y se exige que la marque. Un guardia que aprueba
 * cualquier cosa es peor que no tenerlo.
 */

const RAIZ = resolve(process.cwd(), 'src');
const leer = (ruta: string) => readFileSync(resolve(RAIZ, ruta), 'utf8');

/**
 * Las hojas bajo guardia. Es el REPARTO de este cambio, no la lista completa de la consola.
 *
 * PENDIENTES, y hay que decirlo en vez de esconderlo: `features/terminal/terminal-panel.css` y
 * `features/terminal/xterm-csp.css` NO están acá. Tienen 177 elementos por debajo del suelo medidos
 * en Chrome, con el mínimo de toda la consola (8,00 px en 4 elementos), y son el peor caso que
 * queda. Quedan fuera porque otro agente estaba escribiendo en ese directorio al mismo tiempo y dos
 * agentes en el mismo fichero se pisan. Cuando ese trabajo cierre, se añaden a esta lista y el
 * guardia empieza a cubrirlas: no hace falta tocar nada más que esta constante.
 */
const HOJAS = [
  'styles.css',
  'features/live/live.css',
  'features/live/live-hypergraph.css',
  'features/messages/messages.css',
  'features/queues/queues.css',
  'features/accounts/licenses.css',
  'features/topology/hypergraph.css',
  'features/auth/auth.css',
  'features/config/config.css',
  'features/config/toggles.css',
] as const;

/* ------------------------------------------------------------------ lectura de la hoja ------ */

/** Fuera los comentarios, pero conservando los saltos de línea (para poder citar la línea). */
function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

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

/** Las variables declaradas en el PRIMER bloque `:root` de una hoja: el bloque base. */
function tokensDeRoot(css: string): Map<string, string> {
  const limpio = sinComentarios(css);
  const inicio = limpio.search(/(^|})\s*:root\s*\{/);
  if (inicio < 0) return new Map();
  const abre = limpio.indexOf('{', inicio);
  const cierra = limpio.indexOf('}', abre);
  const salida = new Map<string, string>();
  for (const d of limpio.slice(abre + 1, cierra).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
    salida.set(d[1], d[2].trim());
  }
  return salida;
}

/** `14px`, `.74rem`, `var(--tipo-cuerpo)` → píxeles. `undefined` si no se sabe resolver. */
function enPixeles(valor: string, escala: Map<string, string>, saltos = 0): number | undefined {
  if (saltos > 8) return undefined;
  const bruto = valor.trim().replace(/\s*!important\s*$/, '');
  const referencia = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(bruto);
  if (referencia) {
    const destino = escala.get(referencia[1]);
    return destino === undefined ? undefined : enPixeles(destino, escala, saltos + 1);
  }
  const px = /^(\d*\.?\d+)px$/.exec(bruto);
  if (px) return Number(px[1]);
  const rem = /^(\d*\.?\d+)rem$/.exec(bruto);
  if (rem) return Number(rem[1]) * 16;
  /*
   * `clamp(min, preferido, max)` se juzga por su MÍNIMO, que es el peor caso para la legibilidad:
   * si el mínimo llega al suelo, no hay ancho de ventana en el que ese texto baje de ahí. Juzgarlo
   * por el valor preferido sería medir contra un ancho que nadie garantiza.
   */
  const clamp = /^clamp\(\s*([^,]+),/.exec(bruto);
  if (clamp) return enPixeles(clamp[1], escala, saltos + 1);
  return undefined;
}

/** El suelo. Es el valor configurado y la que ya rige en `/config`. */
const SUELO = 12.5;

/**
 * LA EXCEPCIÓN ESCRITA A MANO, y la única.
 *
 * `.sidebar nav a` a `.6875rem` (11 px) dentro de `@media (max-width: 760px)` es la barra de
 * navegación de móvil. NO sale de la escala y no se toca: está medida contra el ancho real de las
 * ocho entradas a 360 px —cuatro columnas de reja, dos renglones por rótulo— y subirla vuelve a
 * pisar los rótulos entre sí, que es el defecto que ese bloque existe para haber arreglado.
 *
 * Se anota como par (selector, valor) EXACTO y no como «perdonale todo a `.sidebar nav a`»: el
 * mismo selector tiene otra declaración en el bloque base (`.9rem`), y un perdón por selector la
 * dejaría entrar por la ventana.
 */
const EXCEPCIONES: ReadonlyArray<{ selector: string; valor: string }> = [
  { selector: '.sidebar nav a', valor: '.6875rem' },
];

const esExcepcion = (selector: string, valor: string) =>
  EXCEPCIONES.some((e) => e.selector === selector && e.valor === valor);

/**
 * Toda la letra por debajo del suelo de un juego de hojas.
 *
 * Se le pasan las hojas como TEXTO —no las lee de disco— justamente para poder darle de comer una
 * hoja mutada y exigir que la repruebe. Un guardia que sólo sabe mirar el fichero de verdad no se
 * puede probar a sí mismo.
 */
function letraPorDebajoDelSuelo(hojas: string[], suelo = SUELO): string[] {
  const escala = tokensDeRoot(hojas.join('\n'));
  const fallos: string[] = [];
  for (const hoja of hojas) {
    for (const { selector, valor } of tamanosDeLetra(hoja)) {
      // `inherit`/`0` no declaran un tamaño propio: no hay nada que juzgar.
      if (/^(inherit|initial|unset|revert)$/.test(valor)) continue;
      if (esExcepcion(selector, valor)) continue;
      const px = enPixeles(valor, escala);
      if (px === undefined) {
        fallos.push(`${selector} { font-size: ${valor} } no se sabe resolver a píxeles`);
        continue;
      }
      if (px + 0.001 < suelo) {
        fallos.push(`${selector} { font-size: ${valor} } = ${px}px, el suelo es ${suelo}px`);
      }
    }
  }
  return fallos;
}

/* ═══ La premisa: ¿jsdom calcula layout? ═══════════════════════════════════════════════════════
 *
 * Esto NO es decoración. Es la razón por la que en este fichero no hay ninguna prueba de desborde,
 * y va escrito como aserto ejecutable para que sea un HECHO COMPROBADO en cada corrida y no una
 * creencia heredada de un comentario. Si algún día jsdom (o el entorno de vitest) empieza a hacer
 * layout, esta prueba se pone roja y nos dice que ya se puede escribir la prueba de desborde acá.
 */
describe('la premisa: por qué la prueba de desborde NO vive en jsdom', () => {
  it('jsdom NO calcula layout: una caja forzada a desbordar 50 veces informa 0 y 0', () => {
    const caja = document.createElement('div');
    caja.style.width = '100px';
    caja.style.overflow = 'auto';
    const hijo = document.createElement('div');
    hijo.style.width = '5000px';
    hijo.textContent = 'x'.repeat(5000);
    caja.appendChild(hijo);
    document.body.appendChild(caja);

    // `scrollWidth > clientWidth` es la comprobación de desborde de manual. Acá es `0 > 0`.
    expect(caja.scrollWidth, 'jsdom empezó a calcular scrollWidth').toBe(0);
    expect(caja.clientWidth, 'jsdom empezó a calcular clientWidth').toBe(0);
    expect(caja.scrollWidth > caja.clientWidth, 'el desborde MÁS grosero posible da falso').toBe(false);
    // Y sin layout tampoco hay tamaño calculado que medir: `getComputedStyle` devuelve vacío.
    expect(getComputedStyle(hijo).fontSize, 'jsdom empezó a resolver font-size').toBe('');

    caja.remove();
  });
});

/* ═══ La escala vive en `:root` ════════════════════════════════════════════════════════════════
 *
 * Estaba declarada en `.config-pagina`, o sea que sólo existía dentro de /config. Eso no es un
 * detalle de estilo: `features/config/toggles.css` YA citaba `var(--tipo-rotulo)` y
 * `var(--tipo-apunte)` en cinco reglas, y esas reglas se aplican también a componentes que se usan
 * fuera de /config, donde la variable no existía y el `font-size` entero se descartaba sin un solo
 * aviso. Una variable no declarada no hereda: la declaración se cae y manda la cascada de al lado.
 */
const ESCALA = ['--tipo-titulo', '--tipo-panel', '--tipo-cuerpo', '--tipo-rotulo', '--tipo-apunte'];

describe('la escala tipográfica es GLOBAL', () => {
  const global = leer('styles.css');
  const tokens = tokensDeRoot(global);

  it('los seis escalones están declarados en el `:root` de la hoja global', () => {
    for (const nombre of [...ESCALA, '--tipo-mono']) {
      expect(tokens.get(nombre), `${nombre} no está en el :root de styles.css`).toBeDefined();
      expect(enPixeles(tokens.get(nombre)!, tokens), `${nombre} no resuelve a píxeles`).toBeDefined();
    }
  });

  it('van de mayor a menor, sin dos escalones iguales', () => {
    const px = ESCALA.map((n) => enPixeles(tokens.get(n)!, tokens)!);
    for (let i = 1; i < px.length; i += 1) {
      expect(px[i], `${ESCALA[i]} (${px[i]}px) no baja de ${ESCALA[i - 1]} (${px[i - 1]}px)`)
        .toBeLessThan(px[i - 1]);
    }
  });

  it('el suelo de la escala es 12,5px y el monoespaciado no se sale', () => {
    expect(enPixeles(tokens.get('--tipo-apunte')!, tokens)).toBeGreaterThanOrEqual(SUELO);
    expect(enPixeles(tokens.get('--tipo-cuerpo')!, tokens)).toBeGreaterThanOrEqual(13);
    expect(enPixeles(tokens.get('--tipo-rotulo')!, tokens)).toBeGreaterThanOrEqual(13);
    const mono = enPixeles(tokens.get('--tipo-mono')!, tokens)!;
    expect(mono).toBeGreaterThanOrEqual(SUELO);
    expect(mono).toBeLessThanOrEqual(enPixeles(tokens.get('--tipo-cuerpo')!, tokens)!);
  });

  /**
   * CONTROL NEGATIVO. La regresión más probable no es borrar los tokens: es volver a encerrarlos en
   * un selector de página «porque ahí estaban». Se muta `:root` a `.config-pagina` y se exige que el
   * lector deje de encontrarlos — que es exactamente lo que le pasaba al navegador en las otras
   * siete vistas.
   */
  it('CONTROL NEGATIVO — encerrar la escala en `.config-pagina` la vuelve invisible para el resto', () => {
    const roto = global.replace(/(^|\n):root \{/, '$1.config-pagina {');
    expect(roto, 'la mutación no cambió nada: el aserto no probaría nada').not.toBe(global);
    expect(tokensDeRoot(roto).get('--tipo-cuerpo')).toBeUndefined();
  });

  /** CONTROL NEGATIVO — una escala aplanada (cuerpo y rótulo iguales) no es una escala. */
  it('CONTROL NEGATIVO — marca una escala aplanada', () => {
    const plana = tokensDeRoot(global.replace('--tipo-rotulo: 13px', '--tipo-rotulo: 14px'));
    expect(plana.get('--tipo-rotulo')).toBe('14px');
    expect(enPixeles(plana.get('--tipo-rotulo')!, plana))
      .not.toBeLessThan(enPixeles(plana.get('--tipo-cuerpo')!, plana)!);
  });
});

/* ═══ Ninguna hoja baja del suelo ══════════════════════════════════════════════════════════════ */

describe('ninguna hoja de la consola declara letra por debajo del suelo', () => {
  const hojas = HOJAS.map(leer);

  it(`las ${HOJAS.length} hojas del reparto están por encima de ${SUELO}px`, () => {
    expect(letraPorDebajoDelSuelo(hojas)).toEqual([]);
  });

  /**
   * CONTROL NEGATIVO POR MUTACIÓN, con los valores EXACTOS que estaban desplegados y medidos:
   * `.53rem` = 8,48 px en las insignias del adaptador, `.58rem` = 9,28 px en la barra de conexión,
   * `.68rem` = 10,88 px en las cabeceras de tabla. Sin esto, `letraPorDebajoDelSuelo()` podría estar
   * devolviendo `[]` porque no encuentra NINGUNA regla, y aprobaría cualquier hoja.
   */
  it('CONTROL NEGATIVO — marca los tamaños que estaban desplegados', () => {
    expect(letraPorDebajoDelSuelo(['.x { font-size: .53rem; }'])).toHaveLength(1);
    expect(letraPorDebajoDelSuelo(['.x { font-size: .58rem; }'])).toHaveLength(1);
    expect(letraPorDebajoDelSuelo(['.x { font-size: .68rem; }'])).toHaveLength(1);
    // Y que el suelo sea el que se dijo: 12px NO alcanza, 12,5 sí.
    expect(letraPorDebajoDelSuelo(['.x { font-size: 12px; }'])).toHaveLength(1);
    expect(letraPorDebajoDelSuelo(['.x { font-size: 12.5px; }'])).toEqual([]);
  });

  /**
   * CONTROL NEGATIVO del lector, no de la hoja: si `tamanosDeLetra()` dejara de ver las reglas de
   * dentro de un `@media`, el guardia daría verde sobre una hoja rota. Ahí vive justamente la
   * excepción de móvil, así que es el sitio donde más caro sale no mirar.
   */
  it('CONTROL NEGATIVO — el lector SÍ entra en los bloques `@media`', () => {
    expect(letraPorDebajoDelSuelo(['@media (max-width: 760px) { .x { font-size: .58rem; } }']))
      .toHaveLength(1);
  });

  /**
   * CONTROL NEGATIVO de la resolución de tokens: si `var(--tipo-apunte)` dejara de resolverse, el
   * guardia lo reportaría como «no se sabe resolver» en vez de tragárselo en silencio. Un valor que
   * no se entiende NO puede contar como aprobado.
   */
  it('CONTROL NEGATIVO — un `var()` que no existe se denuncia, no se aprueba', () => {
    expect(letraPorDebajoDelSuelo(['.x { font-size: var(--tipo-inventado); }']))
      .toContainEqual(expect.stringContaining('no se sabe resolver'));
    const conRoot = ':root { --tipo-apunte: 12.5px; }\n.x { font-size: var(--tipo-apunte); }';
    expect(letraPorDebajoDelSuelo([conRoot])).toEqual([]);
  });
});

/* ═══ La trampa que ninguna lista de valores puede ver ═════════════════════════════════════════
 *
 * MEDIDO en Chrome: 76 elementos `<small class="subline">` a **10,67 px**, repartidos por /queues,
 * /observability, /accounts y /live. Ninguna hoja declara ese tamaño en ninguna parte: `.subline`
 * pone `display`, `margin` y `color` y NO pone `font-size`, así que manda la hoja de estilo del
 * NAVEGADOR, que a `<small>` le da `smaller`. Un censo de los `font-size` escritos en el CSS —que
 * es lo que hacen los asertos de arriba— no puede encontrar esto ni en principio: el defecto está
 * en lo que NO está escrito.
 *
 * Por eso la hoja global tiene que poner un suelo explícito a los elementos que el navegador
 * encoge por su cuenta. Se guarda acá para que nadie lo quite «porque no hacía nada».
 */
describe('los elementos que el NAVEGADOR encoge por su cuenta tienen suelo propio', () => {
  const global = sinComentarios(leer('styles.css'));

  it('`small` tiene un `font-size` explícito en la hoja global', () => {
    const regla = /(^|[},])\s*small\s*\{([^{}]*)\}/.exec(global);
    expect(regla, 'no hay una regla `small { … }` en styles.css: vuelve a mandar el UA').not.toBeNull();
    const valor = /(?:^|;)\s*font-size\s*:\s*([^;]+)/.exec(regla![2])?.[1]?.trim();
    expect(valor, '`small` no declara font-size: el navegador le pone `smaller`').toBeDefined();
    expect(enPixeles(valor!, tokensDeRoot(leer('styles.css')))).toBeGreaterThanOrEqual(SUELO);
  });

  it('`.subline` declara su propio tamaño y no lo hereda del UA', () => {
    const regla = /(^|[},])\s*\.subline\s*\{([^{}]*)\}/.exec(global);
    expect(regla, 'no hay regla `.subline`').not.toBeNull();
    expect(/(?:^|;)\s*font-size\s*:/.test(regla![2]), '`.subline` sin font-size = 10,67px del UA')
      .toBe(true);
  });
});

/* ═══ La excepción de móvil sigue en pie ═══════════════════════════════════════════════════════ */

describe('la barra de navegación de móvil conserva su excepción medida', () => {
  const global = leer('styles.css');

  it('`.sidebar nav a` sigue a `.6875rem` dentro del corte de móvil', () => {
    const limpio = sinComentarios(global);
    const inicio = limpio.indexOf('@media (max-width: 760px)');
    expect(inicio, 'desapareció el corte de móvil').toBeGreaterThan(-1);
    const bloque = limpio.slice(inicio, limpio.indexOf('\n}', inicio));
    expect(bloque).toContain('font-size: .6875rem');
  });

  /**
   * El comentario NO es adorno: es el único sitio donde consta por qué ese número no sube con el
   * resto. Sin él, el próximo barrido de tipografía lo «arregla» y vuelven a pisarse los ocho
   * rótulos a 360 px. Se guarda el texto medido, no la palabra suelta.
   */
  it('el comentario que explica por qué NO se toca sigue en la hoja', () => {
    expect(global).toContain('360');
    expect(global).toMatch(/no se toca|NO sale de la escala|no sube con el resto/i);
  });
});
