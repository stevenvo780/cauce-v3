import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';
import { bloqueMedia, cuerposDeSelector as cuerpos, sinComentarios } from '../../test/css-parser';

/** Verification of CSS and layout rules for the profile editor in the agent drawer. */
const HOJA = leerCss('features/live/live.css');
/** Without comments: otherwise a `@container` quoted in prose would count as a declaration. */
const SIN_COMENTARIOS = sinComentarios(HOJA);

/** The cut below which the drawer stops being a column: everything the column pays for is undone. */
const CORTE = bloqueMedia(SIN_COMENTARIOS, '@media (max-width: 1479px)');
const FUERA_DEL_CORTE = SIN_COMENTARIOS.replace(CORTE, ' ');
const MARCA = "table[data-objeto-principal='tabla-de-flota']";
const CELDA = `.live-page.has-drawer ${MARCA} > tbody > tr:not(.row-detail) > td`;
const ROTULO = `.live-page.has-drawer ${MARCA} > thead > tr > th`;

/** Both cells are declared as one grouped rule; read its body wherever that group appears. */
function relleno(css: string): string {
  const escapar = (parte: string) => parte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const grupo = new RegExp(`${escapar(ROTULO)},\\s*${escapar(CELDA)}\\s*\\{([^}]*)\\}`);
  return grupo.exec(css)?.[1] ?? '';
}

describe('los campos canónicos tienen sitio donde caber', () => {
  it('con «Contexto» abierto la rejilla deja UNA pista: la hoja no compite por el ancho', () => {
    const reglas = cuerpos(SIN_COMENTARIOS, '.live-page.has-drawer.cajon-ancho');
    expect(reglas.length).toBeGreaterThan(0);
    expect(reglas.join(' ')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
    expect(reglas.join(' ')).not.toMatch(/grid-template-columns:[^;]*min\(/);
  });

  it('la hoja se acota contra la ventana por su `inset`, no por una segunda columna', () => {
    const regla = cuerpos(SIN_COMENTARIOS, '.live-page.has-drawer.cajon-ancho > .agent-drawer').join(' ');
    expect(regla).toMatch(/position:\s*fixed/);
    expect(regla).toMatch(/inset:\s*var\(--space-5\)/);
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

  it('en el raíl el manual guarda suelo de alto y la lectura efectiva tiene techo', () => {
    const filas = /grid-template-rows:\s*([^;]+);/.exec(cuerpos(SIN_COMENTARIOS, '.contexto-tab').join(';'))?.[1] ?? '';
    expect(filas).toMatch(/^fit-content\(\d+%\)/);
    expect(Number(/minmax\((\d+)px,\s*1fr\)/.exec(filas)?.[1] ?? 0)).toBeGreaterThanOrEqual(160);
  });

  it('cada sección del raíl anuncia lo que esconde: borde de scroll dentro de su propia caja', () => {
    const regla = cuerpos(SIN_COMENTARIOS, '.contexto-tab > .contexto-seccion').join(' ');
    expect(regla).toMatch(/overflow:\s*auto/);
    expect(regla.match(/no-repeat local/g) ?? []).toHaveLength(2);
    expect(regla.match(/no-repeat scroll/g) ?? []).toHaveLength(2);
    expect(regla).toMatch(/linear-gradient\(var\(--border-strong\)/);
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

describe('con el cajón en columna la tabla de flota entra entera', () => {
  it('la marca sobre la que se aprietan las celdas EXISTE en la tabla', () => {
    const tabla = readFileSync(resolve(process.cwd(), 'src/features/live/FleetActivityTable.tsx'), 'utf8');
    expect(tabla).toContain('data-objeto-principal="tabla-de-flota"');
  });

  it('las celdas se aprietan y los rótulos 7-9 pueden partirse mientras el cajón toma columna', () => {
    expect(relleno(FUERA_DEL_CORTE)).toMatch(/padding:\s*var\(--space-2\)/);
    expect(cuerpos(FUERA_DEL_CORTE, `${ROTULO}:nth-child(n+7)`).join(' ')).toMatch(/white-space:\s*normal/);
  });

  it('el rótulo del último recuento se parte en la tabla BASE, y nada se lo devuelve entero', () => {
    expect(cuerpos(SIN_COMENTARIOS, `${MARCA} > thead > tr > th:last-child`).join(' '))
      .toMatch(/white-space:\s*normal/);
    const devuelven = [...SIN_COMENTARIOS.matchAll(/([^{}]*)\{[^{}]*white-space:\s*nowrap[^{}]*\}/g)]
      .map(([, selector]) => selector.trim())
      .filter((selector) => selector.includes('> th'));
    expect(devuelven.length).toBeGreaterThan(0);
    for (const selector of devuelven) expect(selector).toContain(':not(:last-child)');
  });

  it('bajo el corte, con el cajón ya en hoja, las celdas vuelven a las de `components.css`', () => {
    expect(CORTE).not.toBe('');
    expect(relleno(CORTE)).toMatch(/padding:\s*var\(--space-3\)/);
    expect(cuerpos(CORTE, `${ROTULO}:nth-child(n+7):not(:last-child)`).join(' ')).toMatch(/white-space:\s*nowrap/);
  });

  it('CONTROL NEGATIVO: nada alcanza la tabla anidada de entregas por descendencia', () => {
    const alcances = [...SIN_COMENTARIOS.matchAll(/data-objeto-principal='tabla-de-flota'\]\s*([^,{]*)/g)];
    expect(alcances.length).toBeGreaterThan(0);
    for (const [, resto] of alcances) expect(resto.trimStart().startsWith('>')).toBe(true);
  });
});
