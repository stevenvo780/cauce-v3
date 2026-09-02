/*
 * EL CONTRATO DE PÁGINA, FIJADO. Toda vista de la consola dibuja la misma cabecera y elige uno de
 * los tipos de `PageShell`; nada lo comprobaba, y así entraron un tercer tipo sin consumidor, un
 * alto de cabecera medido que nadie leía y una cabecera pegada sin aire arriba ni canto abajo.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cuerposDeSelector, sinComentarios, valor } from './test/css-parser';
import { leerCss } from './test/leer-css';

const RAIZ = resolve(process.cwd(), 'src');
const BASE = sinComentarios(leerCss('styles/base.css'));
const UI = readFileSync(join(RAIZ, 'components/ui.tsx'), 'utf8');
const CABECERA = cuerposDeSelector(BASE, '.page-header')[0] ?? '';

/* La escala de espaciado del `:root`: un pad fuera de ella es un pad que ninguna otra regla iguala. */
const ESCALA = new Set([...BASE.matchAll(/(--space-\d)\s*:/g)].map((m) => `var(${m[1]})`));

function tiposEnHoja(css: string): string[] {
  return [...new Set([...css.matchAll(/\.page-shell-([a-z]+)\s*\{/g)].map((m) => m[1]))].sort();
}

function tiposEnComponente(fuente: string): string[] {
  const union = /kind:\s*([^;]+);/.exec(fuente)?.[1] ?? '';
  return [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
}

function fuentesDeVista(directorio = RAIZ): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(directorio)) {
    const ruta = join(directorio, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...fuentesDeVista(ruta));
    else if (ruta.endsWith('.tsx') && !ruta.endsWith('.test.tsx')) salida.push(ruta);
  }
  return salida;
}

function consumidores(): Map<string, string[]> {
  const salida = new Map<string, string[]>();
  for (const ruta of fuentesDeVista()) {
    for (const uso of readFileSync(ruta, 'utf8').matchAll(/<PageShell\b[^>]*kind="([a-z]+)"/g)) {
      salida.set(uso[1], [...(salida.get(uso[1]) ?? []), relative(RAIZ, ruta)]);
    }
  }
  return salida;
}

describe('la cabecera de página es una sola en toda la consola', () => {
  it('se queda pegada arriba, a todo el ancho del contenido y en dos pistas', () => {
    expect(CABECERA, 'no hay regla `.page-header` en base.css').not.toBe('');
    expect(valor(CABECERA, 'position')).toBe('sticky');
    expect(valor(CABECERA, 'top')).toBe('0');
    expect(valor(CABECERA, 'width')).toBe('100%');
    expect(valor(CABECERA, 'z-index')).toBe('var(--layer-sticky)');
    expect(valor(CABECERA, 'grid-template-columns')).toBe('minmax(0, 1fr) auto');
  });

  /* Pegada arriba, el `padding` de `main` que le daba aire se va con el scroll: sin tope propio el
     antetítulo arranca a 2 px del borde de la ventana y se lee cortado (MEDIDO a 1920 en /config:
     2 px antes, 12 px ahora). Y el canto de abajo es lo que distingue «las filas pasan por debajo»
     de «el panel está recortado»; el fondo opaco solo no lo dice. */
  it('tiene aire arriba y canto abajo, y el aire sale de la escala', () => {
    expect(ESCALA.has(valor(CABECERA, 'padding-top') ?? ''), 'el tope no sale de la escala').toBe(true);
    expect(ESCALA.has(valor(CABECERA, 'padding-bottom') ?? '')).toBe(true);
    expect(valor(CABECERA, 'background')).toBe('var(--bg)');
    const canto = valor(CABECERA, 'border-bottom') ?? valor(CABECERA, 'box-shadow');
    expect(canto, 'la cabecera pegada no dibuja ni borde ni sombra abajo').toBeDefined();
  });

  it('CONTROL NEGATIVO — detecta que se le quite el aire o el canto', () => {
    const roto = CABECERA.replace(/padding-top:[^;]*;/, '').replace(/border-bottom:[^;]*;/, '');
    expect(roto).not.toBe(CABECERA);
    expect(valor(roto, 'position'), 'la regla se perdió: el control no prueba nada').toBe('sticky');
    expect(ESCALA.has(valor(roto, 'padding-top') ?? '')).toBe(false);
    expect(valor(roto, 'border-bottom') ?? valor(roto, 'box-shadow')).toBeUndefined();
  });

  it('la barra superior mide 44 px, que es lo que le cede a la vista', () => {
    expect(valor(cuerposDeSelector(BASE, '.topbar')[0] ?? '', 'min-height')).toBe('44px');
  });

  it('la dibuja `PageHeader`, no cada vista por su cuenta', () => {
    expect(UI).toContain('className="page-header"');
  });
});

describe('cada tipo de armazón tiene hoja y consumidor', () => {
  const enHoja = tiposEnHoja(BASE);

  it('los tipos que acepta `PageShell` son exactamente los que dibuja `base.css`', () => {
    expect(enHoja.length).toBeGreaterThan(0);
    expect(tiposEnComponente(UI)).toEqual(enHoja);
  });

  /* Regla 0: un tipo sin consumidor es geometría que nadie miró en un navegador y que la vista
     siguiente copia creyéndola probada. */
  it.each(enHoja)('a `%s` lo usa alguna vista', (tipo) => {
    expect(consumidores().get(tipo) ?? [], `.page-shell-${tipo} no lo usa ninguna vista`).not.toEqual([]);
  });

  it('CONTROL NEGATIVO — un tipo que nadie monta no aparece como consumido', () => {
    expect(tiposEnHoja('.page-shell-tablero { display: grid; }')).toEqual(['tablero']);
    expect(consumidores().get('tablero')).toBeUndefined();
  });
});
