import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { renderWithApi } from './test/render';
import { leerCss } from './test/leer-css';
import { sinComentarios } from './test/css-parser';
import './styles.css';

/**
 * Mounted-views typographic floor check: validates the effective font-size computation
 * by resolving the winning declarations of the cascade.
 */

const SUELO = 12.5;

const TOKENS: Map<string, string> = (() => {
  const css = sinComentarios(leerCss('styles.css'));
  const abre = css.indexOf('{', css.search(/(^|})\s*:root\s*\{/));
  const salida = new Map<string, string>();
  for (const d of css.slice(abre + 1, css.indexOf('}', abre)).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
    salida.set(d[1], d[2].trim());
  }
  return salida;
})();

/**
 * CSS size keywords. An element coming out with one of these means NO sheet of ours gave it a
 * size — the user agent decides — which is exactly the defect of `.subline`, so it is treated as
 * a failure, not as "unknown".
 */
const PALABRAS_UA = /^(smaller|larger|xx-small|x-small|small|medium|large|x-large|xx-large)$/;

function textoPropio(el: Element): string {
  let t = '';
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) t += n.nodeValue ?? '';
  return t.trim();
}

/**
 * An element's size in pixels, resolving the string jsdom returns.
 *
 * Returns `{ px }` or `{ problema }`. `problema` is not "could not": it is a named failure,
 * because a size we cannot resolve is a size nobody controls.
 */
function tamanoEnPx(el: Element, profundidad = 0): { px?: number; problema?: string; bruto?: string } {
  if (profundidad > 30) return { problema: 'herencia demasiado profunda' };
  const bruto = (getComputedStyle(el).fontSize || '').trim();

  // Without its own declaration: inherits. The `html` without any declaration is the browser's 16px.
  if (bruto === '' || bruto === 'inherit') {
    const padre = el.parentElement;
    if (!padre) return { px: 16 };
    return tamanoEnPx(padre, profundidad + 1);
  }
  if (PALABRAS_UA.test(bruto)) {
    return { problema: `lo decide el navegador (\`${bruto}\`): ninguna hoja le pone tamaño`, bruto };
  }
  const variable = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(bruto);
  if (variable) {
    const rawVal = TOKENS.get(variable[1]) ?? variable[2];
    if (typeof rawVal !== 'string') return { problema: `${variable[1]} no está declarada en :root`, bruto };
    return { px: resolverLongitud(rawVal.trim(), el, profundidad), bruto };
  }
  const px = resolverLongitud(bruto, el, profundidad);
  return px === undefined ? { problema: `no se sabe resolver \`${bruto}\``, bruto } : { px, bruto };
}

function resolverLongitud(valor: string, el: Element, profundidad: number): number | undefined {
  const limpio = valor.replace(/\s*!important\s*$/, '');
  /*
   * `clamp(min, preferred, max)` is judged by its MINIMUM, the worst case for legibility: if the
   * minimum reaches the floor, no window width makes that text drop below it.
   */
  const clamp = /^clamp\(\s*([^,]+),/.exec(limpio);
  if (clamp) return resolverLongitud(clamp[1].trim(), el, profundidad);
  let m = /^(\d*\.?\d+)px$/.exec(limpio);
  if (m) return Number(m[1]);
  m = /^(\d*\.?\d+)rem$/.exec(limpio);
  if (m) return Number(m[1]) * 16;
  m = /^(\d*\.?\d+)em$/.exec(limpio);
  if (m) {
    const padre = el.parentElement;
    const base = padre ? tamanoEnPx(padre, profundidad + 1).px : 16;
    return base === undefined ? undefined : Number(m[1]) * base;
  }
  m = /^(\d*\.?\d+)%$/.exec(limpio);
  if (m) {
    const padre = el.parentElement;
    const base = padre ? tamanoEnPx(padre, profundidad + 1).px : 16;
    return base === undefined ? undefined : (Number(m[1]) / 100) * base;
  }
  return undefined;
}

const nombre = (el: Element) =>
  el.tagName.toLowerCase()
  + (typeof el.className === 'string' && el.className.trim()
    ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
    : '');

export function textoPorDebajoDelSuelo(raiz: Element, suelo = SUELO): string[] {
  const fallos: string[] = [];
  for (const el of Array.from(raiz.querySelectorAll('*'))) {
    if (el.classList.contains('sr-only')) continue;
    const texto = textoPropio(el);
    if (!texto) continue;
    const { px, problema, bruto } = tamanoEnPx(el);
    if (problema) {
      fallos.push(`${nombre(el)} «${texto.slice(0, 30)}» → ${problema}`);
      continue;
    }
    if (px !== undefined && px + 0.001 < suelo) {
      fallos.push(`${nombre(el)} «${texto.slice(0, 30)}» → ${String(px)}px (${bruto ?? ''}), el suelo es ${String(suelo)}px`);
    }
  }
  return fallos;
}

const VISTAS: readonly { ruta: string; titulo: RegExp; minimo: number }[] = [
  { ruta: '/', titulo: /Cauce en una pantalla/i, minimo: 200 },
  { ruta: '/live', titulo: /La flota ahora/i, minimo: 1200 },
  { ruta: '/accounts', titulo: /Cuentas y cuotas/i, minimo: 700 },
  { ruta: '/messages', titulo: /Mensajes/i, minimo: 200 },
  { ruta: '/queues', titulo: /Colas y DLQ operativo/i, minimo: 120 },
  { ruta: '/observability', titulo: /Señales y auditoría/i, minimo: 100 },
  { ruta: '/config', titulo: /Ajustes y altas/i, minimo: 500 },
];

describe('ningún texto de las páginas montadas baja del suelo tipográfico', () => {
  for (const { ruta, titulo, minimo } of VISTAS) {
    it(`${ruta} — todo el texto llega a ${String(SUELO)}px`, async () => {
      window.history.pushState({}, '', ruta);
      renderWithApi(<App />);

      // Wait for the navigation and the main content to have mounted after the session.
      await screen.findByRole('navigation', { name: /principal/i });
      const main = screen.getByRole('main');
      await waitFor(() => {
        const h1 = screen.queryByRole('heading', { level: 1 });
        expect(h1?.textContent).toMatch(titulo);
      }, { timeout: 10_000 });
      await waitFor(() => { expect(main.querySelectorAll('*').length).toBeGreaterThanOrEqual(minimo); }, { timeout: 10_000 });

      const fallos = textoPorDebajoDelSuelo(main);
      expect(fallos, `${String(fallos.length)} textos por debajo de ${String(SUELO)}px en ${ruta}:\n  ${fallos.slice(0, 25).join('\n  ')}`)
        .toEqual([]);
    }, 30_000);
  }

  /**
   * NEGATIVE CONTROL of the meter, on a hand-crafted DOM carrying the EXACT defects that were
   * deployed. Without it, `textoPorDebajoDelSuelo()` could return `[]` simply because it cannot
   * read anything, and would approve any page.
   *
   * The four cases are the four ways a text ends up small; each must fail for its own reason:
   *   1. a `px` below the floor, written by hand;
   *   2. a `rem` below the floor (those were the 177 declarations of this change);
   *   3. the INHERITED size from a small parent, which the element does not declare;
   *   4. the size the BROWSER sets because nobody declared it — the `.subline` case.
   */
  it('CONTROL NEGATIVO — el medidor marca los cuatro caminos por los que un texto se queda chico', () => {
    const caja = document.createElement('div');
    caja.innerHTML = `
      <p id="a" style="font-size: 11px">once píxeles</p>
      <p id="b" style="font-size: .58rem">nueve coma veintiocho</p>
      <div style="font-size: 10px"><span id="c">heredado del padre chico</span></div>
      <p id="d">tamaño del navegador</p>`;
    document.body.appendChild(caja);
    /*
     * The fourth case is declared EXPLICITLY (`font-size: smaller`) rather than fabricated with a
     * raw `<small>`, and the reason matters: since `styles.css` put a floor on `small`, a
     * classless `<small>` no longer falls back to the UA — i.e. the original defect can no longer
     * be reproduced that way. A negative control that depends on the sheet still being broken
     * turns itself off the day it is fixed, and from then on the guard approves without anyone
     * noticing. This one tests the METER: that it can denounce a browser-decided size, no matter
     * where it comes from.
     */
    const ua = caja.querySelector('#d');
    expect(ua).not.toBeNull();
    ua?.setAttribute('style', 'font-size: smaller');

    const fallos = textoPorDebajoDelSuelo(caja);
    expect(fallos).toHaveLength(4);
    expect(fallos.join('\n')).toMatch(/11px/);
    expect(fallos.join('\n')).toMatch(/9\.28px/);
    expect(fallos.join('\n')).toMatch(/10px/);
    expect(fallos.join('\n')).toMatch(/lo decide el navegador/);

    caja.remove();
  });

  /** NEGATIVE CONTROL — and the floor is the one we said: 12px is NOT enough, 12.5 is. */
  it('CONTROL NEGATIVO — 12px no alcanza y 12,5px sí', () => {
    const caja = document.createElement('div');
    caja.innerHTML = '<p style="font-size: 12px">justo por debajo</p><p style="font-size: 12.5px">justo</p>';
    document.body.appendChild(caja);
    expect(textoPorDebajoDelSuelo(caja)).toHaveLength(1);
    caja.remove();
  });

  /**
   * NEGATIVE CONTROL of token resolution: if `var(--tipo-apunte)` stopped resolving, the meter
   * must DENOUNCE it, not swallow it. A variable that does not exist makes the browser drop the
   * entire declaration and fall through to the next cascade — which is exactly what was happening
   * to `toggles.css` outside /config.
   */
  it('CONTROL NEGATIVO — un `var()` que no existe se denuncia, no se aprueba', () => {
    const caja = document.createElement('div');
    caja.innerHTML = '<p style="font-size: var(--tipo-inventado)">sin token</p>';
    document.body.appendChild(caja);
    expect(textoPorDebajoDelSuelo(caja).join('')).toMatch(/no está declarada en :root/);
    caja.remove();
  });
});
