import { describe, expect, it } from 'vitest';
import {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
  confusableSkeleton,
  reservedNameHit,
  safeInline,
  safeText,
  untrustedAuthor
} from '../../services/telegram-bridge/src/untrusted.js';
import type { TelegramUser } from '../../services/telegram-bridge/src/types.js';

/**
 * Cobertura pura de `services/telegram-bridge/src/untrusted.ts`.
 *
 * Lo que se defiende acá es la frontera entre contenido controlado por terceros
 * y el prompt del harness:
 *   * `safeText` trunca y rechaza lo que no es string.
 *   * `safeInline` además borra controles C0/C1, invisibles, y colapsa whitespace.
 *   * `confusableSkeleton` mapea homóglifos cirílicos/griegos/fullwidth/matemáticos
 *     al prototipo latino — la pieza central del detector de impersonation.
 *   * `reservedNameHit` compara contra nombres reservados de la flota.
 *   * `untrustedAuthor` une todo y etiqueta la sospecha de impersonation.
 *
 * Todos los homóglifos se escriben como escapes `\uXXXX` (no como glifo literal):
 * pegar el carácter invisible adentro del test es exactamente el ataque que
 * estamos probando.
 */

const RESERVED = ['zeus', 'kant', 'argos', 'jarvis', 'Steven'];

describe('safeText: ventana para texto libre controlado por terceros', () => {
  it('devuelve undefined para cualquier entrada que no es string', () => {
    expect(safeText(undefined, 10)).toBeUndefined();
    expect(safeText(null, 10)).toBeUndefined();
    expect(safeText(42, 10)).toBeUndefined();
    expect(safeText({}, 10)).toBeUndefined();
    expect(safeText([], 10)).toBeUndefined();
  });

  it('descarta NULs y trunca al límite pedido en code points (no en bytes)', () => {
    expect(safeText('a\u0000b\u0000c', 10)).toBe('abc');
    expect(safeText('', 10)).toBeUndefined();
    expect(safeText('\u0000\u0000\u0000', 10)).toBeUndefined();
  });

  it('trunca en límite y respeta caracteres multibyte como un único code point', () => {
    const input = '中文中'.repeat(10); // 30 code points en JS, 3 bytes cada uno en UTF-8
    const out = safeText(input, 5);
    const esperado = Array.from(input).slice(0, 5).join('');
    expect(out).toBe(esperado);
    expect(Array.from(out ?? '').length).toBe(5);
  });

  it('respeta exactamente el límite pedido', () => {
    expect(safeText('abcdef', 3)).toBe('abc');
    expect(safeText('abc', 3)).toBe('abc');
  });
});

describe('safeInline: limpieza profunda para bloques UNTRUSTED del prompt', () => {
  it('devuelve undefined para entradas no-string o vacías tras la limpieza', () => {
    expect(safeInline(undefined, 10)).toBeUndefined();
    expect(safeInline(null, 10)).toBeUndefined();
    expect(safeInline('', 10)).toBeUndefined();
    expect(safeInline('   ', 10)).toBeUndefined();
    expect(safeInline('\u0000\u0000\u0000', 10)).toBeUndefined();
  });

  it('reemplaza controles C0/C1 por un espacio (no por vacío, para no fusionar palabras)', () => {
    expect(safeInline('hola\u0001mundo', 64)).toBe('hola mundo');
    expect(safeInline('uno\u0007\u000btwo', 64)).toBe('uno two');
    // \t cuenta como whitespace pero se colapsa junto al resto.
    expect(safeInline('a\tb', 64)).toBe('a b');
  });

  it('borra invisibles (zero-width, bidi, BOM) en vez de reemplazarlos por espacio', () => {
    // ZERO WIDTH SPACE (U+200B) y RIGHT-TO-LEFT OVERRIDE (U+202E).
    expect(safeInline('ze\u200bus', 64)).toBe('zeus');
    expect(safeInline('ze\u202eus', 64)).toBe('zeus');
    // BOM (U+FEFF).
    expect(safeInline('\ufeffkant', 64)).toBe('kant');
  });

  it('colapsa whitespace repetido en un único espacio y hace trim', () => {
    expect(safeInline('   a   b   c   ', 64)).toBe('a b c');
    expect(safeInline('línea1\nlínea2\n\nlínea3', 64)).toBe('línea1 línea2 línea3');
  });

  it('respeta el límite pedido en code points, no en bytes, tras la limpieza', () => {
    const cleaned = safeInline('a'.repeat(1000), 32);
    expect(cleaned?.length).toBe(32);
    const multibyte = safeInline('😀'.repeat(50), 10);
    expect(Array.from(multibyte ?? '').length).toBe(10);
  });

  it('preserva acentos, eñes y alfabetos no latinos', () => {
    expect(safeInline('Sebastián Núñez', 64)).toBe('Sebastián Núñez');
    expect(safeInline('你好世界', 64)).toBe('你好世界');
    expect(safeInline('Привет', 64)).toBe('Привет');
  });
});

describe('confusableSkeleton: lo que se DIBUJA igual cae al mismo esqueleto', () => {
  it('pliega el cirílico homóglifo al latino', () => {
    // CYRILLIC SMALL LETTER DZE (U+0455) en lugar de la "s".
    expect(confusableSkeleton('zeu\u0455')).toBe('zeus');
    // CYRILLIC CAPITAL DZE (U+0405) — primero cae a minúscula y después mapea.
    expect(confusableSkeleton('\u0405teven')).toBe('steven');
    // "kant" enteramente cirílico: KA + A + PE + TE.
    expect(confusableSkeleton('\u043a\u0430\u043f\u0442')).toBe('kant');
    // Una sola letra (IE) infiltrada en una palabra latina.
    expect(confusableSkeleton('s\u0435neca')).toBe('seneca');
  });

  it('pliega el griego homóglifo', () => {
    // GREEK CAPITAL LETTER ZETA (U+0396) en lugar de la zeta latina.
    expect(confusableSkeleton('\u0396eus')).toBe('zeus');
    // GREEK SMALL LETTER ALPHA + GREEK SMALL LETTER OMICRON.
    expect(confusableSkeleton('\u03b1rg\u03bfs')).toBe('argos');
  });

  it('pliega mayúsculas, acentos, fullwidth y matemáticos', () => {
    expect(confusableSkeleton('ZEUS')).toBe('zeus');
    expect(confusableSkeleton('z\u00e9us')).toBe('zeus');
    // FULLWIDTH LATIN SMALL Z/E/U/S.
    expect(confusableSkeleton('\uff5a\uff45\uff55\uff53')).toBe('zeus');
    // MATHEMATICAL BOLD SMALL Z/E/U/S en orden Z E U S (1D433, 1D41E, 1D42E, 1D42C).
    expect(confusableSkeleton('\u{1d433}\u{1d41e}\u{1d42e}\u{1d42c}')).toBe('zeus');
  });

  it('ß (eszett) se mapea a "ss", no a "s"', () => {
    expect(confusableSkeleton('weiß')).toBe('weiss');
  });

  it('no inventa letras donde no las hay', () => {
    expect(confusableSkeleton('')).toBe('');
    expect(confusableSkeleton('Ana María')).toBe('ana maria');
    expect(confusableSkeleton('kanta')).toBe('kanta');
  });
});

describe('reservedNameHit: ¿este nombre se hace pasar por alguien de la flota?', () => {
  it('detecta el homóglifo cirílico/ Griego que imita a un alias reservado', () => {
    expect(reservedNameHit('zeu\u0455', RESERVED)).toBe('zeus');
    expect(reservedNameHit('\u0405teven', RESERVED)).toBe('Steven');
    expect(reservedNameHit('\u0396eus', RESERVED)).toBe('zeus');
  });

  it('detecta el alias como palabra suelta dentro de un nombre más largo', () => {
    expect(reservedNameHit('Zeus (soporte)', RESERVED)).toBe('zeus');
    expect(reservedNameHit('el kant de siempre', RESERVED)).toBe('kant');
  });

  it('NO matchea por substring: kanta no es kant, jarvison no es jarvis', () => {
    expect(reservedNameHit('Kanta', RESERVED)).toBeUndefined();
    expect(reservedNameHit('Jarvison', RESERVED)).toBeUndefined();
    expect(reservedNameHit('Ana María', RESERVED)).toBeUndefined();
  });

  it('un esqueleto vacío (o solo separadores) no colisiona con nadie', () => {
    expect(reservedNameHit('', RESERVED)).toBeUndefined();
    expect(reservedNameHit('   ', RESERVED)).toBeUndefined();
    expect(reservedNameHit('\u{1f98a}', RESERVED)).toBeUndefined();
  });

  it('respeta el piso mínimo: nombres cortos en RESERVED no disparan match', () => {
    // RESERVED no incluye "ai" pero aunque lo incluyera, el filtro descarta <3.
    const corto = ['ai', 'bo'];
    expect(reservedNameHit('Ai-chan', corto)).toBeUndefined();
    expect(reservedNameHit('Bo', corto)).toBeUndefined();
  });
});

describe('untrustedAuthor: ensambla autor + sospecha de impersonation', () => {
  function user(overrides: Partial<TelegramUser> = {}): TelegramUser {
    return { id: 1, first_name: 'Steven', username: 'steven_h', ...overrides };
  }

  it('sin from (canal anónimo) devuelve author undefined y sin sospecha', () => {
    const result = untrustedAuthor(undefined, RESERVED);
    expect(result.author).toBeUndefined();
    expect(result.impersonation).toBeUndefined();
  });

  it('construye author con los campos que pasaron safeInline', () => {
    const result = untrustedAuthor(user({ first_name: '  Ana  ', username: 'ana_1' }), RESERVED);
    expect(result.author).toEqual({ username: 'ana_1', display_name: 'Ana' });
    expect(result.impersonation).toBeUndefined();
  });

  it('omite los campos cuyo safeInline devolvió undefined', () => {
    const result = untrustedAuthor({ id: 1, username: '\u0000\u0000', first_name: '' }, RESERVED);
    expect(result.author).toBeUndefined();
  });

  it('etiqueta la sospecha por display_name cuando el homóglifo está en el nombre visible', () => {
    const result = untrustedAuthor(user({ first_name: 'zeu\u0455', username: 'alguien' }), RESERVED);
    expect(result.impersonation?.collides_with).toBe('zeus');
    expect(result.impersonation?.field).toBe('display_name');
    expect(result.impersonation?.normalized).toBe('zeus');
  });

  it('etiqueta por username cuando solo el @ se hace pasar por un alias', () => {
    const result = untrustedAuthor(user({ first_name: 'Ana', username: '\u0396eus_bot' }), RESERVED);
    expect(result.impersonation?.collides_with).toBe('zeus');
    expect(result.impersonation?.field).toBe('username');
  });

  it('respeta los topes de longitud exportados al construir el author', () => {
    const result = untrustedAuthor(user({
      first_name: 'a'.repeat(200),
      username: 'b'.repeat(80)
    }), RESERVED);
    const displayName = result.author?.display_name;
    const username = result.author?.username;
    expect(typeof displayName === 'string' ? displayName.length : -1).toBe(MAX_DISPLAY_NAME_LENGTH);
    expect(typeof username === 'string' ? username.length : -1).toBe(MAX_USERNAME_LENGTH);
    expect(MAX_DISPLAY_NAME_LENGTH).toBe(64);
    expect(MAX_USERNAME_LENGTH).toBe(32);
  });
});