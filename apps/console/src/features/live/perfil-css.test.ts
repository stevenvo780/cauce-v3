import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Verificación de reglas CSS y layout para el editor de perfil en el cajón de agentes.
 */
function leerCss(rutaAbs: string): string {
  const contenido = readFileSync(rutaAbs, 'utf8');
  return contenido.replace(/@import\s+['"]([^'"]+)['"];/g, (_, importPath: string) => {
    const subAbs = resolve(rutaAbs, '..', importPath);
    return leerCss(subAbs);
  });
}
const HOJA = leerCss(resolve(process.cwd(), 'src/features/live/live.css'));
/** Sin comentarios: si no, un `@container` citado en la prosa contaría como declaración. */
const SIN_COMENTARIOS = HOJA.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Todos los cuerpos de regla de un selector, en orden de aparición (el último es el que gana). */
function cuerpos(css: string, selector: string): string[] {
  const escapado = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patron = new RegExp(`(?:^|[};])\\s*${escapado}\\s*\\{([^}]*)\\}`, 'g');
  const salida: string[] = [];
  for (let m = patron.exec(css); m; m = patron.exec(css)) salida.push(m[1]);
  return salida;
}

describe('el editor de perfil tiene sitio donde caber', () => {
  it('el cajón se ensancha cuando la pestaña abierta es «Perfil»', () => {
    const reglas = cuerpos(SIN_COMENTARIOS, '.live-page.has-drawer.cajon-ancho');
    expect(reglas.length).toBeGreaterThan(0);
    expect(reglas.join(' ')).toMatch(/grid-template-columns:[^;]*min\(/);
  });

  it('el ancho del cajón está acotado por la ventana, para no comerse el mapa', () => {
    const regla = cuerpos(SIN_COMENTARIOS, '.live-page.has-drawer.cajon-ancho').join(' ');
    expect(regla).toContain('vw');
  });

  it('el editor se parte en dos columnas por el ancho del CAJÓN, no por el de la ventana', () => {
    expect(SIN_COMENTARIOS).toMatch(/@container\s+cajon\s*\(min-width:\s*\d+px\)/);
    expect(cuerpos(SIN_COMENTARIOS, '.agent-drawer-body').join(' ')).toContain('container-type: inline-size');
  });

  it('por defecto es UNA columna: sin `@container` queda apilado y entero, no partido y minúsculo', () => {
    const base = cuerpos(SIN_COMENTARIOS.replace(/@container[^{]*\{[\s\S]*?\}\s*\}/g, ' '), '.perfil-tab');
    expect(base.length).toBeGreaterThan(0);
    const ultima = base[base.length - 1] ?? '';
    expect(ultima).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
  });

  it('el bloque del fichero hace scroll DENTRO de su caja, no arrastra el cajón', () => {
    const regla = cuerpos(SIN_COMENTARIOS, '.perfil-fichero-texto').join(' ');
    expect(regla).toMatch(/overflow:\s*auto/);
    expect(regla).toMatch(/max-height:\s*\d+px/);
  });

  it('CONTROL NEGATIVO: ninguna regla del perfil baja del suelo de 12,5 px', () => {
    const reglasDelPerfil = SIN_COMENTARIOS.split('\n').filter((linea) => linea.includes('.perfil-'));
    for (const linea of reglasDelPerfil) {
      const m = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(linea);
      if (m) expect(Number(m[1])).toBeGreaterThanOrEqual(12.5);
    }
    // Y que la prueba no sea vacua: el bloque del perfil SÍ declara tamaños de tipo.
    expect(SIN_COMENTARIOS).toMatch(/\.perfil-[a-z-]+[^{]*\{[^}]*font-size/);
  });
});
