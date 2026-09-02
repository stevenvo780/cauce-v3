import { describe, expect, it } from 'vitest';
import { leerCss } from '../test/leer-css';
import { cuerposDeSelector, valor } from '../test/css-parser';
import { contraste, resolver, temas, type Tema } from '../styles.legibilidad-themes.test';

/**
 * Inactive tabs were invisible in the light theme, on /accounts and /observability: the strip
 * declared a fixed night blue and had no light override, so `--muted` text landed on a slate grey
 * at a measured **1.13:1**. That is not low contrast, it is not being there — and it hid two
 * thirds of /accounts and the whole audit tab of /observability.
 *
 * The strip no longer carries a colour of its own: `components.css` paints it with tokens and
 * `base.css` gives those tokens their value on each of the three theme paths. So the check moved
 * with them — it resolves the strip's own declarations against every path's palette and measures.
 * Browser reading after the original fix: inactive 5.13:1, active 16.35:1.
 */
const COMPONENTES = leerCss('styles/components.css');
const HOJA = leerCss('styles.css');

const TIRA = '.view-tabs';
const INACTIVA = '.view-tab';
const ACTIVA = ".view-tab[aria-selected='true']";
const AA = 4.5;

function unica(css: string, selector: string, propiedad: string): string {
  const cuerpos = cuerposDeSelector(css, selector);
  expect(cuerpos, `${selector} ya no existe en components.css`).not.toHaveLength(0);
  const encontrado = valor(cuerpos.join(';'), propiedad);
  expect(encontrado, `${selector} ya no declara ${propiedad}`).toBeDefined();
  return encontrado ?? '';
}

function color(expresion: string, tema: Tema): { r: number; g: number; b: number; a: number } {
  const resuelto = resolver(expresion, tema.tokens);
  expect(resuelto, `[${tema.nombre}] ${expresion} no resuelve a un color`).toBeDefined();
  return resuelto ?? { r: 0, g: 0, b: 0, a: 1 };
}

/** Every (text, background) pair the strip actually paints, on the three theme paths. */
export function tirasBajoAA(css: string, componentes: string): string[] {
  const fallos: string[] = [];
  const tira = unica(componentes, TIRA, 'background');
  const textoInactivo = unica(componentes, INACTIVA, 'color');
  const fondoActiva = unica(componentes, ACTIVA, 'background');
  const textoActivo = unica(componentes, ACTIVA, 'color');
  // A variant that erases its fill leaves its tabs on whatever is underneath: a panel or the page.
  const desnudas = variantesSinFondo(componentes);
  for (const tema of temas(css)) {
    const medir = (texto: string, fondo: string, que: string) => {
      const ratio = contraste(color(texto, tema), color(fondo, tema));
      if (ratio + 0.005 < AA) {
        fallos.push(`[${tema.nombre}] ${que} = ${ratio.toFixed(2)}:1, hace falta ${String(AA)}`);
      }
      return ratio;
    };
    medir(textoInactivo, tira, 'pestaña INACTIVA sobre la tira');
    medir(textoActivo, fondoActiva, 'pestaña ACTIVA sobre su fondo');
    if (contraste(color(fondoActiva, tema), color(tira, tema)) < 1.02) {
      fallos.push(`[${tema.nombre}] la pestaña ACTIVA es del mismo color que la tira`);
    }
    for (const variante of desnudas) {
      for (const debajo of ['var(--surface)', 'var(--bg)']) {
        medir(textoInactivo, debajo, `pestaña INACTIVA de la variante ${variante} sobre ${debajo}`);
      }
      medir(textoActivo, fondoActiva, `pestaña ACTIVA de la variante ${variante}`);
    }
  }
  return fallos;
}

const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|color-mix)\(|\b(?:white|black|silver|gray|grey|red|blue|green|yellow|navy|teal|maroon|olive|purple|lime|aqua)\b/i;

export function coloresLiterales(css: string): { selector: string; color: string }[] {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const salida: { selector: string; color: string }[] = [];
  for (const regla of limpio.matchAll(/([^{}]*\.view-tabs\[data-variant[^{}]*)\{([^}]*)\}/g)) {
    const encontrado = LITERAL.exec(regla[2].replace(/var\([^)]*\)/g, ' '));
    if (encontrado) salida.push({ selector: regla[1].trim(), color: encontrado[0] });
  }
  return salida;
}

export function variantesSinFondo(css: string): string[] {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const nombres: string[] = [];
  for (const regla of limpio.matchAll(/\.view-tabs\[data-variant='([\w-]+)'\]\s*\{([^}]*)\}/g)) {
    if (/background\s*:\s*(?:none|transparent)\b/.test(regla[2])) nombres.push(regla[1]);
  }
  return nombres;
}

describe('la barra de pestañas se ve en los tres caminos del tema', () => {
  it('ninguna pestaña baja de 4,5:1 sobre lo que de verdad tiene detrás', () => {
    expect(tirasBajoAA(HOJA, COMPONENTES)).toEqual([]);
  });

  it('hay variantes desnudas que vigilar, y ninguna se pinta un color a mano', () => {
    expect(variantesSinFondo(COMPONENTES).length, 'no hay ninguna variante que vigilar').toBeGreaterThan(0);
    expect(coloresLiterales(HOJA).map((v) => `${v.selector} → ${v.color}`)).toEqual([]);
    expect(coloresLiterales(".view-tabs[data-variant='panel'] { background: #0d1624; }")).toHaveLength(1);
    expect(coloresLiterales(".view-tabs[data-variant='chip'] { background: white; }")).toHaveLength(1);
    expect(coloresLiterales(".paleta[data-variant='x'] { background: #0d1624; }")).toHaveLength(0);
    expect(variantesSinFondo(".view-tabs[data-variant='panel'] { background: none; }")).toEqual(['panel']);
  });

  it('la tira y la pestaña activa toman su fondo de un token, no de un color escrito a mano', () => {
    expect(unica(COMPONENTES, TIRA, 'background')).toMatch(/^var\(--/);
    expect(unica(COMPONENTES, ACTIVA, 'background')).toMatch(/^var\(--/);
    expect(unica(COMPONENTES, '.view-tab-badge', 'background')).toMatch(/^var\(--/);
  });

  /**
   * NEGATIVE CONTROL: the strip exactly as it was when the 1.13:1 was measured — its own night
   * blue, no override — measured against today's light palette. A guard that approves that is
   * worse than none.
   */
  it('CONTROL NEGATIVO — con la tira anterior de azul de noche marca la pestaña invisible', () => {
    const anterior = COMPONENTES.replace(
      /(\.view-tabs \{[\s\S]*?)background: var\(--surface-2\);/,
      '$1background: rgb(13 20 34 / 60%);',
    );
    expect(anterior).not.toBe(COMPONENTES);
    const fallos = tirasBajoAA(HOJA, anterior);
    expect(fallos).toContainEqual(expect.stringContaining('[claro] pestaña INACTIVA sobre la tira'));
  });

  it('CONTROL NEGATIVO — marca que la pestaña activa deje de distinguirse de la tira', () => {
    const plano = COMPONENTES.replace(
      /(\.view-tab\[aria-selected='true'\] \{ )background: var\(--surface-3\);/,
      '$1background: var(--surface-2);',
    );
    expect(plano).not.toBe(COMPONENTES);
    expect(tirasBajoAA(HOJA, plano)).toContainEqual(expect.stringContaining('del mismo color que la tira'));
  });
});
