import { describe, expect, it } from 'vitest';
import { leerCss } from '../test/leer-css';

/**
 * Inactive tabs were invisible in the light theme. 1280x900, on /accounts and /observability.**
 *
 * `.view-tabs` declares its background with a fixed night blue (`rgb(13 20 34 / 60%)`) and had no
 * override for `prefers-color-scheme: light`. On the light page it leaves a slate gray (105,110,120);
 * an inactive tab's text is `--muted` (87,103,124). Measured contrast: **1.13:1**. This is not "low
 * contrast", it is that they are not visible.
 *
 * What it cost: on /accounts it hides "Inventario" and "Asignaciones" —two thirds of the view, and
 * the half that keeps working when the quota collector is down— and on /observability it hides
 * "Auditoría". An operator who cannot see the tab does not know the view has more.
 *
 * It is checked on the stylesheet because there is no X server here: jsdom does not resolve
 * `@media` nor compute contrast. After the fix, measured in the browser: inactive **5.13:1**, active
 * 16.35:1.
 */
const HOJA = leerCss('styles.css');

/** Bodies of every `@media (prefers-color-scheme: light)`, counting braces. */
function bloquesClaros(css: string): string[] {
  const salida: string[] = [];
  const patron = /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)\s*\{/g;
  for (let coincidencia = patron.exec(css); coincidencia; coincidencia = patron.exec(css)) {
    let profundidad = 1;
    let i = coincidencia.index + coincidencia[0].length;
    const desde = i;
    while (i < css.length && profundidad > 0) {
      if (css[i] === '{') profundidad += 1;
      if (css[i] === '}') profundidad -= 1;
      i += 1;
    }
    salida.push(css.slice(desde, i - 1));
  }
  return salida;
}

function declaracion(css: string, selector: string, propiedad: string): string | undefined {
  const patron = new RegExp(`(^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const bloque = patron.exec(css.replace(/\/\*[\s\S]*?\*\//g, ' '));
  if (!bloque) return undefined;
  return new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`).exec(bloque[2])?.[1].trim();
}

describe('la barra de pestañas se ve en tema claro', () => {
  const claros = bloquesClaros(HOJA);

  it('hay al menos un bloque de tema claro donde mirar', () => {
    expect(claros.length).toBeGreaterThan(0);
  });

  it('.view-tabs repinta su fondo en claro en vez de dejar el azul de noche', () => {
    const fondos = claros.map((bloque) => declaracion(bloque, '.view-tabs', 'background')).filter(Boolean);
    expect(fondos).not.toHaveLength(0);
    // And what it sets is a theme token, not another dark color written by hand.
    expect(fondos[0]).toMatch(/var\(--surface/);
  });

  it('la pestaña ACTIVA sigue distinguiéndose de la barra en claro', () => {
    const activa = claros
      .map((bloque) => declaracion(bloque, ".view-tab[aria-selected='true']", 'background'))
      .filter(Boolean);
    expect(activa).not.toHaveLength(0);
    expect(activa[0]).not.toBe(declaracion(claros.join('\n'), '.view-tabs', 'background'));
  });

  it('el contador de la pestaña deja de ser blanco sobre blanco', () => {
    const badge = claros.map((bloque) => declaracion(bloque, '.view-tab-badge', 'background')).filter(Boolean);
    expect(badge).not.toHaveLength(0);
    expect(badge[0]).not.toMatch(/255\s+255\s+255/);
  });

  /**
   * NEGATIVE CONTROL of the guard: it is fed the stylesheet exactly as it was when the 1.13:1
   * was measured, and required to find nothing. A checker that approves anything is worse than
   * not having one.
   */
  it('con la hoja anterior —sin override claro— no encontraría ningún fondo', () => {
    const anterior = `
      .view-tabs { background: rgb(13 20 34 / 60%); }
      @media (prefers-color-scheme: light) {
        :root { --surface: #ffffff; }
        .badge-offline { border-color: #ccd4de; }
      }
    `;
    const bloques = bloquesClaros(anterior);
    expect(bloques).toHaveLength(1);
    expect(declaracion(bloques[0], '.view-tabs', 'background')).toBeUndefined();
    // And the night blue was still the only declaration of the bar.
    expect(declaracion(anterior, '.view-tabs', 'background')).toBe('rgb(13 20 34 / 60%)');
  });
});
