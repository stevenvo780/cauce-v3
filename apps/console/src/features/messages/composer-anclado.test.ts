import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VAR_ALTO_COMPOSITOR } from './ConversationPane';
import { VAR_TOPE_MENSAJERIA } from './MessagesPage';

/**
 * EL COMPOSITOR ANCLADO EN PANTALLA ESTRECHA, COMPROBADO SOBRE LA HOJA.
 *
 * Steven, textual: «es horrible… toca scrollear un montón para ver dónde está el envío de
 * mensaje». El arreglo vive entero en `messages.css` y no lo puede comprobar jsdom: vitest corre
 * sin layout, así que ninguna de las 620 pruebas de esta consola mira una sola regla y un
 * `position` que no ancla a nada pasaría verde por unanimidad.
 *
 * Este fichero comprueba la hoja como texto —lo barato que sí atrapa el fallo— y cada afirmación
 * lleva su CONTROL NEGATIVO POR MUTACIÓN: se le da de comer la hoja rota a propósito y se exige
 * que el comprobador la marque. Un guardia que aprueba cualquier cosa es peor que no tenerlo.
 *
 * Lo que NO prueba, y hay que decirlo: que en un navegador real el compositor quede efectivamente
 * a la vista. Eso se mide con un navegador a 360 px, no acá.
 */

const RAIZ = resolve(process.cwd(), 'src');
const MENSAJES_CSS = readFileSync(resolve(RAIZ, 'features/messages/messages.css'), 'utf8');
const GLOBAL_CSS = readFileSync(resolve(RAIZ, 'styles.css'), 'utf8');

/** El corte en el que la consola pasa a barra de navegación inferior fija. */
const CORTE_ESTRECHO = 760;

function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * El cuerpo de un `@media` concreto. Se cuentan llaves porque dentro hay reglas anidadas y un
 * `indexOf('}')` cortaría en la primera regla, dejando fuera justo lo que se quiere comprobar.
 */
function bloqueMedia(css: string, consulta: string): string {
  const limpio = sinComentarios(css);
  const inicio = limpio.indexOf(consulta);
  if (inicio < 0) return '';
  let profundidad = 0;
  let cursor = limpio.indexOf('{', inicio);
  if (cursor < 0) return '';
  const desde = cursor + 1;
  for (; cursor < limpio.length; cursor += 1) {
    if (limpio[cursor] === '{') profundidad += 1;
    else if (limpio[cursor] === '}') {
      profundidad -= 1;
      if (profundidad === 0) return limpio.slice(desde, cursor);
    }
  }
  return '';
}

/** Las declaraciones de un selector dentro de un bloque ya acotado. */
function declaraciones(bloque: string, selector: string): string {
  const escapado = selector.replace(/[.[\]()="^$*+?|\\/{}]/g, (caracter) => `\\${caracter}`);
  const patron = new RegExp(`(^|[},])\\s*${escapado}\\s*\\{([^{}]*)\\}`);
  return patron.exec(bloque)?.[2] ?? '';
}

function valor(declaracion: string, propiedad: string): string | undefined {
  const patron = new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`);
  const encontrado = patron.exec(declaracion)?.[1];
  return encontrado?.trim();
}

/**
 * El diagnóstico completo de la hoja para el corte estrecho. Devuelve la LISTA DE DEFECTOS, no un
 * booleano: así el control negativo puede exigir el defecto concreto y no «algo falló».
 */
export function defectosDelCompositorAnclado(mensajes: string, global: string): string[] {
  const defectos: string[] = [];
  const estrecho = bloqueMedia(mensajes, `@media (max-width: ${CORTE_ESTRECHO}px)`);
  if (!estrecho) return [`no hay bloque @media (max-width: ${CORTE_ESTRECHO}px) en messages.css`];

  const compositor = declaraciones(estrecho, '.messenger-composer');
  /*
   * `fixed`, no `sticky`. Medido en Chrome a 360x740: con `sticky` el compositor quedaba en
   * top 778 —fuera de la ventana— porque una caja pegajosa no puede salir de su bloque
   * contenedor, y el hilo empieza a 778 px del borde. `sticky` acá vuelve a ser el defecto.
   */
  if (valor(compositor, 'position') !== 'fixed') {
    defectos.push(
      `.messenger-composer no queda fijo abajo: position es ${valor(compositor, 'position') ?? 'la de por defecto'} `
      + 'y con `sticky` el compositor no llega a la ventana porque su bloque contenedor empieza fuera de ella',
    );
  }

  /*
   * Un elemento fijo sale del flujo: si el hilo no reserva su alto, el final de la conversación
   * vive DEBAJO del compositor y no hay scroll que lo saque. El hueco tiene que leer la MISMA
   * variable que el componente escribe (ver la comprobación cruzada de más abajo).
   */
  const hiloEstrecho = declaraciones(estrecho, '.messenger-thread');
  if (!/padding-bottom\s*:[^;]*var\(\s*--messenger-composer-alto/.test(hiloEstrecho)) {
    defectos.push('.messenger-thread no reserva el hueco del compositor fijo: el final del hilo queda tapado');
  }

  /*
   * El número no se copia de memoria: se LEE de la barra de navegación que en este mismo corte se
   * vuelve fija abajo. Anclar a 0 —o a un 66 que un día deje de ser 66— mete el botón «Enviar»
   * debajo del menú, que es peor que el defecto que se venía a arreglar.
   */
  const navegacion = declaraciones(bloqueMedia(global, `@media (max-width: ${CORTE_ESTRECHO}px)`), '.sidebar');
  const alturaNav = valor(navegacion, 'height');
  const posicionNav = valor(navegacion, 'position');
  if (posicionNav !== 'fixed' || !alturaNav) {
    defectos.push('no se pudo leer la barra de navegación inferior de styles.css: el anclaje quedaría a ciegas');
  } else if (valor(compositor, 'bottom') !== alturaNav) {
    defectos.push(
      `.messenger-composer se ancla a ${valor(compositor, 'bottom') ?? 'nada'} y la barra de navegación `
      + `fija mide ${alturaNav}: el botón Enviar queda tapado por el menú`,
    );
  } else {
    /*
     * Decir lo mismo no basta si lo que dicen no existe: dos `var(--inventada)` son idénticas y
     * las dos resuelven a nada, o sea `bottom: auto` y el compositor de vuelta al fondo del hilo.
     * Si el ancla es un token, tiene que estar declarado —con una longitud— en el `:root` global.
     */
    const token = /^var\(\s*(--[\w-]+)/.exec(alturaNav)?.[1];
    if (token) {
      const raiz = declaraciones(sinComentarios(global), ':root');
      const declarado = valor(raiz, token);
      if (!declarado || !/^-?[\d.]+(px|rem|em|vh)$/.test(declarado)) {
        defectos.push(
          `la barra y el compositor se anclan a ${token}, pero ese token no está declarado como `
          + `longitud en el :root de styles.css (vale ${declarado ?? 'nada'}): los dos resolverían a auto`,
        );
      }
    }
  }

  return defectos;
}

describe('el compositor de /messages en pantalla estrecha', () => {
  it('queda FIJO abajo, por encima de la barra de navegación, y el hilo le reserva el hueco', () => {
    expect(defectosDelCompositorAnclado(MENSAJES_CSS, GLOBAL_CSS)).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca la vuelta a `sticky`, que es el intento que YA se midió y no sirve', () => {
    const roto = MENSAJES_CSS.replace(/(\.messenger-composer \{[^}]*?)position: fixed;/, '$1position: sticky;');
    expect(roto).not.toBe(MENSAJES_CSS);
    expect(defectosDelCompositorAnclado(roto, GLOBAL_CSS)).toContainEqual(
      expect.stringContaining('no queda fijo abajo'),
    );
  });

  it('CONTROL NEGATIVO — marca el hilo sin colchón: el compositor fijo taparía el final de la conversación', () => {
    const roto = MENSAJES_CSS.replace(
      /\.messenger-thread \{ padding-bottom:[^}]*\}/,
      '.messenger-thread { padding-bottom: 0; }',
    );
    expect(roto).not.toBe(MENSAJES_CSS);
    expect(defectosDelCompositorAnclado(roto, GLOBAL_CSS)).toContainEqual(
      expect.stringContaining('no reserva el hueco'),
    );
  });

  /**
   * COMPROBACIÓN CRUZADA. La hoja lee `var(--messenger-composer-alto)` y `ConversationPane` lo
   * escribe con `style.setProperty`. Son dos cadenas en dos ficheros distintos y nada las ata:
   * cambiar una y no la otra no rompe el typecheck, ni el lint, ni una sola prueba de DOM, y el
   * síntoma —el final del hilo debajo del compositor, sólo en el teléfono— no lo ve nadie.
   */
  it('la variable que el componente escribe es la MISMA que la hoja lee', () => {
    expect(VAR_ALTO_COMPOSITOR).toBe('--messenger-composer-alto');
    expect(sinComentarios(MENSAJES_CSS)).toContain(`var(${VAR_ALTO_COMPOSITOR}`);
  });

  it('CONTROL NEGATIVO — marca el anclaje a 0, que mete el botón Enviar debajo del menú', () => {
    // La mutación NO cita el valor: el ancla dejó de ser un `66px` copiado a mano y pasó a ser
    // `var(--nav-inferior-alto)` (2026-08-23, la barra inferior es de dos filas). Un control
    // negativo que sólo sabe mutar el número de ayer deja de mutar nada y aprueba cualquier cosa.
    const roto = MENSAJES_CSS.replace(/(\.messenger-composer \{[^}]*?)bottom: [^;]+;/, '$1bottom: 0;');
    expect(roto).not.toBe(MENSAJES_CSS);
    expect(defectosDelCompositorAnclado(roto, GLOBAL_CSS)).toContainEqual(
      expect.stringContaining('tapado por el menú'),
    );
  });

  it('el roster se encoge a conmutador cuando hay conversación abierta, y sólo entonces', () => {
    const estrecho = bloqueMedia(MENSAJES_CSS, `@media (max-width: ${CORTE_ESTRECHO}px)`);
    // Sin conversación abierta el roster ES el contenido y conserva sus 300 px.
    expect(valor(declaraciones(estrecho, '.messenger-agent-list'), 'max-height')).toBe('300px');
    expect(estrecho).toContain('.messenger-shell[data-conversacion="abierta"] .messenger-agent-list');
  });
});

/**
 * ------------------------------------------------------------------ EL MISMO DEFECTO, EN ESCRITORIO
 *
 * El arreglo de arriba vive dentro del corte de 760 px, así que en escritorio el compositor seguía
 * exactamente igual que antes. Medido en la consola de producción a 1280x900, con la sesión de
 * Steven y sin tocar nada: el `textarea` en y=1546 y el botón «Enviar» en y=1633, con la ventana
 * de 900 — 646 px por debajo del pliegue. `getComputedStyle` del compositor: `position: static`.
 *
 * `.messenger-composer { margin-top: auto }` ya estaba y no servía para nada: empuja al pie del
 * contenedor, y el contenedor no tenía alto. El arreglo es darle alto al bloque, restándole al
 * viewport el tope MEDIDO (`--messenger-tope`, que escribe `MessagesPage`).
 */
export function defectosDelCompositorEnEscritorio(mensajes: string): string[] {
  const defectos: string[] = [];
  const ancho = bloqueMedia(mensajes, '@media (min-width: 761px)');
  if (!ancho) return ['no hay bloque @media (min-width: 761px) en messages.css: el escritorio sigue sin acotar'];

  /*
   * TODAS las declaraciones de `height`, no la primera. La hoja escribe dos —una con `vh` como red
   * para un navegador sin `dvh` y otra con `dvh`— y la que MANDA es la última que el navegador
   * entiende. Un comprobador que mirase sólo la primera aprobaría una hoja en la que alguien
   * arregló la de arriba y dejó rota la de abajo, que es justo la que se aplica en Chrome.
   */
  const envoltura = declaraciones(ancho, '.messenger-shell');
  const altos = [...envoltura.matchAll(/(?:^|;)\s*height\s*:\s*([^;]+)/g)].map((encontrado) => encontrado[1].trim());
  if (altos.length === 0) {
    defectos.push('.messenger-shell no tiene alto en escritorio: crece con su contenido y el pie del panel queda donde termina el contenido, o sea fuera de pantalla');
  }
  for (const alto of altos) {
    if (!alto.includes('vh')) {
      defectos.push(`.messenger-shell se acota a ${alto}, que no depende de la ventana: con una pantalla más baja el compositor vuelve a caer fuera`);
    } else if (!alto.includes(`var(${VAR_TOPE_MENSAJERIA}`)) {
      defectos.push(
        '.messenger-shell resta un número fijo en vez del tope medido: en cuanto la cabecera de la '
        + 'página crezca una línea, el compositor vuelve a quedar debajo del pliegue',
      );
    }
  }

  // Un panel acotado sin `overflow: hidden` desborda por abajo y el pie se va igual.
  if (valor(declaraciones(ancho, '.messenger-thread'), 'overflow') !== 'hidden') {
    defectos.push('.messenger-thread no recorta: el contenido desborda el panel acotado y el compositor se va con él');
  }

  // Y el compositor no puede encogerse ni crecer: es lo último que tiene que quedar entero.
  if (!/flex\s*:\s*none/.test(declaraciones(sinComentarios(mensajes), '.messenger-composer'))) {
    defectos.push('.messenger-composer no es `flex: none`: en un panel acotado se encoge y el botón Enviar se corta');
  }

  /*
   * La caja de scroll es la que absorbe el alto sobrante. Sin `min-height: 0` un hijo flex NO se
   * encoge por debajo de su contenido —regla de manual— y el panel acotado desborda igual: el
   * `height` de arriba quedaría de adorno.
   */
  const caja = declaraciones(sinComentarios(mensajes), '.messenger-thread-scroll');
  if (valor(caja, 'overflow-y') !== 'auto' || valor(caja, 'min-height') !== '0') {
    defectos.push('.messenger-thread-scroll no es la caja con scroll (`overflow-y: auto` + `min-height: 0`): el hilo empuja al compositor fuera del panel');
  }
  return defectos;
}

/**
 * LA CABECERA DEL HILO EN EL TELÉFONO, que se pintaba en vertical.
 *
 * Medido a 360x800: `.messenger-thread-identity` con `scrollWidth 136` y `clientWidth 46`, el
 * alias saliendo «z e u s» y el estado «S T E V E N . E P O C H 8 …», unos 570 px de alto. No es
 * lentitud: es la fila flex de tres columnas compitiendo con `.messenger-thread-actions`, que es
 * `flex: none`, más el `overflow-wrap: anywhere` que `styles.css` le pone a todo h2/p.
 */
export function defectosDeLaCabeceraEstrecha(mensajes: string): string[] {
  const defectos: string[] = [];
  const estrecho = bloqueMedia(mensajes, `@media (max-width: ${CORTE_ESTRECHO}px)`);
  if (!estrecho) return [`no hay bloque @media (max-width: ${CORTE_ESTRECHO}px) en messages.css`];

  if (valor(declaraciones(estrecho, '.messenger-thread-head'), 'flex-direction') !== 'column') {
    defectos.push(
      '.messenger-thread-head sigue siendo una fila en el teléfono: los botones se llevan el ancho '
      + 'y a la identidad le quedan 46 px, o sea una letra por línea',
    );
  }
  const texto = declaraciones(estrecho, '.messenger-thread-identity h2, .messenger-thread-identity .eyebrow');
  if (valor(texto, 'overflow-wrap') !== 'break-word') {
    defectos.push(
      'el texto de la identidad hereda `overflow-wrap: anywhere` de styles.css: si el hueco vuelve '
      + 'a estrecharse, vuelve a partir DENTRO de la palabra',
    );
  }
  return defectos;
}

describe('el compositor de /messages en ESCRITORIO', () => {
  it('queda al pie del panel, con el alto restado del tope medido', () => {
    expect(defectosDelCompositorEnEscritorio(MENSAJES_CSS)).toEqual([]);
  });

  it('la variable del tope que el componente escribe es la MISMA que la hoja lee', () => {
    expect(VAR_TOPE_MENSAJERIA).toBe('--messenger-tope');
    expect(sinComentarios(MENSAJES_CSS)).toContain(`var(${VAR_TOPE_MENSAJERIA}`);
  });

  it('CONTROL NEGATIVO — marca la vuelta al panel sin alto, que es el defecto medido en producción', () => {
    const roto = MENSAJES_CSS.replace(/@media \(min-width: 761px\) \{[\s\S]*?\n\}\n/, '');
    expect(roto).not.toBe(MENSAJES_CSS);
    expect(defectosDelCompositorEnEscritorio(roto)).toContainEqual(expect.stringContaining('sin acotar'));
  });

  it('CONTROL NEGATIVO — marca un alto con un número fijo en vez del tope medido', () => {
    const roto = MENSAJES_CSS.replace(
      'height: clamp(430px, calc(100dvh - var(--messenger-tope, 330px) - 34px), 980px);',
      'height: clamp(430px, calc(100dvh - 330px), 980px);',
    );
    expect(roto).not.toBe(MENSAJES_CSS);
    expect(defectosDelCompositorEnEscritorio(roto)).toContainEqual(expect.stringContaining('número fijo'));
  });

  /**
   * CONTROL NEGATIVO DEL PROPIO COMPROBADOR. La hoja declara `height` dos veces y la que se aplica
   * en Chrome es la SEGUNDA: si el comprobador mirase sólo la primera, esta mutación —arreglada
   * arriba, rota abajo— pasaría en verde y la consola volvería al defecto sin que nadie lo viera.
   */
  it('CONTROL NEGATIVO — marca la hoja arreglada arriba y rota abajo, que es la que manda', () => {
    const roto = MENSAJES_CSS.replace(
      'height: clamp(430px, calc(100dvh - var(--messenger-tope, 330px) - 34px), 980px);',
      'height: 620px;',
    );
    expect(roto).not.toBe(MENSAJES_CSS);
    expect(defectosDelCompositorEnEscritorio(roto)).toContainEqual(expect.stringContaining('no depende de la ventana'));
  });

  it('CONTROL NEGATIVO — marca la caja de scroll sin `min-height: 0`, que deja el `height` de adorno', () => {
    const roto = MENSAJES_CSS.replace(
      '.messenger-thread-scroll { display: flex; min-height: 0;',
      '.messenger-thread-scroll { display: flex;',
    );
    expect(roto).not.toBe(MENSAJES_CSS);
    expect(defectosDelCompositorEnEscritorio(roto)).toContainEqual(expect.stringContaining('no es la caja con scroll'));
  });
});

describe('la cabecera del hilo en el teléfono', () => {
  it('se apila en vez de escribir el alias en vertical', () => {
    expect(defectosDeLaCabeceraEstrecha(MENSAJES_CSS)).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca la vuelta a la fila de tres columnas', () => {
    const roto = MENSAJES_CSS.replace(
      '.messenger-thread-head { align-items: stretch; flex-direction: column; gap: 10px; }',
      '.messenger-thread-head { gap: 10px; }',
    );
    expect(roto).not.toBe(MENSAJES_CSS);
    expect(defectosDeLaCabeceraEstrecha(roto)).toContainEqual(expect.stringContaining('sigue siendo una fila'));
  });

  it('CONTROL NEGATIVO — marca el texto sin `break-word`, que vuelve a partir dentro de la palabra', () => {
    const roto = MENSAJES_CSS.replace(
      '.messenger-thread-identity h2, .messenger-thread-identity .eyebrow { overflow-wrap: break-word; }',
      '',
    );
    expect(roto).not.toBe(MENSAJES_CSS);
    expect(defectosDeLaCabeceraEstrecha(roto)).toContainEqual(expect.stringContaining('DENTRO de la palabra'));
  });
});
