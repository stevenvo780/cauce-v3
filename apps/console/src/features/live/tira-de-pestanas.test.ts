import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 **La tira de pestañas del cajón se dibujaba FUERA del cajón y le ponía barra horizontal a la
 * página entera. Medido en Chrome headless el 2026-08-24, 1280x900 y 360x800, tema claro, con el
 * cajón abierto en `/live?agente=Steven/zeus&pestana=rol`.**
 *
 * `.agent-drawer-tabs` era `display: flex` a secas: `flex-wrap: nowrap` y `overflow-x: visible`
 * por defecto, dentro de una columna de cajón de **420 px** (`.live-page.has-drawer`). Una tira
 * así no tiene NINGÚN mecanismo para caber; sólo cabía mientras los rótulos sumaran poco.
 *
 * Números medidos, todos en Chrome, sobre la rama que añade «Ficheros»:
 *
 * | pestañas | tira pide | cajón | documento a 1280 | ventana a 360 |
 * |---------:|----------:|------:|-----------------:|--------------:|
 * | 5 (antes de «Ficheros») | 434 px | 420 px | 1280 (aún sin barra) | **450** |
 * | 6 (con «Ficheros»)      | 519 px | 420 px | **1342** con barra   | **535** |
 * | 6, ya envolviendo       | 418 px | 420 px | 1280                 | 360     |
 *
 * Las dos lecturas que importan de esa tabla:
 *
 * 1. **El defecto ya estaba con CINCO pestañas.** La tira se salía 14 px del cajón y a 360 px ya
 *    obligaba al navegador a ensanchar el viewport a 450 —la consola entera al 80%—. «Ficheros»
 *    no lo causó: lo hizo visible. Cualquier séptima pestaña lo repetiría. Por eso el arreglo va
 *    en la TIRA y no en la pestaña nueva, y por eso esta prueba no cuenta seis pestañas.
 * 2. **A 360 px el síntoma no es una barra de desplazamiento, es un ZOOM.** Con
 *    `width=device-width`, cuando el contenido no cabe Chrome ensancha el viewport en vez de
 *    recortar, así que `scrollWidth == innerWidth` sale CIERTO estando mal. Lo que delata el
 *    fallo es que `innerWidth` deja de ser 360. Medir sólo `scrollWidth > clientWidth` a 360 px
 *    da verde siempre.
 *
 * **Por qué se comprueba sobre la hoja y no sobre el DOM:** jsdom no tiene layout. Las 981
 * pruebas de la consola pasaban con las dos últimas pestañas dibujadas fuera del cajón, porque
 * para jsdom todo mide cero. Acá se comprueba que la hoja declara el mecanismo; el efecto se
 * midió en el navegador y está en la tabla de arriba.
 */
const HOJA = readFileSync(resolve(process.cwd(), 'src/features/live/live.css'), 'utf8');
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

  /*
   * El corazón del arreglo. `display: flex` sin nada más es la tira de 519 px dentro de 420: hay
   * que declarar CÓMO cabe. Se aceptan las dos formas —envolver o desplazar— porque las dos
   * contienen el desborde; la que se eligió, mirando las dos renderizadas, fue envolver: con
   * scroll horizontal quedaban escondidas tres de las seis pestañas (incluida la ACTIVA a 360 px)
   * detrás de un gesto que con un ratón no existe.
   */
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

  /*
   * La otra mitad. Al envolver, el desborde deja de ir a la página y pasa al rótulo: un flex item
   * que puede encogerse se encoge, y el navegador parte «Conexión» a mitad de palabra para que
   * quepa. Ya nos mordió con «Configuración y altas». `flex: none` le quita el permiso de
   * encogerse y `white-space: nowrap` el de partirse.
   *
   * OJO CON EL MÉTODO: esto NO se caza con `scrollWidth > clientWidth`. Con la palabra partida el
   * navegador ya evitó el desborde, así que esa resta da 0 tanto si el rótulo está entero como si
   * está roto en dos líneas. Se ve mirando la tira renderizada; acá se guarda la causa.
   */
  it('la pestaña no se encoge ni parte el rótulo a mitad de palabra', () => {
    expect(valor(SIN_COMENTARIOS, '.agent-drawer-tab', 'flex')).toBe('none');
    expect(valor(SIN_COMENTARIOS, '.agent-drawer-tab', 'white-space')).toBe('nowrap');
  });

  /*
   * El guardián sólo vale si la tira sigue siendo más ancha que el cajón. Si mañana el cajón
   * creciera hasta caber la tira de un tirón, esta prueba dejaría de proteger nada sin avisar, y
   * el siguiente que añada una pestaña volvería a empezar. 420 px es el ancho declarado hoy.
   */
  it('el cajón sigue midiendo 420 px, que es lo que hace falta contener', () => {
    expect(valor(SIN_COMENTARIOS, '.live-page.has-drawer', 'grid-template-columns'))
      .toContain('420px');
  });
});
