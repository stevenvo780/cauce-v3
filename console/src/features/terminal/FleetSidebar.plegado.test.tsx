import { describe, expect, it } from 'vitest';
import { cuerposDeSelector, reglasDe, type ReglaCss } from '../../test/css-parser';
import { leerCss } from '../../test/leer-css';

const hoja = leerCss('features/terminal/terminal-panel.css');
const PLEGADA = '[data-flota="plegada"]';

/** The rules the wide step applies once the rail is folded. */
function reglasDelRielPlegado(css: string): ReglaCss[] {
  return reglasDe(css).filter((regla) => regla.media.includes('min-width: 761px') && regla.selector.includes(PLEGADA));
}

/** What the folded rail hides, without the page prefix that scopes it. */
function ocultosAlPlegar(css: string): string[] {
  const salida: string[] = [];
  for (const regla of reglasDelRielPlegado(css)) {
    if (!/display:\s*none/.test(regla.cuerpo)) continue;
    for (const selector of regla.selector.split(',').map((parte) => parte.trim()).filter(Boolean)) {
      if (!selector.includes(PLEGADA)) continue;
      salida.push(selector.slice(selector.indexOf(PLEGADA) + PLEGADA.length).trim());
    }
  }
  return salida;
}

function cuerpoPlegado(css: string, cola: string): string[] {
  return reglasDelRielPlegado(css)
    .filter((regla) => regla.selector.trim() === `.ultimate-terminal-page${PLEGADA} ${cola}`)
    .map((regla) => regla.cuerpo);
}

describe('el riel plegado sigue nombrando a cada agente', () => {
  it('esconde los rótulos accesorios pero nunca el alias', () => {
    const ocultos = ocultosAlPlegar(hoja);

    expect(ocultos).toContain('.agent-name small');
    expect(ocultos).toContain('.agent-meta');
    expect(ocultos).toContain('.fleet-plegar-rotulo');
    expect(ocultos, 'quince iconos idénticos no nombran a ningún agente').not.toContain('.agent-name strong');
  });

  it('CONTROL NEGATIVO — el detector ve el alias escondido cuando lo está', () => {
    const conAliasOculto = hoja.replace(
      `.ultimate-terminal-page${PLEGADA} .agent-name small,`,
      `.ultimate-terminal-page${PLEGADA} .agent-name strong,\n  .ultimate-terminal-page${PLEGADA} .agent-name small,`,
    );
    expect(conAliasOculto).not.toEqual(hoja);
    expect(ocultosAlPlegar(conAliasOculto)).toContain('.agent-name strong');
  });

  it('el alias plegado cae bajo el icono, recortado al ancho de la tira y con tamaño de token', () => {
    const columna = cuerpoPlegado(hoja, '.agent-name');
    const alias = cuerpoPlegado(hoja, '.agent-name strong');

    expect(columna).toHaveLength(1);
    expect(columna[0]).toMatch(/flex-direction:\s*column/);
    expect(alias).toHaveLength(1);
    expect(alias[0]).toMatch(/max-width:\s*100%/);
    expect(alias[0]).toMatch(/font-size:\s*var\(--tipo-/);
    // The base rule is what truncates it; folded it only gets a narrower box.
    expect(cuerposDeSelector(hoja, '.agent-name strong')[0]).toMatch(/text-overflow:\s*ellipsis/);
  });
});
