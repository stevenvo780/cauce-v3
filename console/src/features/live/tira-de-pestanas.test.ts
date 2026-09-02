import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';
import { cuerposDeSelector as cuerpos, sinComentarios } from '../../test/css-parser';

/**
 * The drawer's tab strip is the shared `<ViewTabs variant="panel">`, so the two things that keep it
 * inside a 420px drawer are now checked on `styles.css` and not on a skin of its own.
 */
const GLOBAL = sinComentarios(leerCss('styles.css'));
/** Without comments: otherwise a `flex-wrap: wrap` quoted in prose would count as a declaration. */
const CAJON = sinComentarios(leerCss('features/live/live.css'));

const TIRA = ".view-tabs[data-variant='panel']";
const PESTANA = `${TIRA} .view-tab`;

/** Effective value of a property: the one of the LAST rule declaring it. */
function valor(css: string, selector: string, propiedad: string): string | undefined {
  const encontrados = cuerpos(css, selector)
    .map((cuerpo) => new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`).exec(cuerpo)?.[1].trim())
    .filter((v): v is string => Boolean(v));
  return encontrados[0];
}

describe('la tira de pestañas del cajón cabe en el cajón', () => {
  it('hay una regla para la variante de panel donde mirar', () => {
    expect(cuerpos(GLOBAL, TIRA)).not.toHaveLength(0);
    expect(cuerpos(GLOBAL, PESTANA)).not.toHaveLength(0);
  });

  it('declara un mecanismo para caber: envuelve o desplaza, pero no se desborda', () => {
    const envuelve = valor(GLOBAL, TIRA, 'flex-wrap');
    const desplaza = valor(GLOBAL, TIRA, 'overflow-x') ?? valor(GLOBAL, TIRA, 'overflow');
    const contiene = envuelve === 'wrap'
      || envuelve === 'wrap-reverse'
      || /\b(auto|scroll)\b/.test(desplaza ?? '');
    expect(contiene, 'la tira no declara ni `flex-wrap: wrap` ni `overflow-x: auto|scroll`: '
      + 'con `nowrap` y `overflow-x: visible` se dibuja fuera del cajón').toBe(true);
  });

  it('la pestaña no se encoge ni parte el rótulo a mitad de palabra', () => {
    expect(valor(GLOBAL, PESTANA, 'flex')).toBe('none');
    expect(valor(GLOBAL, '.view-tab', 'white-space')).toBe('nowrap');
  });

  it('el cajón sigue midiendo 420 px, que es lo que hace falta contener', () => {
    expect(valor(CAJON, '.live-page.has-drawer', 'grid-template-columns'))
      .toContain('420px');
  });
});
