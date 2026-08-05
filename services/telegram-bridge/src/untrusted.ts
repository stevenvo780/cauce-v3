/**
 * Saneo de TODO lo que escribe un tercero, y la identidad del humano que habla.
 *
 * Hasta ahora el puente le pasaba al agente el `conversation_id` y nada más: en un DM el agente
 * sabía el número del chat y no sabía con QUIÉN estaba hablando. El dato ya entraba —Telegram
 * manda `message.from` con `username` y `first_name` en cada update— y se descartaba acá.
 *
 * ------------------------------------------------------------------------------------------
 * POR QUÉ ESTE ARCHIVO EXISTE Y NO ES UN `body.display_name = message.from.first_name`
 *
 * El nombre visible lo elige el ATACANTE. Cualquiera se pone «zeus» de nombre en Telegram en diez
 * segundos, le escribe a un bot de la flota y, si ese string entra crudo al prompt, el agente lee
 * una identidad que nadie verificó. Dos defensas, y ninguna alcanza sola:
 *
 *  1. NUNCA va a `origin.metadata`, que el harness imprime como TRUSTED ORIGIN CONTEXT. Va al
 *     bloque UNTRUSTED del prompt, el mismo que ya usa el puente para los grupos.
 *  2. `.toLowerCase()` y NFKC NO alcanzan para detectar la suplantación. «zeuѕ» escrito con la
 *     ЅЕ cirílica U+0455 no es igual a «zeus» en ninguna comparación de bytes, ni antes ni después
 *     de NFKC: son code points distintos con el mismo dibujo. Por eso `confusableSkeleton`.
 *
 * ------------------------------------------------------------------------------------------
 * EL ESQUELETO (UTS#39 §4, "confusable detection"), Y EN QUÉ SE APARTA DEL ESTÁNDAR
 *
 *   NFKD → minúsculas → borrar marcas y formato → tabla de confundibles → NFD → borrar marcas
 *
 *  - NFKD en vez de NFD (el estándar usa NFD) porque la descomposición de COMPATIBILIDAD ya
 *    resuelve gratis tres familias enteras de homóglifos que si no habría que tabular a mano:
 *    ancho completo (ｚｅｕｓ), alfanuméricos matemáticos (𝐳𝐞𝐮𝐬, 𝓏𝑒𝓊𝓈, 𝕫𝕖𝕦𝕤) y ligaduras (ﬁ→fi).
 *  - Se BORRAN las marcas combinantes: «zéus» y «zeus» tienen que dar el mismo esqueleto, si no
 *    un acento suelto evade la detección sin cambiar el dibujo de manera apreciable.
 *  - Se plegan mayúsculas ANTES de la tabla: así la tabla sólo necesita las formas minúsculas
 *    (la Ѕ U+0405 del ejemplo pasa por `toLowerCase()` a ѕ U+0455, que sí está tabulada).
 *
 * LO QUE ESTE ESQUELETO NO HACE, dicho explícitamente para que nadie lo suponga: no cubre
 * leetspeak (`zeu5`, `m1das`). Mapear dígitos a letras es la clase de heurística que dispara
 * falsos positivos sobre nombres reales, y acá el falso positivo es una advertencia inútil pegada
 * al nombre de un humano legítimo en cada mensaje que manda. El esqueleto cubre ESCRITURAS
 * confundibles, que es el vector que no se ve.
 *
 * ------------------------------------------------------------------------------------------
 * LA TABLA
 *
 * Subconjunto acotado y auditable de `confusables.txt` de Unicode (UTS#39, revisión 15.1),
 * transcrito a mano: latino ← cirílico, griego, versalitas del IPA, numerales romanos y las
 * letras latinas de fonética. NO se usa el paquete npm `unicode-confusables`: su tabla quedó en
 * Unicode 8 y trae la dependencia entera para resolver un mapeo de cien entradas.
 *
 * Cada fila es [prototipo latino, code points que colapsan en él] con los escapes `\uXXXX`
 * escritos a mano —nunca el glifo literal— para que el archivo se pueda leer, diffear y copiar
 * sin depender de bytes invisibles, igual que `INVISIBLE_CHARACTERS` acá abajo.
 * ------------------------------------------------------------------------------------------
 */

import type { TelegramUser } from './types.js';

// Detectar caracteres de control ES el objetivo: este regex sanea texto libre controlado por
// terceros (nombres, usernames, extractos de reply) antes de que llegue al prompt del harness.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]+', 'gu');

/**
 * Invisible code points: zero width (U+200B-U+200D, U+FEFF), bidirectional overrides and
 * isolates (U+061C, U+200E/F, U+202A-E, U+2066-9), and the interlinear annotation controls.
 *
 * They survive `CONTROL_CHARACTERS` (which only covers C0/C1) and are exactly what lets a hostile
 * display name render as one string while carrying another — including a right-to-left override
 * that visually reverses a forged delimiter. Removed outright rather than replaced by a space, so
 * they cannot pad a name to look like separate words.
 *
 * P8: el rango U+2060-U+206F va COMPLETO. Antes salteaba el U+2065, que está sin asignar y por eso
 * no lo saca ni `\p{Cf}` ni ningún otro filtro — lo encontró la prueba estructural que compara este
 * criterio contra el de `attachments.ts`, no una muestra elegida a mano. Un code point invisible que
 * sobrevive parte el nombre en dos: «zeu·s» no es «zeus» para el esqueleto, se dibuja igual, y la
 * suplantación pasa sin advertencia. Es el hueco exacto que este módulo existe para tapar.
 */
// Written as explicit \u escapes (not literal glyphs) so the pattern survives copy/paste and
// diffing without depending on invisible bytes in the source file itself.
const INVISIBLE_CHARACTERS =
  new RegExp('[\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]', 'gu');

/**
 * Marcas combinantes y formato. Se borran para el esqueleto (no para el nombre que se muestra):
 * `\p{M}` cubre tildes, diacríticos y el punto que `toLowerCase()` le agrega a la İ turca;
 * `\p{Cf}` es la red de seguridad por si a alguien le llega acá un texto que no pasó por
 * `safeInline` (el bidi y los de ancho cero ya los sacó `INVISIBLE_CHARACTERS`).
 */
const SKELETON_NOISE = /[\p{M}\p{Cf}]/gu;

/** Separador de palabras para comparar por token: todo lo que no sea letra ni dígito. */
const SKELETON_SEPARATORS = /[^\p{L}\p{N}]+/gu;

/** [prototipo latino, confundibles que colapsan en él]. Ver el comentario de cabecera. */
const CONFUSABLE_TABLE: ReadonlyArray<readonly [string, string]> = [
  // CYRILLIC A / GREEK ALPHA / LATIN ALPHA / SMALL CAPITAL A
  ['a', '\u0430\u03b1\u0251\u1d00'],
  // CYRILLIC VE / CYRILLIC SOFT SIGN / GREEK BETA / SMALL CAPITAL B
  ['b', '\u0432\u044c\u03b2\u0299'],
  // CYRILLIC ES / GREEK LUNATE SIGMA / SMALL CAPITAL C / ROMAN NUMERAL 100
  ['c', '\u0441\u03f2\u1d04\u217d'],
  // CYRILLIC KOMI DE / SMALL CAPITAL D / ROMAN NUMERAL 500
  ['d', '\u0501\u1d05\u217e'],
  // CYRILLIC IE / CYRILLIC UKRAINIAN IE / GREEK EPSILON / SMALL CAPITAL E / ESTIMATED SIGN
  ['e', '\u0435\u0454\u03b5\u1d07\u212e'],
  // GREEK DIGAMMA
  ['f', '\u03dd'],
  // LATIN SCRIPT G / ARMENIAN CO
  ['g', '\u0261\u0581'],
  // CYRILLIC SHHA / ARMENIAN HO / SMALL CAPITAL H
  ['h', '\u04bb\u0570\u029c'],
  // CYRILLIC I / CYRILLIC YI / GREEK IOTA / LATIN DOTLESS I / SMALL CAPITAL I / ROMAN NUMERAL 1
  ['i', '\u0456\u0457\u03b9\u0131\u026a\u2170'],
  // CYRILLIC JE / GREEK YOT / LATIN DOTLESS J
  ['j', '\u0458\u03f3\u0237'],
  // CYRILLIC KA / GREEK KAPPA / SMALL CAPITAL K
  ['k', '\u043a\u03ba\u1d0b'],
  // CYRILLIC PALOCHKA / ROMAN NUMERAL 50 / SMALL CAPITAL L
  ['l', '\u04cf\u217c\u029f'],
  // CYRILLIC EM / ROMAN NUMERAL 1000 / SMALL CAPITAL M
  ['m', '\u043c\u217f\u1d0d'],
  // CYRILLIC PE / GREEK ETA / SMALL CAPITAL N
  ['n', '\u043f\u03b7\u0274'],
  // CYRILLIC O / GREEK OMICRON / GREEK SIGMA / ARMENIAN OH / SMALL CAPITAL O
  ['o', '\u043e\u03bf\u03c3\u0585\u1d0f'],
  // CYRILLIC ER / GREEK RHO / GREEK RHO SYMBOL / SMALL CAPITAL P
  ['p', '\u0440\u03c1\u03f1\u1d18'],
  // CYRILLIC QA
  ['q', '\u051b'],
  // CYRILLIC GHE / SMALL CAPITAL R
  ['r', '\u0433\u0280'],
  // CYRILLIC DZE  <- la S del informe: la mayuscula U+0405 pliega aca
  ['s', '\u0455'],
  // CYRILLIC TE / GREEK TAU / SMALL CAPITAL T
  ['t', '\u0442\u03c4\u1d1b'],
  // GREEK UPSILON / GREEK MU (la MICRO SIGN U+00B5 descompone en ella) / SMALL CAPITAL U
  ['u', '\u03c5\u03bc\u1d1c'],
  // GREEK NU / CYRILLIC IZHITSA / SMALL CAPITAL V / ROMAN NUMERAL 5
  ['v', '\u03bd\u0475\u1d20\u2174'],
  // CYRILLIC WE / GREEK OMEGA / SMALL CAPITAL W
  ['w', '\u051d\u03c9\u1d21'],
  // CYRILLIC HA / GREEK CHI / ROMAN NUMERAL 10
  ['x', '\u0445\u03c7\u2179'],
  // CYRILLIC U / CYRILLIC STRAIGHT U / GREEK GAMMA / SMALL CAPITAL Y
  ['y', '\u0443\u04af\u03b3\u028f'],
  // GREEK ZETA (la mayuscula U+0396 pliega aca) / SMALL CAPITAL Z
  ['z', '\u03b6\u1d22'],
  // LATIN SHARP S: toLowerCase() la deja igual; el case-folding real la abre en "ss"
  ['ss', '\u00df']
];

const CONFUSABLES: ReadonlyMap<string, string> = new Map(
  CONFUSABLE_TABLE.flatMap(([prototype, sources]) => [...sources].map((source) => [source, prototype] as const))
);

/**
 * Nombre mínimo que se compara contra un alias.
 *
 * Con menos de tres caracteres la coincidencia deja de significar algo: cualquier apodo corto
 * chocaría con cualquier cosa y la advertencia perdería todo su valor por saturación.
 */
const MIN_RESERVED_NAME_LENGTH = 3;

/** Techos de longitud. Un nombre no es un mensaje: recortar es parte de la defensa. */
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_USERNAME_LENGTH = 32;

export function safeText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const characters = [...value.split('\u0000').join('')];
  if (characters.length === 0) return undefined;
  return characters.slice(0, limit).join('');
}

/**
 * Sanitiser for attacker-controlled free text (display names, usernames, reply excerpts).
 *
 * Beyond `safeText`'s NUL stripping it removes every C0/C1 control character, every invisible
 * formatting code point, and collapses whitespace, so a hostile value cannot forge the
 * line-oriented delimiters the harness prompt is built from. It does NOT neutralise instructions:
 * the value is delivered inside an explicitly untrusted, clearly delimited block, and never
 * reaches `origin.metadata`, which the harness renders as TRUSTED ORIGIN CONTEXT.
 */
export function safeInline(value: unknown, limit: number): string | undefined {
  const cleaned = safeText(value, limit * 4);
  if (cleaned === undefined) return undefined;
  const collapsed = cleaned
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (collapsed.length === 0) return undefined;
  return [...collapsed].slice(0, limit).join('');
}

/**
 * Esqueleto de confundibles: dos strings que se DIBUJAN igual tienen que dar el mismo esqueleto.
 *
 * Sólo se usa para comparar contra los nombres reservados de la flota y para mostrarle al agente
 * contra qué se comparó. Nunca reemplaza al nombre que escribió el humano: el nombre que se
 * muestra es el suyo, saneado, no su esqueleto.
 */
export function confusableSkeleton(value: string): string {
  const folded = value.normalize('NFKD').toLowerCase().replace(SKELETON_NOISE, '');
  let mapped = '';
  for (const character of folded) mapped += CONFUSABLES.get(character) ?? character;
  return mapped.normalize('NFD').replace(SKELETON_NOISE, '');
}

/**
 * ¿Este nombre se dibuja como el de alguien de la flota?
 *
 * Compara el esqueleto completo y también cada palabra suelta, porque «Ζeus (soporte)» es el
 * mismo intento que «Ζeus». NO compara por subcadena a propósito: «kanta» no es un intento de
 * hacerse pasar por `kant`, y una advertencia que salta con nombres normales se vuelve ruido y
 * deja de leerse, que es exactamente cómo se pierde la advertencia que sí importaba.
 */
export function reservedNameHit(value: string, reserved: Iterable<string>): string | undefined {
  const skeleton = confusableSkeleton(value);
  if (skeleton.length === 0) return undefined;
  const tokens = new Set(skeleton.split(SKELETON_SEPARATORS).filter((token) => token.length > 0));
  if (tokens.size === 0) return undefined;
  for (const name of reserved) {
    const target = confusableSkeleton(name);
    if (target.length < MIN_RESERVED_NAME_LENGTH) continue;
    if (skeleton === target || tokens.has(target)) return name;
  }
  return undefined;
}

/** Sospecha de suplantación: qué nombre imita, por qué campo, y con qué esqueleto se detectó. */
export interface ImpersonationSuspicion {
  readonly collides_with: string;
  readonly field: 'display_name' | 'username';
  readonly normalized: string;
}

export interface UntrustedAuthor {
  /** Ausente cuando Telegram no mandó ni nombre ni username utilizable. */
  readonly author: Record<string, unknown> | undefined;
  readonly impersonation: ImpersonationSuspicion | undefined;
}

/**
 * Identidad NO VERIFICADA del humano que escribió el mensaje, lista para el bloque untrusted.
 *
 * `display_name` es texto libre que eligió el remitente; `username` es el @ de Telegram, que
 * Telegram sí obliga a ser único y ASCII pero que igual puede llamarse `zeus_oficial`. Los dos se
 * comparan contra los nombres reservados de la flota: el vector de suplantación es hacerse pasar
 * por otro agente o por el dueño de la instalación.
 */
export function untrustedAuthor(
  from: TelegramUser | undefined,
  reserved: Iterable<string>
): UntrustedAuthor {
  const username = safeInline(from?.username, MAX_USERNAME_LENGTH);
  const displayName = safeInline(from?.first_name, MAX_DISPLAY_NAME_LENGTH);
  const author = {
    ...(username === undefined ? {} : { username }),
    ...(displayName === undefined ? {} : { display_name: displayName })
  };
  if (Object.keys(author).length === 0) return { author: undefined, impersonation: undefined };
  // El nombre visible primero: es el que se ve en el chat y el que no cuesta nada falsificar.
  const byDisplayName = displayName === undefined ? undefined : reservedNameHit(displayName, reserved);
  const byUsername = username === undefined ? undefined : reservedNameHit(username, reserved);
  const impersonation: ImpersonationSuspicion | undefined =
    byDisplayName !== undefined && displayName !== undefined
      ? { collides_with: byDisplayName, field: 'display_name', normalized: confusableSkeleton(displayName) }
      : byUsername !== undefined && username !== undefined
        ? { collides_with: byUsername, field: 'username', normalized: confusableSkeleton(username) }
        : undefined;
  return { author, impersonation };
}
