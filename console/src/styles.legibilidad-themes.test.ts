import { describe, expect, it } from 'vitest';
import { leerCss } from './test/leer-css';
import {
  bloqueMedia,
  declaraciones,
  sinComentarios,
  valor,
} from './test/css-parser';

const GLOBAL = leerCss('styles.css');

interface Rgb { r: number; g: number; b: number; a: number }

function leerColor(texto: string): Rgb | undefined {
  const t = texto.trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(t);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(t);
  if (rgb) {
    const partes = rgb[1].split(/[\s,/]+/).filter(Boolean);
    const n = (v: string) => (v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : Number(v));
    const [r, g, b] = partes.slice(0, 3).map(Number);
    const a = partes.length > 3 ? n(partes[3]) : 1;
    if ([r, g, b, a].some(Number.isNaN)) return undefined;
    return { r, g, b, a };
  }
  return undefined;
}

function sobre(capa: Rgb, fondo: Rgb): Rgb {
  return {
    r: capa.r * capa.a + fondo.r * (1 - capa.a),
    g: capa.g * capa.a + fondo.g * (1 - capa.a),
    b: capa.b * capa.a + fondo.b * (1 - capa.a),
    a: 1,
  };
}

function luminancia({ r, g, b }: Rgb): number {
  const canal = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

export function contraste(frente: Rgb, fondo: Rgb): number {
  const a = luminancia(frente.a < 1 ? sobre(frente, fondo) : frente);
  const b = luminancia(fondo);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function tokensDe(bloque: string): Record<string, string> {
  const tabla: Record<string, string> = {};
  for (const [, nombre, contenido] of bloque.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tabla[nombre] = contenido.trim();
  }
  return tabla;
}

function resolver(expresion: string, tabla: Record<string, string>, saltos = 0): Rgb | undefined {
  if (saltos > 8) return undefined;
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(expresion.trim());
  if (ref) {
    const key = ref[1];
    const destino = (key in tabla ? tabla[key] : undefined) ?? ref[2];
    return destino ? resolver(destino, tabla, saltos + 1) : undefined;
  }
  return leerColor(expresion);
}

function soloNivelSuperior(css: string): string {
  const limpio = sinComentarios(css);
  let salida = '';
  let profundidad = 0;
  let cabecera = '';
  let cursor = 0;
  while (cursor < limpio.length) {
    const caracter = limpio[cursor];
    if (caracter === '{') {
      if (profundidad === 0 && cabecera.trim().startsWith('@')) {
        let p = 1;
        let fin = cursor + 1;
        while (fin < limpio.length && p > 0) {
          if (limpio[fin] === '{') p += 1;
          else if (limpio[fin] === '}') p -= 1;
          fin += 1;
        }
        cabecera = '';
        cursor = fin;
        continue;
      }
      salida += cabecera + caracter;
      cabecera = '';
      profundidad += 1;
    } else if (caracter === '}') {
      profundidad -= 1;
      salida += caracter;
    } else if (profundidad > 0) salida += caracter;
    else cabecera += caracter;
    cursor += 1;
  }
  return salida;
}

interface Tema { nombre: string; tokens: Record<string, string>; tintes: Rgb[] }

function temas(css: string): [Tema, Tema] {
  const superior = soloNivelSuperior(css);
  const raizOscura = tokensDe(declaraciones(superior, ':root'));
  const bloqueClaro = bloqueMedia(css, '@media (prefers-color-scheme: light)');
  const raizClara = { ...raizOscura, ...tokensDe(declaraciones(bloqueClaro, ':root')) };
  return [
    { nombre: 'oscuro', tokens: raizOscura, tintes: tintesDelFondo(declaraciones(superior, 'body'), raizOscura) },
    { nombre: 'claro', tokens: raizClara, tintes: tintesDelFondo(declaraciones(bloqueClaro, 'body'), raizClara) },
  ];
}

function tintesDelFondo(cuerpoBody: string, tabla: Record<string, string>): Rgb[] {
  const fondo = valor(cuerpoBody, 'background');
  const base = resolver('var(--bg)', tabla);
  if (!base) return [];
  const capas = fondo
    ? [...fondo.matchAll(/rgba?\([^)]*\)/g)]
      .map((m) => leerColor(m[0]))
      .filter((c): c is Rgb => c !== undefined && c.a > 0 && c.a < 1)
    : [];
  return [base, ...capas.map((capa) => sobre(capa, base))];
}

const TINTE = '@tinte';
const AA_TEXTO_NORMAL = 4.5;

interface Pareja { texto: string; fondos: string[]; minimo?: number; soloTema?: 'claro' | 'oscuro'; porque: string }

const PAREJAS: Pareja[] = [
  {
    texto: '--text', fondos: ['--bg', '--surface', '--surface-2', TINTE],
    porque: 'el texto de la página',
  },
  {
    texto: '--muted', fondos: ['--bg', '--surface', '--surface-2', '--amber-dim', TINTE],
    porque: 'descripciones de panel, pies de tarjeta, pestañas INACTIVAS de `.view-tabs`',
  },
  {
    texto: '--faint', fondos: ['--bg', '--surface', '--surface-2', '--surface-3', TINTE],
    porque: 'cabeceras de tabla, sublíneas, `dt`, el color de MÁS elementos de toda la consola',
  },
  {
    texto: '--text-2', fondos: ['--bg', '--surface', '--surface-2', '--surface-3', TINTE],
    porque: 'celdas de tabla, `dd`, rótulos de formulario y el BOTÓN SECUNDARIO (defecto 1)',
  },
  {
    texto: '--on-mint', fondos: ['--mint-dim'],
    porque: 'las insignias ONLINE / ENABLED / FRESCO',
  },
  { texto: '--on-blue', fondos: ['--blue-dim'], porque: 'insignias EN COLA / TRABAJANDO / SERVER' },
  { texto: '--on-amber', fondos: ['--amber-dim'], porque: 'insignias de aviso y el cartel MOCK API' },
  { texto: '--on-red', fondos: ['--red-dim'], porque: 'insignias COLGADO / ACK vencido / DISABLED' },
  {
    texto: '--mint', fondos: ['--bg', '--surface', TINTE],
    porque: 'el `.eyebrow` de cada página y el nombre de la sesión en la barra superior',
  },
  { texto: '--blue', fondos: ['--bg', '--surface', TINTE], porque: 'enlaces y el icono de estado de entrega' },
  { texto: '--amber', fondos: ['--bg', '--surface', '--amber-dim', TINTE], porque: 'avisos y valores UNKNOWN' },
  { texto: '--red', fondos: ['--bg', '--surface', TINTE], porque: 'errores y `.error-copy`' },
  { texto: '--violet', fondos: ['--bg', TINTE], porque: 'la delegación en el hipergrafo de /live' },
  { texto: '--lime', fondos: ['--bg', TINTE], porque: 'la respuesta cerrada en el hipergrafo de /live' },
  { texto: '--muted', fondos: ['#15352f', '#102035'], soloTema: 'oscuro', porque: 'la fila del agente seleccionado en /terminal' },
  { texto: '--muted', fondos: ['#dff3ed', '#eaf3fb'], soloTema: 'claro', porque: 'la fila del agente seleccionado en /terminal' },
];

function fondosDe(nombre: string, tema: Tema): Rgb[] {
  if (nombre === TINTE) return tema.tintes;
  if (nombre.startsWith('#')) {
    const literal = leerColor(nombre);
    return literal ? [literal] : [];
  }
  const color = resolver(`var(${nombre})`, tema.tokens);
  return color ? [color] : [];
}

export function parejasBajoAA(css: string): string[] {
  const fallos: string[] = [];
  for (const tema of temas(css)) {
    for (const pareja of PAREJAS) {
      if (pareja.soloTema && pareja.soloTema !== tema.nombre) continue;
      const texto = resolver(`var(${pareja.texto})`, tema.tokens);
      if (!texto) {
        fallos.push(`[${tema.nombre}] ${pareja.texto} no está declarado o no resuelve a un color`);
        continue;
      }
      for (const nombreFondo of pareja.fondos) {
        const fondos = fondosDe(nombreFondo, tema);
        if (!fondos.length) {
          fallos.push(`[${tema.nombre}] el fondo ${nombreFondo} no resuelve a un color`);
          continue;
        }
        const ratio = Math.min(...fondos.map((fondo) => contraste(texto, fondo)));
        const minimo = pareja.minimo ?? AA_TEXTO_NORMAL;
        if (ratio + 0.005 < minimo) {
          fallos.push(
            `[${tema.nombre}] ${pareja.texto} sobre ${nombreFondo} = ${ratio.toFixed(2)}:1, `
            + `hace falta ${String(minimo)} — ${pareja.porque}`,
          );
        }
      }
    }
  }
  return fallos;
}

describe('contraste de los tokens de color (WCAG 2.1 AA)', () => {
  it('ninguna pareja (texto, fondo) que la consola usa de verdad baja de 4,5:1, en los DOS temas', () => {
    expect(parejasBajoAA(GLOBAL)).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca el `--faint` de antes, que dejaba las cabeceras de tabla a 3,66:1', () => {
    const roto = GLOBAL.replace(
      /(@media \(prefers-color-scheme: light\)[\s\S]*?)--faint: #[0-9a-f]{6};/,
      '$1--faint: #718198;',
    );
    expect(roto).not.toBe(GLOBAL);
    expect(parejasBajoAA(roto)).toContainEqual(expect.stringContaining('[claro] --faint sobre'));
  });

  it('CONTROL NEGATIVO — marca la insignia ONLINE de antes: verde claro sobre verde claro, 1,15:1', () => {
    const roto = GLOBAL.replace(/(@media \(prefers-color-scheme: light\)[\s\S]*?)--on-mint: #[0-9a-f]{6};/, '$1--on-mint: #8ff0d3;');
    expect(roto).not.toBe(GLOBAL);
    expect(parejasBajoAA(roto)).toContainEqual(expect.stringContaining('[claro] --on-mint sobre --mint-dim'));
  });

  it('CONTROL NEGATIVO — marca que se borre un token entero en vez de arreglarlo', () => {
    const roto = GLOBAL.replace(/\s*--text-2: #[0-9a-f]{6};/g, '');
    expect(roto).not.toBe(GLOBAL);
    expect(parejasBajoAA(roto)).toContainEqual(expect.stringContaining('--text-2 no está declarado'));
  });

  it('la fila del agente seleccionado sube el énfasis de su texto secundario', () => {
    const limpio = sinComentarios(GLOBAL);
    expect(valor(declaraciones(limpio, '.terminal-agent[data-active="true"]'), '--faint')).toBe('var(--muted)');
  });

  it('el degradado decorativo del body ENTRA en la cuenta: es un fondo real de la página', () => {
    const [oscuro, claro] = temas(GLOBAL);
    for (const tema of [oscuro, claro]) {
      const base = resolver('var(--bg)', tema.tokens);
      expect(base).toBeDefined();
      if (base) {
        expect(tema.tintes.length).toBeGreaterThan(1);
        expect(tema.tintes.slice(1).some((t) => Math.abs(luminancia(t) - luminancia(base)) > 0.005)).toBe(true);
      }
    }
  });
});
