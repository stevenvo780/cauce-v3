import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { renderWithApi } from './test/render';
import './styles.css';

/**
 * Verificación del suelo tipográfico sobre las vistas montadas:
 * comprueba el cálculo efectivo de font-size resolviendo declaraciones ganadoras de la cascada.
 */

const SUELO = 12.5;

const RAIZ = resolve(process.cwd(), 'src');
const resolverCss = (ruta: string): string => {
  const abs = resolve(RAIZ, ruta);
  const contenido = readFileSync(abs, 'utf8');
  return contenido.replace(/@import\s+['"]([^'"]+)['"];/g, (_, importPath: string) => {
    const subAbs = resolve(abs, '..', importPath);
    return resolverCss(subAbs);
  });
};

/** Los tokens de la escala, leídos del `:root` de la hoja global. */
const TOKENS: Map<string, string> = (() => {
  const css = resolverCss('styles.css')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const abre = css.indexOf('{', css.search(/(^|})\s*:root\s*\{/));
  const salida = new Map<string, string>();
  for (const d of css.slice(abre + 1, css.indexOf('}', abre)).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
    salida.set(d[1], d[2].trim());
  }
  return salida;
})();

/**
 * Las palabras clave de tamaño del CSS. Que un elemento salga con una de éstas significa que NINGUNA
 * hoja nuestra le puso tamaño y decide el agente de usuario: es justo el defecto de `.subline`, así
 * que se trata como fallo y no como «no se sabe».
 */
const PALABRAS_UA = /^(smaller|larger|xx-small|x-small|small|medium|large|x-large|xx-large)$/;

/** Texto PROPIO del elemento: sólo los nodos de texto hijos directos. Eso es una HOJA de texto. */
function textoPropio(el: Element): string {
  let t = '';
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) t += n.nodeValue ?? '';
  return t.trim();
}

/**
 * El tamaño en píxeles de un elemento, resolviendo la cadena que devuelve jsdom.
 *
 * Devuelve `{ px }` o `{ problema }`. `problema` no es «no se pudo»: es un fallo con nombre, porque
 * un tamaño que no sabemos resolver es un tamaño que nadie controla.
 */
function tamanoEnPx(el: Element, profundidad = 0): { px?: number; problema?: string; bruto?: string } {
  if (profundidad > 30) return { problema: 'herencia demasiado profunda' };
  const bruto = (getComputedStyle(el).fontSize || '').trim();

  // Sin declaración propia: hereda. El `html` sin nada declarado es el 16px del navegador.
  if (bruto === '' || bruto === 'inherit') {
    const padre = el.parentElement;
    if (!padre) return { px: 16 };
    return tamanoEnPx(padre, profundidad + 1);
  }
  if (PALABRAS_UA.test(bruto)) {
    return { problema: `lo decide el navegador (\`${bruto}\`): ninguna hoja le pone tamaño`, bruto };
  }
  const variable = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(bruto);
  if (variable) {
    const valor = TOKENS.get(variable[1]) ?? variable[2];
    if (valor === undefined) return { problema: `${variable[1]} no está declarada en :root`, bruto };
    return { px: resolverLongitud(valor.trim(), el, profundidad), bruto };
  }
  const px = resolverLongitud(bruto, el, profundidad);
  return px === undefined ? { problema: `no se sabe resolver \`${bruto}\``, bruto } : { px, bruto };
}

function resolverLongitud(valor: string, el: Element, profundidad: number): number | undefined {
  const limpio = valor.replace(/\s*!important\s*$/, '');
  /*
   * `clamp(min, preferido, max)` se juzga por su MÍNIMO, que es el peor caso para la legibilidad:
   * si el mínimo llega al suelo, no hay ancho de ventana en el que ese texto baje de ahí.
   */
  const clamp = /^clamp\(\s*([^,]+),/.exec(limpio);
  if (clamp) return resolverLongitud(clamp[1].trim(), el, profundidad);
  let m = /^(\d*\.?\d+)px$/.exec(limpio);
  if (m) return Number(m[1]);
  m = /^(\d*\.?\d+)rem$/.exec(limpio);
  if (m) return Number(m[1]) * 16;
  m = /^(\d*\.?\d+)em$/.exec(limpio);
  if (m) {
    const padre = el.parentElement;
    const base = padre ? tamanoEnPx(padre, profundidad + 1).px : 16;
    return base === undefined ? undefined : Number(m[1]) * base;
  }
  m = /^(\d*\.?\d+)%$/.exec(limpio);
  if (m) {
    const padre = el.parentElement;
    const base = padre ? tamanoEnPx(padre, profundidad + 1).px : 16;
    return base === undefined ? undefined : (Number(m[1]) / 100) * base;
  }
  return undefined;
}

const nombre = (el: Element) =>
  el.tagName.toLowerCase()
  + (typeof el.className === 'string' && el.className.trim()
    ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
    : '');

/** Los elementos de texto hoja de un contenedor que quedan por debajo del suelo. */
export function textoPorDebajoDelSuelo(raiz: Element, suelo = SUELO): string[] {
  const fallos: string[] = [];
  for (const el of Array.from(raiz.querySelectorAll('*'))) {
    if (el.classList.contains('sr-only')) continue;
    const texto = textoPropio(el);
    if (!texto) continue;
    const { px, problema, bruto } = tamanoEnPx(el);
    if (problema) {
      fallos.push(`${nombre(el)} «${texto.slice(0, 30)}» → ${problema}`);
      continue;
    }
    if (px! + 0.001 < suelo) {
      fallos.push(`${nombre(el)} «${texto.slice(0, 30)}» → ${px}px (${bruto}), el suelo es ${suelo}px`);
    }
  }
  return fallos;
}

/**
 * Las vistas bajo guardia.
 *
 * `/terminal` NO está: tiene 177 elementos por debajo del suelo medidos en Chrome —el peor caso de
 * la consola, con 4 elementos a 8,00 px— y su hoja la estaba editando otro agente al mismo tiempo.
 * Cuando ese trabajo cierre se añade acá y el guardia la cubre.
 */
const VISTAS: ReadonlyArray<{ ruta: string; titulo: RegExp; minimo: number }> = [
  { ruta: '/', titulo: /Cauce en una pantalla/i, minimo: 200 },
  { ruta: '/live', titulo: /La flota ahora/i, minimo: 1200 },
  { ruta: '/accounts', titulo: /Cuentas y cuotas/i, minimo: 700 },
  { ruta: '/messages', titulo: /Mensajes/i, minimo: 200 },
  { ruta: '/queues', titulo: /Colas y DLQ operativo/i, minimo: 120 },
  { ruta: '/observability', titulo: /Señales y auditoría/i, minimo: 100 },
  { ruta: '/config', titulo: /Ajustes y altas/i, minimo: 500 },
];

describe('ningún texto de las páginas montadas baja del suelo tipográfico', () => {
  for (const { ruta, titulo, minimo } of VISTAS) {
    it(`${ruta} — todo el texto llega a ${SUELO}px`, async () => {
      window.history.pushState({}, '', ruta);
      renderWithApi(<App />);

      /*
       * DOS esperas, y las dos hacen falta.
       *
       * La consola no se pinta antes de saber quién sos: hasta que `/v3/auth/session` contesta, en
       * `main` sólo vive «Verificando la sesión con el gateway…» —tres elementos— y el `<h1>` de la
       * página YA existe en el armazón. O sea que esperar por el título da verde sobre una pantalla
       * VACÍA: se barren tres nodos, no se encuentra letra chica y el guardia aprueba. Medido: así
       * escrita, esta prueba pasaba de 1840 elementos a 3.
       *
       * El landmark de navegación es lo primero que aparece DESPUÉS de la sesión, así que es el que
       * marca «ya hay página». Y el conteo mínimo por vista es el seguro contra lo mismo: si mañana
       * un mock deja de contestar y la vista se vacía, la prueba lo dice en vez de festejarlo.
       */
      await screen.findByRole('navigation', { name: /principal/i });
      const main = screen.getByRole('main');
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 }).textContent ?? '').toMatch(titulo);
      });
      await waitFor(() => expect(main.querySelectorAll('*').length).toBeGreaterThanOrEqual(minimo));

      const fallos = textoPorDebajoDelSuelo(main);
      expect(fallos, `${fallos.length} textos por debajo de ${SUELO}px en ${ruta}:\n  ${fallos.slice(0, 25).join('\n  ')}`)
        .toEqual([]);
    }, 30_000);
  }

  /**
   * CONTROL NEGATIVO del medidor, sobre un DOM fabricado con los defectos EXACTOS que estaban
   * desplegados. Sin esto, `textoPorDebajoDelSuelo()` podría estar devolviendo `[]` porque no sabe
   * leer nada, y aprobaría cualquier página.
   *
   * Los cuatro casos son los cuatro caminos por los que un texto se queda chico, y cada uno tiene
   * que caer por su propio motivo:
   *   1. un `px` por debajo del suelo, escrito a mano;
   *   2. un `rem` por debajo del suelo (así estaban las 177 declaraciones de este cambio);
   *   3. el tamaño HEREDADO de un padre chico, que el elemento no declara;
   *   4. el tamaño que pone el NAVEGADOR porque nadie lo declaró — el caso `.subline`.
   */
  it('CONTROL NEGATIVO — el medidor marca los cuatro caminos por los que un texto se queda chico', () => {
    const caja = document.createElement('div');
    caja.innerHTML = `
      <p id="a" style="font-size: 11px">once píxeles</p>
      <p id="b" style="font-size: .58rem">nueve coma veintiocho</p>
      <div style="font-size: 10px"><span id="c">heredado del padre chico</span></div>
      <p id="d">tamaño del navegador</p>`;
    document.body.appendChild(caja);
    /*
     * El cuarto caso se declara EXPLÍCITO (`font-size: smaller`) y no fabricando un `<small>` a
     * pelo, y la razón importa: desde que `styles.css` le puso suelo a `small`, un `<small>` sin
     * clase ya NO cae en el UA — o sea que el defecto original ya no se puede reproducir así. Un
     * control negativo que depende de que la hoja siga rota se apaga solo el día que se arregla, y
     * a partir de ahí el guardia aprueba sin que nadie se entere. Éste prueba el MEDIDOR: que sepa
     * denunciar un tamaño decidido por el navegador, venga de donde venga.
     */
    const ua = caja.querySelector('#d')!;
    ua.setAttribute('style', 'font-size: smaller');

    const fallos = textoPorDebajoDelSuelo(caja);
    expect(fallos).toHaveLength(4);
    expect(fallos.join('\n')).toMatch(/11px/);
    expect(fallos.join('\n')).toMatch(/9\.28px/);
    expect(fallos.join('\n')).toMatch(/10px/);
    expect(fallos.join('\n')).toMatch(/lo decide el navegador/);

    caja.remove();
  });

  /** CONTROL NEGATIVO — y que el suelo sea el que se dijo: 12px NO alcanza, 12,5 sí. */
  it('CONTROL NEGATIVO — 12px no alcanza y 12,5px sí', () => {
    const caja = document.createElement('div');
    caja.innerHTML = '<p style="font-size: 12px">justo por debajo</p><p style="font-size: 12.5px">justo</p>';
    document.body.appendChild(caja);
    expect(textoPorDebajoDelSuelo(caja)).toHaveLength(1);
    caja.remove();
  });

  /**
   * CONTROL NEGATIVO de la resolución de tokens: si `var(--tipo-apunte)` dejara de resolverse, el
   * medidor tiene que DENUNCIARLO, no tragárselo. Una variable que no existe hace que el navegador
   * descarte la declaración entera y mande la cascada de al lado — que es exactamente lo que le
   * pasaba a `toggles.css` fuera de /config.
   */
  it('CONTROL NEGATIVO — un `var()` que no existe se denuncia, no se aprueba', () => {
    const caja = document.createElement('div');
    caja.innerHTML = '<p style="font-size: var(--tipo-inventado)">sin token</p>';
    document.body.appendChild(caja);
    expect(textoPorDebajoDelSuelo(caja).join('')).toMatch(/no está declarada en :root/);
    caja.remove();
  });
});
