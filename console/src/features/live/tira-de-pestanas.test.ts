import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';
import { cuerposDeSelector as cuerpos, sinComentarios } from '../../test/css-parser';

/**
 * Verification of flex wrapping for the agent drawer tab strip:
 * ensures `.agent-drawer-tabs` declares `flex-wrap: wrap` to prevent horizontal overflow.
 */
const HOJA = leerCss('features/live/live.css');
/** Without comments: otherwise a `flex-wrap: wrap` quoted in prose would count as a declaration. */
const SIN_COMENTARIOS = sinComentarios(HOJA);

/** Effective value of a property: the one of the LAST rule declaring it. */
function valor(css: string, selector: string, propiedad: string): string | undefined {
  const encontrados = cuerpos(css, selector)
    .map((cuerpo) => new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`).exec(cuerpo)?.[1].trim())
    .filter((v): v is string => Boolean(v));
  return encontrados[0];
}

describe('la tira de pestañas del cajón cabe en el cajón', () => {
  it('hay una regla para .agent-drawer-tabs donde mirar', () => {
    expect(cuerpos(SIN_COMENTARIOS, '.agent-drawer-tabs')).not.toHaveLength(0);
  });

  it('declara un mecanismo para caber: envuelve o desplaza, pero no se desborda', () => {
    const envuelve = valor(SIN_COMENTARIOS, '.agent-drawer-tabs', 'flex-wrap');
    const desplaza = valor(SIN_COMENTARIOS, '.agent-drawer-tabs', 'overflow-x')
      ?? valor(SIN_COMENTARIOS, '.agent-drawer-tabs', 'overflow');
    const contiene = envuelve === 'wrap'
      || envuelve === 'wrap-reverse'
      || /\b(auto|scroll)\b/.test(desplaza ?? '');
    expect(contiene, 'la tira no declara ni `flex-wrap: wrap` ni `overflow-x: auto|scroll`: '
      + 'con `nowrap` y `overflow-x: visible` se dibuja fuera del cajón').toBe(true);
  });

  it('la pestaña no se encoge ni parte el rótulo a mitad de palabra', () => {
    expect(valor(SIN_COMENTARIOS, '.agent-drawer-tab', 'flex')).toBe('none');
    expect(valor(SIN_COMENTARIOS, '.agent-drawer-tab', 'white-space')).toBe('nowrap');
  });

  it('el cajón sigue midiendo 420 px, que es lo que hace falta contener', () => {
    expect(valor(SIN_COMENTARIOS, '.live-page.has-drawer', 'grid-template-columns'))
      .toContain('420px');
  });
});
