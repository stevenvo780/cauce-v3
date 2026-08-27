import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';
import { declaracionesDeClase as declaraciones, sinComentarios } from '../../test/css-parser';

const GLOBAL = leerCss('styles.css');
const PROPIA = leerCss(join('features', 'config', 'config.css'));
const INTERRUPTORES = leerCss(join('features', 'config', 'toggles.css'));

function enPixeles(valor: string, escala: Map<string, string>): number | undefined {
  const referencia = /^var\(\s*(--[\w-]+)\s*\)$/.exec(valor.trim());
  if (referencia) {
    const destino = escala.get(referencia[1]);
    return destino === undefined ? undefined : enPixeles(destino, escala);
  }
  const px = /^(\d*\.?\d+)px$/.exec(valor.trim());
  if (px) return Number(px[1]);
  const rem = /^(\d*\.?\d+)rem$/.exec(valor.trim());
  if (rem) return Number(rem[1]) * 16;
  const clamp = /^clamp\(\s*([^,]+),/.exec(valor.trim());
  if (clamp) return enPixeles(clamp[1], escala);
  return undefined;
}

export function especificidad(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const clases = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?/g) ?? []).length;
  const tipos = (selector.replace(/\[[^\]]+\]|[#.:][\w-]+(?:\([^)]*\))?/g, ' ').match(/[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10000 + clases * 100 + tipos;
}

describe('el tope de medida de /config', () => {
  const propia = sinComentarios(PROPIA);

  it('la página tiene un tope de ancho de entre 1000 y 1250 px', () => {
    const ancho = enPixeles(declaraciones(propia, '.config-pagina')['max-width'] ?? '', new Map());
    expect(ancho, '.config-pagina no declara max-width').toBeDefined();
    expect(ancho).toBeGreaterThanOrEqual(1000);
    expect(ancho).toBeLessThanOrEqual(1250);
  });

  it.each([
    ['.config-intro', 'la frase de la cabecera'],
    ['.config-area-descripcion', 'la frase que orienta cada pestaña'],
    ['.config-detalle', 'lo que se pliega'],
    ['.config-permiso', 'el permiso dicho en castellano'],
  ])('%s tiene tope de renglón (%s)', (selector) => {
    expect(declaraciones(propia, selector)['max-width']).toBe('var(--medida)');
  });

  it('`--medida` está declarada y es un tope de caracteres, no de píxeles', () => {
    expect(declaraciones(propia, '.config-pagina')['--medida']).toMatch(/^\d+ch$/);
  });

  it('CONTROL NEGATIVO — detecta que se le quite el tope a la descripción del área', () => {
    const roto = sinComentarios(PROPIA).replace(
      /\.config-area-descripcion\s*\{[^{}]*\}/,
      '.config-area-descripcion { margin: 0 0 8px; }',
    );
    expect(roto).not.toBe(sinComentarios(PROPIA));
    expect(declaraciones(roto, '.config-area-descripcion')['max-width']).toBeUndefined();
  });
});

describe('el elegir-modo del alta ya no es una segunda tira de pestañas', () => {
  const todas = sinComentarios(GLOBAL) + sinComentarios(PROPIA) + sinComentarios(INTERRUPTORES);

  it('las clases de la tira vieja no existen en ninguna hoja', () => {
    expect(todas).not.toMatch(/\.alta-modos\b/);
    expect(todas).not.toMatch(/\.alta-modo(?![\w-])/);
  });

  it('el segmentado del alta no se dibuja igual que las pestañas de la página', () => {
    const tira = declaraciones(sinComentarios(PROPIA), '.config-tabs');
    const segmento = declaraciones(sinComentarios(PROPIA), '.alta-segmento');
    expect(segmento['display'], '.alta-segmento no existe en la hoja').toBeDefined();
    const firma = (d: Record<string, string>) => [d['padding'], d['border-radius'], d['display']].join('|');
    expect(firma(segmento)).not.toBe(firma(tira));
    expect(segmento['display']).toBe('inline-flex');
  });

  it('CONTROL NEGATIVO — detecta que el segmentado vuelva a copiar la forma de la tira', () => {
    const tira = declaraciones(sinComentarios(PROPIA), '.config-tabs');
    const clonado = { padding: tira['padding'], 'border-radius': tira['border-radius'], display: tira['display'] };
    const firma = (d: Record<string, string>) => [d['padding'], d['border-radius'], d['display']].join('|');
    expect(firma(clonado)).toBe(firma(tira));
  });
});

describe('las columnas de números se alinean a la derecha', () => {
  it('la hoja tiene una regla atada a `data-numero` que alinea a la derecha', () => {
    const regla = declaraciones(sinComentarios(PROPIA), "td[data-numero='true']");
    expect(regla['text-align'], "no hay regla para td[data-numero='true']").toBe('right');
    expect(regla['font-variant-numeric']).toBe('tabular-nums');
  });

  it('CONTROL NEGATIVO — detecta que se borre la regla', () => {
    const roto = sinComentarios(PROPIA).replace(/text-align: right;/, 'text-align: left;');
    expect(roto).not.toBe(sinComentarios(PROPIA));
    expect(declaraciones(roto, "td[data-numero='true']")['text-align']).not.toBe('right');
  });
});

describe('los párrafos de /config son párrafos', () => {
  it('un `<p class="muted">` vuelve a ser bloque dentro de la vista', () => {
    const regla = declaraciones(sinComentarios(PROPIA), 'p.muted');
    expect(regla['display'], 'no hay regla para p.muted dentro de .config-pagina').toBe('block');
    expect(regla['max-width']).toBe('var(--medida)');
  });

  it('CONTROL NEGATIVO — `.muted` global sigue siendo inline-flex, que es lo que hay que tapar', () => {
    expect(declaraciones(sinComentarios(GLOBAL), '.muted')['display']).toBe('inline-flex');
    const roto = sinComentarios(PROPIA).replace(/p\.muted \{[^{}]*\}/, 'p.muted { color: red; }');
    expect(roto).not.toBe(sinComentarios(PROPIA));
    expect(declaraciones(roto, 'p.muted')['display']).not.toBe('block');
  });
});

describe('el interruptor le gana a la regla de casilla de la hoja global', () => {
  it('el selector del interruptor es MÁS específico que el de la casilla genérica', () => {
    const propio = /(\.config-area\s+input(?:\[[^\]]+\])?\.interruptor)\s*\{[^{}]*width:\s*36px/
      .exec(sinComentarios(INTERRUPTORES));
    expect(propio, 'no hay ninguna regla que le dé 36px de ancho al interruptor').not.toBeNull();

    const ajeno = /(\.config-area\s+input\[type="checkbox"\][^{]*)\{[^{}]*width:\s*auto/
      .exec(sinComentarios(GLOBAL));
    expect(ajeno, 'la regla de `width: auto` de styles.css ya no existe: revisá si hace falta esto').not.toBeNull();

    expect(especificidad(propio![1])).toBeGreaterThan(especificidad('.config-area input[type="checkbox"]'));
  });

  it('CONTROL NEGATIVO — el selector que estaba desplegado empata, y empatar es perder', () => {
    expect(especificidad('.config-area input.interruptor'))
      .toBe(especificidad('.config-area input[type="checkbox"]'));
  });
});
