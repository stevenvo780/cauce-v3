import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VAR_ALTO_COMPOSITOR } from './ConversationPane';

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
