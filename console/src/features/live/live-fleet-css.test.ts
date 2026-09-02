import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';
import { bloqueMedia, cuerposDeSelector, sinComentarios } from '../../test/css-parser';

/**
 * The sticky command strip of /live and everything that depends on it. `position` regressions are
 * invisible in a unit test and expensive on screen: two stuck bars eat the fold twice, and none at
 * all leaves a three-screen table scrolling with nothing anchored.
 */
const HOJA = sinComentarios(leerCss('features/live/live-fleet.css'));
const CONSULTA = '@media (min-width: 1101px)';
const CORTE_ANCHO = bloqueMedia(HOJA, CONSULTA);
const FUERA_DEL_CORTE = HOJA.replace(CORTE_ANCHO, ' ');
const PAGINA = readFileSync(resolve(process.cwd(), 'src/features/live/LiveFleetPage.tsx'), 'utf8');

describe('la cinta de mando sólo se pega donde cabe', () => {
  it('el corte de 1101px existe y trae la cinta pegajosa a dos columnas', () => {
    expect(CORTE_ANCHO).not.toBe('');
    const cinta = cuerposDeSelector(CORTE_ANCHO, '.live-command-strip').join(' ');
    expect(cinta).toMatch(/position:\s*sticky/);
    expect(cinta).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,/);
  });

  it('la columna del veredicto se acota contra la CINTA: un rem fijo estruja la barra a 93px', () => {
    const cinta = cuerposDeSelector(CORTE_ANCHO, '.live-command-strip').join(' ');
    const pistas = /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*(minmax\([^;]*)/.exec(cinta)?.[1] ?? '';
    expect(pistas).toMatch(/min\(/);
    expect(pistas).toMatch(/\d+%/);
  });

  it('fuera del corte la cinta NO se pega: apilada ocupa un tercio de la pantalla', () => {
    const base = cuerposDeSelector(FUERA_DEL_CORTE, '.live-command-strip');
    expect(base.length).toBeGreaterThan(0);
    expect(base.join(' ')).not.toMatch(/position:\s*sticky/);
  });
});

describe('la cabecera pegajosa global sólo se desactiva donde la cinta la sustituye', () => {
  it('dentro del corte /live renuncia a su cabecera pegajosa', () => {
    expect(cuerposDeSelector(CORTE_ANCHO, '.live-page .page-header').join(' '))
      .toMatch(/position:\s*static/);
  });

  it('fuera del corte NO renuncia a nada: sin cinta pegada, la cabecera es lo único anclado', () => {
    expect(cuerposDeSelector(FUERA_DEL_CORTE, '.live-page .page-header')).toEqual([]);
  });
});

describe('lo que se despliega desde abajo aparece por debajo de la banda pegada', () => {
  it('el margen de desplazamiento sale de la altura MEDIDA de la cinta, no de un número a mano', () => {
    const reglas = CORTE_ANCHO.split('}')
      .filter((regla) => regla.includes('scroll-margin-block-start'));
    expect(reglas.length).toBeGreaterThan(0);
    for (const regla of reglas) {
      expect(regla).toMatch(/scroll-margin-block-start:\s*calc\(var\(--live-cinta-alto/);
    }
  });

  it('y algo mide esa altura de verdad: la variable no es un adorno muerto', () => {
    expect(PAGINA).toContain("'--live-cinta-alto'");
    expect(PAGINA).toContain('ResizeObserver');
    expect(PAGINA).toMatch(/getBoundingClientRect\(\)\.height/);
  });
});

describe('el mapa no puede volver a nacer abierto', () => {
  it('el `details` del mapa se declara sin `open`', () => {
    expect(PAGINA).toMatch(/<details className="panel live-mapa">/);
  });
});
