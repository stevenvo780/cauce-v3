import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leerCss as leer } from './test/leer-css';
import { sinComentarios } from './test/css-parser';

/** Validation of the typography scale over the stylesheets: ensures tokens are available in `:root` and no rule falls below the minimum threshold. */

/**
 * The stylesheets this guard reads. `leerCss` inlines every `@import`, so naming a sheet covers what
 * it imports. What is named NOWHERE is a sheet nobody measures: that is how `/terminal` shipped
 * 8.96px text. The completeness guard at the end of this file makes that impossible to repeat.
 */
const HOJAS = [
  'styles.css',
  'features/live/live.css',
  'features/live/live-hypergraph.css',
  'features/messages/messages.css',
  'features/queues/queues.css',
  'features/accounts/licenses.css',
  'features/auth/auth.css',
  'features/config/config.css',
  'features/config/toggles.css',
  'features/landing/landing.css',
  'features/audit/audit.css',
  'features/help/help.css',
  'features/terminal/terminal-panel.css',
] as const;

const RAIZ_CSS = resolve(process.cwd(), 'src');

/** No letter of their own to judge. A sheet earns this by declaring no measurable `font-size`. */
const SIN_LETRA: readonly { hoja: string; porque: string }[] = [
  { hoja: 'features/terminal/xterm-csp.css', porque: 'only an `@import` of the sheet below' },
  { hoja: 'features/terminal/xterm-csp-terminal.css', porque: 'its only body is `var(--pty-cuerpo, 13px)`, which the renderer sets' },
];

function hojasEnDisco(directorio = RAIZ_CSS): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(directorio)) {
    const ruta = join(directorio, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...hojasEnDisco(ruta));
    else if (ruta.endsWith('.css')) salida.push(relative(RAIZ_CSS, ruta));
  }
  return salida;
}

/** The sheets a list reaches: the ones named, plus everything they pull in through `@import`. */
function alcanzadas(hojas: readonly string[]): Set<string> {
  const vistas = new Set<string>();
  const pendientes = [...hojas];
  while (pendientes.length) {
    const hoja = pendientes.pop() ?? '';
    if (vistas.has(hoja)) continue;
    vistas.add(hoja);
    const crudo = readFileSync(resolve(RAIZ_CSS, hoja), 'utf8');
    for (const imp of crudo.matchAll(/@import\s+['"]([^'"]+)['"];/g)) {
      pendientes.push(relative(RAIZ_CSS, resolve(RAIZ_CSS, hoja, '..', imp[1])));
    }
  }
  return vistas;
}

function tamanosDeLetra(css: string): { selector: string; valor: string }[] {
  const salida: { selector: string; valor: string }[] = [];
  for (const regla of sinComentarios(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const declaracion of regla[2].matchAll(/(?:^|;)\s*font-size\s*:\s*([^;]+)/g)) {
      salida.push({ selector: regla[1].trim().replace(/\s+/g, ' '), valor: declaracion[1].trim() });
    }
  }
  return salida;
}

/** The variables declared in the FIRST `:root` block of a stylesheet: the base block. */
function tokensDeRoot(css: string): Map<string, string> {
  const limpio = sinComentarios(css);
  const inicio = limpio.search(/(^|})\s*:root\s*\{/);
  if (inicio < 0) return new Map();
  const abre = limpio.indexOf('{', inicio);
  const cierra = limpio.indexOf('}', abre);
  const salida = new Map<string, string>();
  for (const d of limpio.slice(abre + 1, cierra).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
    salida.set(d[1], d[2].trim());
  }
  return salida;
}

function enPixeles(valor: string, escala: Map<string, string>, saltos = 0): number | undefined {
  if (saltos > 8) return undefined;
  const bruto = valor.trim().replace(/\s*!important\s*$/, '');
  const referencia = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(bruto);
  if (referencia) {
    const destino = escala.get(referencia[1]);
    return destino === undefined ? undefined : enPixeles(destino, escala, saltos + 1);
  }
  const px = /^(\d*\.?\d+)px$/.exec(bruto);
  if (px) return Number(px[1]);
  const rem = /^(\d*\.?\d+)rem$/.exec(bruto);
  if (rem) return Number(rem[1]) * 16;
  // `clamp()` is judged by its MINIMUM: the preferred value is measured against a width nobody guarantees.
  const clamp = /^clamp\(\s*([^,]+),/.exec(bruto);
  if (clamp) return enPixeles(clamp[1], escala, saltos + 1);
  return undefined;
}

/** The floor. It is the configured value and what already rules in `/config`. */
const SUELO = 12.5;

/**
 * THE HAND-WRITTEN EXCEPTION, and the only one. `.sidebar nav a` at `.6875rem` inside
 * `@media (max-width: 760px)` is the mobile nav bar, measured against the width of its eight entries
 * at 360px: raising it makes the labels collide again, which is the bug that block fixed.
 *
 * An EXACT (selector, value) pair and not "forgive everything under `.sidebar nav a`": the same
 * selector declares `.9rem` in the base block, and a per-selector amnesty would let that one in.
 */
const EXCEPCIONES: readonly { selector: string; valor: string }[] = [
  { selector: '.sidebar nav a', valor: '.6875rem' },
];

const esExcepcion = (selector: string, valor: string) =>
  EXCEPCIONES.some((e) => e.selector === selector && e.valor === valor);

/**
 * Every letter below the floor. The sheets are passed as TEXT —not read from disk— so a mutated one
 * can be fed in and forced to fail: a guard that only reads the real file cannot test itself.
 */
function letraPorDebajoDelSuelo(hojas: string[], suelo = SUELO): string[] {
  const escala = tokensDeRoot(hojas.join('\n'));
  const fallos: string[] = [];
  for (const hoja of hojas) {
    for (const { selector, valor } of tamanosDeLetra(hoja)) {
      // `inherit`/`0` do not declare a font-size of their own: there is nothing to judge.
      if (/^(inherit|initial|unset|revert)$/.test(valor)) continue;
      if (esExcepcion(selector, valor)) continue;
      const px = enPixeles(valor, escala);
      if (px === undefined) {
        fallos.push(`${selector} { font-size: ${valor} } no se sabe resolver a píxeles`);
        continue;
      }
      if (px + 0.001 < suelo) {
        fallos.push(`${selector} { font-size: ${valor} } = ${String(px)}px, el suelo es ${String(suelo)}px`);
      }
    }
  }
  return fallos;
}

/**
 * The reason this file has no overflow test, written as an executable assertion so it is a proven
 * fact on every run. If jsdom ever starts doing layout, this turns red and says so.
 */
describe('la premisa: por qué la prueba de desborde NO vive en jsdom', () => {
  it('jsdom NO calcula layout: una caja forzada a desbordar 50 veces informa 0 y 0', () => {
    const caja = document.createElement('div');
    caja.style.width = '100px';
    caja.style.overflow = 'auto';
    const hijo = document.createElement('div');
    hijo.style.width = '5000px';
    hijo.textContent = 'x'.repeat(5000);
    caja.appendChild(hijo);
    document.body.appendChild(caja);

    // `scrollWidth > clientWidth` is the textbook overflow check. Here it is `0 > 0`.
    expect(caja.scrollWidth, 'jsdom empezó a calcular scrollWidth').toBe(0);
    expect(caja.clientWidth, 'jsdom empezó a calcular clientWidth').toBe(0);
    expect(caja.scrollWidth > caja.clientWidth, 'el desborde MÁS grosero posible da falso').toBe(false);
    // And without layout there is no computed size to measure either: `getComputedStyle` returns empty.
    expect(getComputedStyle(hijo).fontSize, 'jsdom empezó a resolver font-size').toBe('');

    caja.remove();
  });
});

/**
 * It used to be declared in `.config-pagina`, so it only existed inside /config while five rules of
 * `toggles.css` cited it from components used elsewhere. An undeclared variable does not inherit:
 * the whole declaration falls through and the cascade next door wins, without a single warning.
 */
const ESCALA = ['--tipo-titulo', '--tipo-panel', '--tipo-cuerpo', '--tipo-rotulo', '--tipo-apunte'];

describe('la escala tipográfica es GLOBAL', () => {
  const global = leer('styles.css');
  const tokens = tokensDeRoot(global);

  it('los seis escalones están declarados en el `:root` de la hoja global', () => {
    for (const nombre of [...ESCALA, '--tipo-mono']) {
      const val = tokens.get(nombre);
      expect(typeof val, `${nombre} no está en el :root de styles.css`).toBe('string');
      if (val) {
        expect(enPixeles(val, tokens) ?? 0, `${nombre} no resuelve a píxeles`).toBeGreaterThan(0);
      }
    }
  });

  it('van de mayor a menor, sin dos escalones iguales', () => {
    const px = ESCALA.map((n) => {
      const val = tokens.get(n);
      return val ? enPixeles(val, tokens) : undefined;
    });
    for (let i = 1; i < px.length; i += 1) {
      expect(px[i], `${ESCALA[i]} (${String(px[i] ?? '')}px) no baja de ${ESCALA[i - 1]} (${String(px[i - 1] ?? '')}px)`)
        .toBeLessThan(px[i - 1] ?? 0);
    }
  });

  it('el suelo de la escala es 12,5px y el monoespaciado no se sale', () => {
    const apunte = tokens.get('--tipo-apunte');
    const cuerpo = tokens.get('--tipo-cuerpo');
    const rotulo = tokens.get('--tipo-rotulo');
    const monoToken = tokens.get('--tipo-mono');
    expect(apunte ? (enPixeles(apunte, tokens) ?? 0) : 0).toBeGreaterThanOrEqual(SUELO);
    expect(cuerpo ? (enPixeles(cuerpo, tokens) ?? 0) : 0).toBeGreaterThanOrEqual(13);
    expect(rotulo ? (enPixeles(rotulo, tokens) ?? 0) : 0).toBeGreaterThanOrEqual(13);
    const mono = monoToken ? (enPixeles(monoToken, tokens) ?? 0) : 0;
    const cuerpoPx = cuerpo ? (enPixeles(cuerpo, tokens) ?? 0) : 0;
    expect(mono).toBeGreaterThanOrEqual(SUELO);
    expect(mono).toBeLessThanOrEqual(cuerpoPx);
  });

  /**
   * NEGATIVE CONTROL. The likely regression is not deleting the tokens but putting them back inside
   * a page selector, so the reader has to stop finding them when `:root` becomes `.config-pagina`.
   */
  it('CONTROL NEGATIVO — encerrar la escala en `.config-pagina` la vuelve invisible para el resto', () => {
    const roto = global.replace(/(^|\n):root \{/, '$1.config-pagina {');
    expect(roto, 'la mutación no cambió nada: el aserto no probaría nada').not.toBe(global);
    expect(tokensDeRoot(roto).get('--tipo-cuerpo')).toBeUndefined();
  });

  /** NEGATIVE CONTROL — a flattened scale (body and label equal) is not a scale. */
  it('CONTROL NEGATIVO — marca una escala aplanada', () => {
    const plana = tokensDeRoot(global.replace('--tipo-rotulo: 13px', '--tipo-rotulo: 14px'));
    expect(plana.get('--tipo-rotulo')).toBe('14px');
    const rotuloVal = plana.get('--tipo-rotulo');
    const cuerpoVal = plana.get('--tipo-cuerpo');
    expect(rotuloVal ? (enPixeles(rotuloVal, plana) ?? 0) : 0)
      .not.toBeLessThan(cuerpoVal ? (enPixeles(cuerpoVal, plana) ?? 0) : 0);
  });
});

describe('ninguna hoja de la consola declara letra por debajo del suelo', () => {
  const hojas = HOJAS.map(leer);

  it(`las ${String(HOJAS.length)} hojas del reparto están por encima de ${String(SUELO)}px`, () => {
    expect(letraPorDebajoDelSuelo(hojas)).toEqual([]);
  });

  /**
   * NEGATIVE CONTROL BY MUTATION, with values that were deployed and measured. Without it,
   * `letraPorDebajoDelSuelo()` could return `[]` for finding NO rule and approve any sheet.
   */
  it('CONTROL NEGATIVO — marca los tamaños que estaban desplegados', () => {
    expect(letraPorDebajoDelSuelo(['.x { font-size: .53rem; }'])).toHaveLength(1);
    expect(letraPorDebajoDelSuelo(['.x { font-size: .58rem; }'])).toHaveLength(1);
    expect(letraPorDebajoDelSuelo(['.x { font-size: .68rem; }'])).toHaveLength(1);
    // And that the floor is what was stated: 12px does NOT pass, 12.5 does.
    expect(letraPorDebajoDelSuelo(['.x { font-size: 12px; }'])).toHaveLength(1);
    expect(letraPorDebajoDelSuelo(['.x { font-size: 12.5px; }'])).toEqual([]);
  });

  /**
   * NEGATIVE CONTROL of the reader: if `tamanosDeLetra()` stopped entering `@media` blocks the guard
   * would go green on a broken sheet, and three of /terminal's sub-floor sizes lived inside one.
   */
  it('CONTROL NEGATIVO — el lector SÍ entra en los bloques `@media`', () => {
    expect(letraPorDebajoDelSuelo(['@media (max-width: 760px) { .x { font-size: .58rem; } }']))
      .toHaveLength(1);
  });

  /** NEGATIVE CONTROL of token resolution: a value that is not understood cannot count as approved. */
  it('CONTROL NEGATIVO — un `var()` que no existe se denuncia, no se aprueba', () => {
    expect(letraPorDebajoDelSuelo(['.x { font-size: var(--tipo-inventado); }']))
      .toContainEqual(expect.stringContaining('no se sabe resolver'));
    const conRoot = ':root { --tipo-apunte: 12.5px; }\n.x { font-size: var(--tipo-apunte); }';
    expect(letraPorDebajoDelSuelo([conRoot])).toEqual([]);
  });
});

/**
 * THE HOLE THIS GUARD HAD. `HOJAS` was hand-written, so a sheet was measured only if somebody
 * remembered to add it: three were not, and `/terminal` shipped 8.96px text with both typographic
 * guards green. A list that can silently be incomplete measures whatever it happens to name.
 */
function hojasSinMedir(hojas: readonly string[], exentas: readonly { hoja: string }[]): string[] {
  const cubiertas = alcanzadas(hojas);
  const perdonadas = new Set(exentas.map((e) => e.hoja));
  return hojasEnDisco().filter((hoja) => !cubiertas.has(hoja) && !perdonadas.has(hoja));
}

describe('el reparto de hojas está COMPLETO: ninguna se queda sin medir', () => {
  it('cada `.css` de la consola está en `HOJAS`, llega por `@import` o está en `SIN_LETRA`', () => {
    expect(hojasSinMedir(HOJAS, SIN_LETRA)).toEqual([]);
  });

  it('las exentas siguen sin declarar una letra que este guardián sepa juzgar', () => {
    for (const { hoja, porque } of SIN_LETRA) {
      expect(porque.length, `${hoja} está exenta sin decir por qué`).toBeGreaterThan(10);
      for (const { valor } of tamanosDeLetra(leer(hoja))) {
        expect(/^var\(--pty-cuerpo/.test(valor), `${hoja} declara ${valor}: ya no está exenta`).toBe(true);
      }
    }
  });

  /**
   * NEGATIVE CONTROL. Without it `hojasSinMedir()` could return `[]` because it finds nothing on
   * disk, and would approve any list. Dropping the guilty sheet has to bring it back by name.
   */
  it('CONTROL NEGATIVO — quitar una hoja del reparto hace fallar al guardián', () => {
    const sinTerminal = HOJAS.filter((h) => h !== 'features/terminal/terminal-panel.css');
    expect(hojasSinMedir(sinTerminal, SIN_LETRA)).toEqual(['features/terminal/terminal-panel.css']);
    // And an `@import` counts as coverage: `styles.css` is what covers the three sheets it pulls in.
    expect(hojasSinMedir(HOJAS.filter((h) => h !== 'styles.css'), SIN_LETRA))
      .toEqual(expect.arrayContaining(['styles.css', 'styles/base.css']));
  });

  /** NEGATIVE CONTROL — and an exemption is a name, not a blanket: an invented one covers nothing. */
  it('CONTROL NEGATIVO — perdonar una hoja que no existe no tapa a la que falta', () => {
    const sinAudit = HOJAS.filter((h) => h !== 'features/audit/audit.css');
    expect(hojasSinMedir(sinAudit, [{ hoja: 'features/audit/inventada.css' }]))
      .toContain('features/audit/audit.css');
  });
});

describe('los elementos que el NAVEGADOR encoge por su cuenta tienen suelo propio', () => {
  const global = sinComentarios(leer('styles.css'));

  it('`small` tiene un `font-size` explícito en la hoja global', () => {
    const regla = /(^|[},])\s*small\s*\{([^{}]*)\}/.exec(global);
    expect(regla, 'no hay una regla `small { … }` en styles.css: vuelve a mandar el UA').not.toBeNull();
    if (regla) {
      const valor = /(?:^|;)\s*font-size\s*:\s*([^;]+)/.exec(regla[2])?.[1]?.trim();
      expect(valor, '`small` no declara font-size: el navegador le pone `smaller`').toBeDefined();
      if (valor) {
        expect(enPixeles(valor, tokensDeRoot(leer('styles.css')))).toBeGreaterThanOrEqual(SUELO);
      }
    }
  });

  it('`.subline` declara su propio tamaño y no lo hereda del UA', () => {
    const regla = /(^|[},])\s*\.subline\s*\{([^{}]*)\}/.exec(global);
    expect(regla, 'no hay regla `.subline`').not.toBeNull();
    if (regla) {
      expect(/(?:^|;)\s*font-size\s*:/.test(regla[2]), '`.subline` sin font-size = 10,67px del UA')
        .toBe(true);
    }
  });
});

describe('la barra de navegación de móvil conserva su excepción medida', () => {
  const global = leer('styles.css');

  it('`.sidebar nav a` sigue a `.6875rem` dentro del corte de móvil', () => {
    const limpio = sinComentarios(global);
    const inicio = limpio.indexOf('@media (max-width: 760px)');
    expect(inicio, 'desapareció el corte de móvil').toBeGreaterThan(-1);
    const bloque = limpio.slice(inicio, limpio.indexOf('\n}', inicio));
    expect(bloque).toContain('font-size: .6875rem');
  });

  /**
   * The comment is the only place that records why that number does not go up with the rest: without
   * it the next sweep "fixes" it and the eight labels collide again at 360px.
   */
  it('el comentario que explica por qué NO se toca sigue en la hoja', () => {
    expect(global).toContain('360');
    expect(global).toMatch(/no se toca|NO sale de la escala|no sube con el resto/i);
  });
});
