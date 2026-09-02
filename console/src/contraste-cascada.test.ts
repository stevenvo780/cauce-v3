import { describe, expect, it } from 'vitest';
import { leerCss } from './test/leer-css';
import { bloquesDeModoClaro, cuerposDeSelector as cuerpos, reglasDe, sinComentarios } from './test/css-parser';
import { hojasDeLaConsola, type Hoja } from './styles.espaciado.test';

const live = sinComentarios(leerCss('features/live/live.css'));
const licencias = sinComentarios(leerCss('features/accounts/licenses.css'));
const mensajes = sinComentarios(leerCss('features/messages/messages.css'));
const portada = sinComentarios(leerCss('features/landing/landing.css'));
const terminal = sinComentarios(leerCss('features/terminal/terminal-panel.css'));

/** Cada bloque por preferencia del sistema se cede ante el atributo contrario que el control estampa. */
const GUARDA = new Map([['light', ':root:not([data-theme="dark"])'], ['dark', ':root:not([data-theme="light"])']]);

export function bloquesDeTemaSinGuarda(hojas: Hoja[]): string[] {
  const fallos: string[] = [];
  for (const { hoja, css } of hojas) {
    for (const regla of reglasDe(css, hoja)) {
      const preferido = /prefers-color-scheme:\s*(light|dark)/.exec(regla.media)?.[1];
      if (preferido === undefined) continue;
      const guarda = GUARDA.get(preferido) ?? '';
      for (const selector of regla.selector.split(',').map((parte) => parte.trim()).filter(Boolean)) {
        if (selector === guarda || selector.startsWith(`${guarda} `)) continue;
        fallos.push(`${hoja} · «${selector}» en el bloque ${preferido} del sistema: sin «${guarda}» pinta encima del tema contrario forzado`);
      }
    }
  }
  return fallos;
}

/** Selectores de tema claro —por media o por el gemelo del atributo— que apuntan a una clase. */
export function reglasClarasSobre(css: string, clase: string): string[] {
  const salida: string[] = [];
  for (const regla of reglasDe(css)) {
    const porMedia = /prefers-color-scheme:\s*light/.test(regla.media);
    for (const selector of regla.selector.split(',').map((parte) => parte.trim()).filter(Boolean)) {
      if (!porMedia && !selector.includes(':root[data-theme="light"]')) continue;
      if (selector.split(/[\s>+~]+/).some((parte) => parte === clase)) salida.push(selector);
    }
  }
  return salida;
}

/** The raw hexes the landing still carries. New selectors take a token; this list only shrinks. */
const HEX_DE_LA_PORTADA = ['#0b1320', '#1f5346', '#305c76', '#6d2b35', '#725622', '#f8fafd'];

/** La paleta y su bifurcación por tema viven acá y en ningún otro sitio. */
const PALETA = ['styles/base.css', 'styles/responsive.css'];

/** Bordes que no tienen token: el mismo par que `.badge-danger` y `.badge-warning` ya usan. */
const SIN_TOKEN = new Map([
  ['#74313c', 'borde de peligro; no hay token de borde por tono'],
  ['#725622', 'borde de aviso; no hay token de borde por tono'],
]);

/** Hojas que todavía escriben sus propios colores: cada una se convierte en la tarea que la posee. */
const CON_COLOR_PROPIO = new Set([
  'features/config/config.css',
  'features/config/toggles.css',
  'features/landing/landing.css',
  'features/live/live-avatar.css',
  'features/live/live-directiva-modal.css',
  'features/live/live-drawer.css',
  'features/live/live-ficheros.css',
  'features/live/live-fleet.css',
  'features/live/live-hypergraph.css',
  'features/live/live-perfil.css',
  'features/messages/messages.css',
  'features/queues/queues.css',
  'features/terminal/terminal-panel.css',
  'features/terminal/xterm-csp-terminal.css',
  'styles/components.css',
]);

const PINTA = /^(?:color|fill|stroke|background|background-color|border|border-color|border-(?:top|right|bottom|left)(?:-color)?|--[\w-]+)$/;

export function coloresCrudos(hojas: Hoja[]): string[] {
  const fallos: string[] = [];
  for (const { hoja, css } of hojas) {
    if (PALETA.includes(hoja)) continue;
    const limpio = sinComentarios(css);
    if (/@media[^{]*prefers-color-scheme:\s*dark/.test(limpio)) {
      fallos.push(`${hoja} bifurca el tema por su cuenta: un tema de tres estados no lee su bloque oscuro`);
    }
    for (const declaracion of limpio.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]+)/g)) {
      if (!PINTA.test(declaracion[1])) continue;
      if (/hsla?\(/.test(declaracion[2])) {
        fallos.push(`${hoja} · ${declaracion[1]}: ${declaracion[2].trim()} — hsl() es una paleta propia`);
        continue;
      }
      if (CON_COLOR_PROPIO.has(hoja)) continue;
      for (const hex of declaracion[2].matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        if (SIN_TOKEN.has(hex[0].toLowerCase())) continue;
        fallos.push(`${hoja} · ${declaracion[1]}: ${hex[0]} — un cambio de token no llega hasta acá`);
      }
    }
  }
  return fallos;
}

describe('la hoja de cada vista no revierte los tokens legibles del tema global', () => {
  it('un contador vacío de la flota atenúa sólo su muestra decorativa, no el texto del botón', () => {
    expect(cuerpos(live, ".live-tally-chip[data-empty='true']")).toEqual([
      expect.stringMatching(/opacity:\s*1\s*;/),
    ]);
    expect(cuerpos(live, ".live-tally-chip[data-empty='true'] .live-tally-swatch")).toEqual([
      expect.stringMatching(/opacity:\s*\.45\s*;/),
    ]);
  });

  it('los hallazgos usan el token secundario, sin repetirlo por tema', () => {
    expect(cuerpos(licencias, '.finding-section p')).toEqual([
      expect.stringMatching(/color:\s*var\(--muted\)\s*;/),
    ]);
    expect(cuerpos(licencias, '.finding-reason')).toEqual([
      expect.stringMatching(/color:\s*var\(--muted\)\s*;/),
    ]);
  });

  it('las píldoras de reintento y muerte heredan el color sobre tinte de cada tema', () => {
    expect(cuerpos(mensajes, '.messenger-pill[data-kind="retry"]'))
      .toEqual([expect.stringMatching(/color:\s*var\(--on-amber\)\s*;/)]);
    expect(cuerpos(mensajes, '.messenger-pill[data-kind="dead"]'))
      .toEqual([expect.stringMatching(/color:\s*var\(--on-red\)\s*;/)]);
  });
});

describe('ninguna hoja se pinta su propia paleta', () => {
  it('ninguna escribe un `hsl()` ni bifurca el tema con un bloque oscuro', () => {
    expect(coloresCrudos(hojasDeLaConsola())).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca la paleta que /accounts tenía: hsl() más su bloque oscuro', () => {
    const anterior: Hoja[] = [{
      hoja: 'features/accounts/licenses.css',
      css: '.banner-error { color: hsl(0 70% 30%); }\n'
        + '@media (prefers-color-scheme: dark) { .banner-error { color: hsl(0 70% 70%); } }',
    }];
    expect(coloresCrudos(anterior)).toHaveLength(3);
    expect(coloresCrudos(anterior)).toContainEqual(expect.stringContaining('bifurca el tema por su cuenta'));
    expect(coloresCrudos(anterior)).toContainEqual(expect.stringContaining('hsl() es una paleta propia'));
  });

  it('CONTROL NEGATIVO — un hex nuevo se marca; los dos bordes sin token, no', () => {
    const nuevo: Hoja[] = [{ hoja: 'features/accounts/licenses.css', css: '.x { background: #0c1422; }' }];
    expect(coloresCrudos(nuevo)).toHaveLength(1);
    const exento: Hoja[] = [{ hoja: 'features/accounts/licenses.css', css: '.x { border-color: #74313c; }' }];
    expect(coloresCrudos(exento)).toEqual([]);
  });

  it('la lista de hojas con color propio sólo puede encoger, y /accounts ya no está', () => {
    expect(CON_COLOR_PROPIO.has('features/accounts/licenses.css')).toBe(false);
    for (const hoja of CON_COLOR_PROPIO) {
      expect(hojasDeLaConsola().map((h) => h.hoja), `${hoja} ya no existe: bórrala de la lista`).toContain(hoja);
    }
  });
});

describe('la portada no se pinta una paleta propia por debajo de la tira de arneses', () => {
  it('las tiras nuevas toman su color de un token, no de un hex escrito a mano', () => {
    for (const [selector, propiedad] of [
      ['.landing-tira-nota', 'color'],
      ['.landing-cifras dt', 'color'],
      ['.landing-cifras dd', 'color'],
      ['.landing-tabla thead th', 'color'],
      ['.landing-tabla tbody td', 'color'],
      ['.landing-lista-rotulo', 'color'],
      ['.landing-lista-rotulo small', 'color'],
      ['.landing-lista-cifra', 'color'],
      ['.landing-barra i', 'background'],
    ] as const) {
      const cuerpo = cuerpos(portada, selector);
      expect(cuerpo, `${selector} ya no existe en la hoja`).toHaveLength(1);
      expect(cuerpo[0], `${selector} no toma su ${propiedad} de un token`)
        .toMatch(new RegExp(`${propiedad}:\\s*var\\(--`));
    }
  });

  it('la severidad tiñe la barra con los tokens de tono que ya existen', () => {
    expect(cuerpos(portada, '.landing-lista li[data-severidad="warn"] .landing-barra i'))
      .toEqual([expect.stringMatching(/background:\s*var\(--amber\)\s*;/)]);
    expect(cuerpos(portada, '.landing-lista li[data-severidad="unknown"] .landing-barra i'))
      .toEqual([expect.stringMatching(/background:\s*var\(--border-strong\)\s*;/)]);
  });

  it('la hoja no suma ni un color crudo nuevo: quedan los seis que ya tenía', () => {
    const hexes = [...new Set([...portada.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((hex) => hex[0].toLowerCase()))];
    expect(hexes.sort()).toEqual(HEX_DE_LA_PORTADA);
  });

  it('el tema claro elegido a mano recibe la misma regla que el tema claro del sistema', () => {
    const delSistema = cuerpos(bloquesDeModoClaro(portada), ':root:not([data-theme="dark"]) .adapter-meta');
    const aMano = cuerpos(portada, ':root[data-theme="light"] .adapter-meta');
    expect(delSistema).toHaveLength(1);
    expect(aMano).toEqual(delSistema);
  });

  it('CONTROL NEGATIVO — un hex nuevo en una tira rompe la lista, y un tema claro a medias se nota', () => {
    const conHexNuevo = `${portada}\n.landing-barra i { background: #123456; }`;
    const hexes = new Set([...conHexNuevo.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((hex) => hex[0].toLowerCase()));
    expect([...hexes].sort()).not.toEqual(HEX_DE_LA_PORTADA);
    const sinGemelo = portada.replace(':root[data-theme="light"] .adapter-meta', ':root[data-theme="dark"] .adapter-meta');
    expect(cuerpos(sinGemelo, ':root[data-theme="light"] .adapter-meta')).toEqual([]);
  });
});

describe('elegir un tema gana siempre a la preferencia del sistema', () => {
  it('ninguna regla de un bloque por preferencia se salta la guarda del atributo contrario', () => {
    expect(bloquesDeTemaSinGuarda(hojasDeLaConsola())).toEqual([]);
  });

  it('CONTROL NEGATIVO — el bloque claro sin guarda es exactamente el fallo que dejaba blanco el tema oscuro', () => {
    const sinGuarda: Hoja[] = [{
      hoja: 'styles/responsive.css',
      css: '@media (prefers-color-scheme: light) { .sidebar { background: #f9fbfd; } input { background: #fbfcfe; } }',
    }];
    expect(bloquesDeTemaSinGuarda(sinGuarda)).toHaveLength(2);
    expect(bloquesDeTemaSinGuarda(sinGuarda)[0]).toContain(':root:not([data-theme="dark"])');
    const conGuarda: Hoja[] = [{
      hoja: 'styles/responsive.css',
      css: '@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) .sidebar { background: #f9fbfd; } }',
    }];
    expect(bloquesDeTemaSinGuarda(conGuarda)).toEqual([]);
  });

  it('CONTROL NEGATIVO — el bloque oscuro pide la guarda espejo, no la misma', () => {
    const espejo: Hoja[] = [{
      hoja: 'styles/base.css',
      css: '@media (prefers-color-scheme: dark) { :root:not([data-theme="dark"]) { --bg: #070b13; } }',
    }];
    expect(bloquesDeTemaSinGuarda(espejo)).toHaveLength(1);
    expect(bloquesDeTemaSinGuarda(espejo)[0]).toContain(':root:not([data-theme="light"])');
  });
});

describe('el espejo de la TUI conserva su suelo oscuro en los tres estados del tema', () => {
  it('ni el bloque claro ni su gemelo por atributo tocan el marco ni la barra de estado', () => {
    expect(reglasClarasSobre(terminal, '.pty-shell')).toEqual([]);
    expect(reglasClarasSobre(terminal, '.pty-status')).toEqual([]);
  });

  it('la regla con ámbito de página sigue declarando el par oscuro que la TUI necesita', () => {
    expect(cuerpos(terminal, '.ultimate-terminal-page .pty-shell')[0]).toMatch(/background:\s*#0a0e16\s*;/);
    expect(cuerpos(terminal, '.ultimate-terminal-page .pty-status')[0]).toMatch(/background:\s*#10192a\s*;/);
    expect(cuerpos(terminal, '.ultimate-terminal-page .pty-status')[0]).toMatch(/color:\s*#9fb2cc\s*;/);
  });

  it('CONTROL NEGATIVO — los dos gemelos borrados, de vuelta, se marcan uno por uno', () => {
    const conGemelo = `${terminal}\n:root[data-theme="light"] .pty-shell { background: #ffffff; }`;
    expect(reglasClarasSobre(conGemelo, '.pty-shell')).toEqual([':root[data-theme="light"] .pty-shell']);
    const conMedia = terminal.replace(
      '@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"]) .pty-negativa',
      '@media (prefers-color-scheme: light) {\n  .pty-status { background: #f8fafc; }\n  :root:not([data-theme="dark"]) .pty-negativa',
    );
    expect(reglasClarasSobre(conMedia, '.pty-status')).toEqual(['.pty-status']);
  });
});
