import { describe, expect, it } from 'vitest';
import { VAR_ALTO_COMPOSITOR } from './ConversationPane';
import { VAR_TOPE_MENSAJERIA } from './MessagesPage';
import { leerCss } from '../../test/leer-css';
import {
  bloqueMedia,
  declaraciones,
  valor,
} from '../../test/css-parser';

/**
 * Structural CSS tests to ensure the composer stays anchored on mobile screens.
 */

const MENSAJES_CSS = leerCss('features/messages/messages.css');
const GLOBAL_CSS = leerCss('styles.css');

/** The breakpoint at which the console switches to a fixed bottom navigation bar. */
const CORTE_ESTRECHO = 760;

function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Full diagnosis of the sheet for the narrow breakpoint. Returns the LIST OF DEFECTS, not a
 * boolean: that way the negative control can require the concrete defect and not "something
 * failed".
 */
export function defectosDelCompositorAnclado(mensajes: string, global: string): string[] {
  const defectos: string[] = [];
  const estrecho = bloqueMedia(mensajes, `@media (max-width: ${String(CORTE_ESTRECHO)}px)`);
  if (!estrecho) return [`no hay bloque @media (max-width: ${String(CORTE_ESTRECHO)}px) en messages.css`];

  const compositor = declaraciones(estrecho, '.messenger-composer');
  /*
   * `fixed`, not `sticky`. Measured in Chrome at 360x740: with `sticky` the composer stayed at
   * top 778 — outside the viewport — because a sticky box cannot leave its containing block,
   * and the thread starts 778 px from the edge. `sticky` here is back to being the bug.
   */
  if (valor(compositor, 'position') !== 'fixed') {
    defectos.push(
      `.messenger-composer no queda fijo abajo: position es ${valor(compositor, 'position') ?? 'la de por defecto'} `
      + 'y con `sticky` el compositor no llega a la ventana porque su bloque contenedor empieza fuera de ella',
    );
  }

  /*
   * A fixed element leaves the flow: if the thread does not reserve its height, the end of the
   * conversation lives UNDER the composer and no scroll pulls it out. The gap must read the
   * SAME variable the component writes (see the cross-check below).
   */
  const hiloEstrecho = declaraciones(estrecho, '.messenger-thread');
  if (!/padding-bottom\s*:[^;]*var\(\s*--messenger-composer-alto/.test(hiloEstrecho)) {
    defectos.push('.messenger-thread no reserva el hueco del compositor fijo: el final del hilo queda tapado');
  }

  /*
   * The number is not copied from memory: it is READ from the navigation bar that at this same
   * breakpoint becomes fixed at the bottom. Anchoring to 0 — or to a 66 that one day stops being
   * 66 — puts the Send button under the menu, which is worse than the bug being fixed.
   */
  const navegacion = declaraciones(bloqueMedia(global, `@media (max-width: ${String(CORTE_ESTRECHO)}px)`), '.sidebar');
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
     * Saying the same thing is not enough if what they say does not exist: two `var(--made-up)`
     * are identical and both resolve to nothing, i.e. `bottom: auto` and the composer back to the
     * bottom of the thread. If the anchor is a token, it must be declared — with a length — in
     * the global `:root`.
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
   * CROSS-CHECK. The sheet reads `var(--messenger-composer-alto)` and `ConversationPane` writes
   * it with `style.setProperty`. They are two strings in two different files and nothing binds
   * them: changing one and not the other does not break the typecheck, the lint, or a single
   * DOM test, and the symptom — the end of the thread below the composer, only on the phone —
   * is seen by nobody.
   */
  it('la variable que el componente escribe es la MISMA que la hoja lee', () => {
    expect(VAR_ALTO_COMPOSITOR).toBe('--messenger-composer-alto');
    expect(sinComentarios(MENSAJES_CSS)).toContain(`var(${VAR_ALTO_COMPOSITOR}`);
  });

  it('CONTROL NEGATIVO — marca el anclaje a 0, que mete el botón Enviar debajo del menú', () => {
    // The mutation does NOT cite the value: the anchor went from a hand-copied `66px` to
    // `var(--nav-inferior-alto)` (the bottom bar is now two rows). A negative control that only
    // mutates yesterday's number mutates nothing and approves anything.
    const roto = MENSAJES_CSS.replace(/(\.messenger-composer \{[^}]*?)bottom: [^;]+;/, '$1bottom: 0;');
    expect(roto).not.toBe(MENSAJES_CSS);
    expect(defectosDelCompositorAnclado(roto, GLOBAL_CSS)).toContainEqual(
      expect.stringContaining('tapado por el menú'),
    );
  });

  it('el roster se encoge a conmutador cuando hay conversación abierta, y sólo entonces', () => {
    const estrecho = bloqueMedia(MENSAJES_CSS, `@media (max-width: ${String(CORTE_ESTRECHO)}px)`);
    // Without an open conversation the roster IS the content and keeps its 300 px.
    expect(valor(declaraciones(estrecho, '.messenger-agent-list'), 'max-height')).toBe('300px');
    expect(estrecho).toContain('.messenger-shell[data-conversacion="abierta"] .messenger-agent-list');
  });
});

/**
 * ------------------------------------------------------------------ THE SAME BUG, ON DESKTOP
 *
 * The fix above lives inside the 760 px breakpoint, so on desktop the composer stayed exactly
 * as before. Measured in the production console at 1280x900, with the operator session and
 * without touching anything: the `textarea` at y=1546 and the Send button at y=1633, with the
 * 900 viewport — 646 px below the fold. `getComputedStyle` of the composer: `position: static`.
 *
 * `.messenger-composer { margin-top: auto }` was already there and did nothing: it pushes to the
 * bottom of the container, and the container had no height. The fix is to give the block a
 * height, subtracting from the viewport the MEASURED top (`--messenger-tope`, written by
 * `MessagesPage`).
 */
export function defectosDelCompositorEnEscritorio(mensajes: string): string[] {
  const defectos: string[] = [];
  const ancho = bloqueMedia(mensajes, '@media (min-width: 761px)');
  if (!ancho) return ['no hay bloque @media (min-width: 761px) en messages.css: el escritorio sigue sin acotar'];

  /*
   * ALL `height` declarations, not the first. The sheet writes two — one with `vh` as fallback
   * for a browser without `dvh` and another with `dvh` — and the one that WINS is the last the
   * browser understands. A checker that looked only at the first would approve a sheet where
   * someone fixed the one on top and left the one below broken, which is exactly the one Chrome
   * applies.
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

  // A bounded panel without `overflow: hidden` overflows at the bottom and its footer goes with it.
  if (valor(declaraciones(ancho, '.messenger-thread'), 'overflow') !== 'hidden') {
    defectos.push('.messenger-thread no recorta: el contenido desborda el panel acotado y el compositor se va con él');
  }

  // And the composer must not shrink or grow: it is the last thing that has to stay whole.
  if (!/flex\s*:\s*none/.test(declaraciones(sinComentarios(mensajes), '.messenger-composer'))) {
    defectos.push('.messenger-composer no es `flex: none`: en un panel acotado se encoge y el botón Enviar se corta');
  }

  /*
   * The scroll box is what absorbs the leftover height. Without `min-height: 0` a flex child
   * does NOT shrink below its content — manual rule — and the bounded panel overflows the same
   * way: the `height` above would end up as decoration.
   */
  const caja = declaraciones(sinComentarios(mensajes), '.messenger-thread-scroll');
  if (valor(caja, 'overflow-y') !== 'auto' || valor(caja, 'min-height') !== '0') {
    defectos.push('.messenger-thread-scroll no es la caja con scroll (`overflow-y: auto` + `min-height: 0`): el hilo empuja al compositor fuera del panel');
  }
  return defectos;
}

/**
 * THE THREAD HEADER ON THE PHONE, which used to be painted vertically.
 *
 * Measured at 360x800: `.messenger-thread-identity` with `scrollWidth 136` and `clientWidth 46`,
 * the alias coming out as "z e u s" and the status as "S T E V E N . E P O C H 8 ...", about 570 px
 * tall. It is not slowness: it is the three-column flex row competing with
 * `.messenger-thread-actions`, which is `flex: none`, plus the `overflow-wrap: anywhere` that
 * `styles.css` puts on every h2/p.
 */
export function defectosDeLaCabeceraEstrecha(mensajes: string): string[] {
  const defectos: string[] = [];
  const estrecho = bloqueMedia(mensajes, `@media (max-width: ${String(CORTE_ESTRECHO)}px)`);
  if (!estrecho) return [`no hay bloque @media (max-width: ${String(CORTE_ESTRECHO)}px) en messages.css`];

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
      'height: max(430px, calc(100dvh - var(--messenger-tope, 330px) - 34px));',
      'height: max(430px, calc(100dvh - 330px));',
    );
    expect(roto).not.toBe(MENSAJES_CSS);
    expect(defectosDelCompositorEnEscritorio(roto)).toContainEqual(expect.stringContaining('número fijo'));
  });

  /**
   * NEGATIVE CONTROL OF THE CHECKER ITSELF. The sheet declares `height` twice and the one
   * applied in Chrome is the SECOND: if the checker looked only at the first, this mutation —
   * fixed above, broken below — would pass green and the console would return to the bug
   * without anyone noticing.
   */
  it('CONTROL NEGATIVO — marca la hoja arreglada arriba y rota abajo, que es la que manda', () => {
    const roto = MENSAJES_CSS.replace(
      'height: max(430px, calc(100dvh - var(--messenger-tope, 330px) - 34px));',
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
