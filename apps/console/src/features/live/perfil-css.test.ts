import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 **El editor de perfil no cabía en el cajón, y jsdom no lo puede ver.**
 *
 * Medido en Chrome headless el 2026-08-25 sobre `/live?agente=Steven/argos&pestana=perfil`, tema
 * claro, alias con arnés `openclaw` (siete ficheros, que es el caso que más ocupa):
 *
 * | cajón | columna útil | bloque del fichero | alto del editor | columnas |
 * |------:|-------------:|-------------------:|----------------:|---------:|
 * | 420 px (el de siempre) | 382 px | **181 px** | **2.235 px** | 1 |
 * | 980 px (`.cajon-ancho`) | 942 px | 461 px | 1.442 px | 2 |
 *
 * Con 420 px el bloque que enseña EL TEXTO que se va a escribir medía 181 px de ancho: legible
 * por los pelos e imposible de usar. Y no es que sobrara sitio en pantalla — a 1920 el mapa se
 * queda con 835 px de todas formas.
 *
 * **Por qué se comprueba sobre la hoja y no sobre el DOM:** jsdom no tiene layout, así que todo
 * mide cero y las 1.157 pruebas de la consola pasaban igual con el editor estrangulado. Acá se
 * comprueba que la hoja declara los mecanismos; el efecto se midió en el navegador y está en la
 * tabla de arriba.
 */
const HOJA = readFileSync(resolve(process.cwd(), 'src/features/live/live.css'), 'utf8');
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
    /*
     * `min(980px, 52vw)` y no `980px` a secas: en una pantalla de 1280 un cajón fijo de 980 px
     * dejaría el mapa en 280 px, que es peor que el problema que esto viene a resolver.
     */
    const regla = cuerpos(SIN_COMENTARIOS, '.live-page.has-drawer.cajon-ancho').join(' ');
    expect(regla).toContain('vw');
  });

  it('el editor se parte en dos columnas por el ancho del CAJÓN, no por el de la ventana', () => {
    /*
     * Un `@media (min-width: 1400px)` mira la ventana, y el cajón mide como mucho la mitad: a
     * 1920 la ventana pasa el umbral y el cajón tiene 980 px. La regla se activaría creyendo que
     * hay el doble de sitio del que hay. `@container` mide el ancho real disponible.
     */
    expect(SIN_COMENTARIOS).toMatch(/@container\s+cajon\s*\(min-width:\s*\d+px\)/);
    expect(cuerpos(SIN_COMENTARIOS, '.agent-drawer-body').join(' ')).toContain('container-type: inline-size');
  });

  it('por defecto es UNA columna: sin `@container` queda apilado y entero, no partido y minúsculo', () => {
    // La última regla que gana fuera del `@container` tiene que ser la de una columna. Si la base
    // fueran dos, un navegador sin soporte pintaría dos columnas de 180 px cada una.
    const base = cuerpos(SIN_COMENTARIOS.replace(/@container[^{]*\{[\s\S]*?\}\s*\}/g, ' '), '.perfil-tab');
    expect(base.length).toBeGreaterThan(0);
    const ultima = base[base.length - 1] ?? '';
    expect(ultima).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
  });

  it('el bloque del fichero hace scroll DENTRO de su caja, no arrastra el cajón', () => {
    /*
     * Sin `overflow: auto` propio, una línea larga del fichero desplaza el cajón entero en
     * horizontal y el botón de guardar se va fuera de la pantalla. Es el defecto que la revisión
     * de 1920 encontró en tres vistas.
     */
    const regla = cuerpos(SIN_COMENTARIOS, '.perfil-fichero-texto').join(' ');
    expect(regla).toMatch(/overflow:\s*auto/);
    expect(regla).toMatch(/max-height:\s*\d+px/);
  });

  it('CONTROL NEGATIVO: ninguna regla del perfil baja del suelo de 12,5 px', () => {
    /*
     * 12.5px es `--tipo-apunte`, el suelo acordado tras medir 889 elementos por debajo en siete
     * vistas. Se comprueba que no haya un `font-size` en píxeles crudos por debajo de él: las
     * variables se auditan aparte y en un solo sitio, que es de lo que sirven.
     */
    const reglasDelPerfil = SIN_COMENTARIOS.split('\n').filter((linea) => linea.includes('.perfil-'));
    for (const linea of reglasDelPerfil) {
      const m = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(linea);
      if (m) expect(Number(m[1])).toBeGreaterThanOrEqual(12.5);
    }
    // Y que la prueba no sea vacua: el bloque del perfil SÍ declara tamaños de tipo.
    expect(SIN_COMENTARIOS).toMatch(/\.perfil-[a-z-]+[^{]*\{[^}]*font-size/);
  });
});
