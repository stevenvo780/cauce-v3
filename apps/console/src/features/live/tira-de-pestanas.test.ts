import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Verificación de envoltura flex para la tira de pestañas del cajón de agentes:
 * asegura que `.agent-drawer-tabs` declare `flex-wrap: wrap` para evitar desbordes horizontales.
 */
function leerCss(rutaAbs: string): string {
  const contenido = readFileSync(rutaAbs, 'utf8');
  return contenido.replace(/@import\s+['"]([^'"]+)['"];/g, (_, importPath: string) => {
    const subAbs = resolve(rutaAbs, '..', importPath);
    return leerCss(subAbs);
  });
}
const HOJA = leerCss(resolve(process.cwd(), 'src/features/live/live.css'));
/** Sin comentarios: si no, un `flex-wrap: wrap` citado en la prosa contaría como declaración. */
const SIN_COMENTARIOS = HOJA.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Todos los cuerpos de regla de un selector, en orden de aparición (el último es el que gana). */
function cuerpos(css: string, selector: string): string[] {
  const escapado = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patron = new RegExp(`(?:^|[};])\\s*${escapado}\\s*\\{([^}]*)\\}`, 'g');
  const salida: string[] = [];
  for (let m = patron.exec(css); m; m = patron.exec(css)) salida.push(m[1]);
  return salida;
}

/** Valor efectivo de una propiedad: el de la ÚLTIMA regla que la declara. */
function valor(css: string, selector: string, propiedad: string): string | undefined {
  const encontrados = cuerpos(css, selector)
    .map((cuerpo) => new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`).exec(cuerpo)?.[1].trim())
    .filter((v): v is string => Boolean(v));
  return encontrados.at(-1);
}

describe('la tira de pestañas del cajón cabe en el cajón', () => {
  it('hay una regla para .agent-drawer-tabs donde mirar', () => {
    expect(cuerpos(SIN_COMENTARIOS, '.agent-drawer-tabs')).not.toHaveLength(0);
  });

  // Contención de desborde mediante envoltura o desplazamiento.
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

  // Evita que los rótulos se partan a mitad de palabra o se encojan indebidamente.
  it('la pestaña no se encoge ni parte el rótulo a mitad de palabra', () => {
    expect(valor(SIN_COMENTARIOS, '.agent-drawer-tab', 'flex')).toBe('none');
    expect(valor(SIN_COMENTARIOS, '.agent-drawer-tab', 'white-space')).toBe('nowrap');
  });

  // Ancho declarado de 420 px para el cajón.
  it('el cajón sigue midiendo 420 px, que es lo que hace falta contener', () => {
    expect(valor(SIN_COMENTARIOS, '.live-page.has-drawer', 'grid-template-columns'))
      .toContain('420px');
  });
});
