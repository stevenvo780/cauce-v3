import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sinComentarios } from './test/css-parser';

const RAIZ = resolve(process.cwd(), 'src');

const ESPACIADO = /^(?:padding|margin|gap|row-gap|column-gap|inset)(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?$/;

/**
 * Lo que sigue fuera de la escala, con el motivo por el que sigue. Una clave sin `#` exime a la
 * hoja entera; con `#` exime a una regla suya.
 */
const SIN_ESCALA: Record<string, string> = {
  'features/terminal/terminal-panel.css':
    'se convierte en su propia tarea; borrar esta línea cuando su hoja esté sobre la escala',
  'styles/base.css#main':
    'los 38px laterales son los 76 que `styles.legibilidad.test.ts` tiene escritos en presupuesto()',
  'styles/responsive.css#main':
    'los 15px laterales son los 30 que presupuesto() resta por debajo de 760px',
};

export interface Hoja { hoja: string; css: string }

function hojasDelDirectorio(directorio = RAIZ, prefijo = ''): Hoja[] {
  const salida: Hoja[] = [];
  for (const entrada of readdirSync(directorio, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const ruta = join(directorio, entrada.name);
    const nombre = prefijo ? `${prefijo}/${entrada.name}` : entrada.name;
    if (entrada.isDirectory()) salida.push(...hojasDelDirectorio(ruta, nombre));
    else if (entrada.name.endsWith('.css')) salida.push({ hoja: nombre, css: readFileSync(ruta, 'utf8') });
  }
  return salida;
}

export function hojasDeLaConsola(): Hoja[] {
  return hojasDelDirectorio().map(({ hoja, css }) => ({ hoja: hoja.split(sep).join('/'), css }));
}

/** Píxeles sueltos del valor: lo que va dentro de `calc()`, `min()` o `env()` no se toca. */
function pixelesSueltos(valorCss: string): string[] {
  let plano = valorCss;
  let anterior = '';
  while (plano !== anterior) {
    anterior = plano;
    plano = plano.replace(/[a-zA-Z-]+\([^()]*\)/g, ' ');
  }
  return plano.split(/\s+/).filter((trozo) => /^-?\d+(?:\.\d+)?px$/.test(trozo));
}

interface Regla { selector: string; cuerpo: string }

function reglas(css: string): Regla[] {
  const limpio = sinComentarios(css);
  const salida: Regla[] = [];
  for (const encontrada of limpio.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const titulo = encontrada[1].trim().replace(/\s+/g, ' ');
    if (titulo.startsWith('@')) continue;
    salida.push({ selector: titulo, cuerpo: encontrada[2] });
  }
  return salida;
}

export function espaciosFueraDeEscala(hojas: Hoja[]): string[] {
  const fallos: string[] = [];
  for (const { hoja, css } of hojas) {
    if (hoja in SIN_ESCALA) continue;
    for (const { selector, cuerpo } of reglas(css)) {
      if (`${hoja}#${selector}` in SIN_ESCALA) continue;
      for (const declaracion of cuerpo.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;]+)/g)) {
        if (!ESPACIADO.test(declaracion[1])) continue;
        for (const bruto of pixelesSueltos(declaracion[2])) {
          fallos.push(`${hoja} · ${selector} { ${declaracion[1]}: ${declaracion[2].trim()} } — ${bruto} no sale de --space-1..7`);
        }
      }
    }
  }
  return fallos;
}

describe('el relleno, el margen y el hueco salen de la escala', () => {
  it('ninguna hoja de la consola escribe un píxel suelto de espaciado', () => {
    expect(espaciosFueraDeEscala(hojasDeLaConsola())).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca el hueco de 7px, uno de los siete de la banda 6-12 que se colapsó', () => {
    const fixture = [{ hoja: 'features/x/x.css', css: '.tira { display: flex; gap: 7px; }' }];
    expect(espaciosFueraDeEscala(fixture)).toContainEqual(expect.stringContaining('7px no sale de --space-1..7'));
    expect(espaciosFueraDeEscala([{ hoja: 'features/x/x.css', css: '.tira { gap: var(--space-2); }' }])).toEqual([]);
  });

  it('lo que vive dentro de `calc()` o `env()` es geometría medida y no se cuenta', () => {
    const dentro = [{ hoja: 'features/x/x.css', css: '.a { padding-bottom: calc(var(--nav-inferior-alto) + 16px); }' }];
    expect(espaciosFueraDeEscala(dentro)).toEqual([]);
  });

  it('la lista de exenciones sólo cubre lo que dice cubrir', () => {
    expect(Object.keys(SIN_ESCALA)).toContain('features/terminal/terminal-panel.css');
    const propia = [{ hoja: 'features/terminal/terminal-panel.css', css: '.a { gap: 2px; }' }];
    expect(espaciosFueraDeEscala(propia)).toEqual([]);
    const ajena = [{ hoja: 'features/terminal/otra.css', css: '.a { gap: 2px; }' }];
    expect(espaciosFueraDeEscala(ajena)).toHaveLength(1);
  });

  it('las hojas convertidas son la mayoría, así que la comprobación no es vacía', () => {
    const revisadas = hojasDeLaConsola().filter(({ hoja }) => !(hoja in SIN_ESCALA));
    expect(revisadas.length).toBeGreaterThan(15);
  });
});
