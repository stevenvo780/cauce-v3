import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';
import { cuerposDeSelector as cuerpos, sinComentarios } from '../../test/css-parser';

/**
 * Verification of CSS and layout rules for the profile editor in the agent drawer.
 */
const HOJA = leerCss('features/live/live.css');
/** Without comments: otherwise a `@container` quoted in prose would count as a declaration. */
const SIN_COMENTARIOS = sinComentarios(HOJA);

describe('los campos canónicos tienen sitio donde caber', () => {
  it('el cajón se ensancha cuando la pestaña abierta es «Contexto»', () => {
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
    // And that the test is not vacuous: the profile block DOES declare font sizes.
    expect(SIN_COMENTARIOS).toMatch(/\.perfil-[a-z-]+[^{]*\{[^}]*font-size/);
  });
});
