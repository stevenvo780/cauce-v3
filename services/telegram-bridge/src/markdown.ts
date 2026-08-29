/**
 * Markdown to Telegram-compatible HTML subset conversion.
 */

const ESCAPES: readonly (readonly [RegExp, string])[] = [
  [/&/gu, '&amp;'],
  [/</gu, '&lt;'],
  [/>/gu, '&gt;']
];

export function escapeHtml(value: string): string {
  return ESCAPES.reduce((texto, [patron, reemplazo]) => texto.replace(patron, reemplazo), value);
}

/** Internal marker to protect an already-converted stretch from later passes. */
const RESERVADO = '\u0000';

function protegido(piezas: string[], html: string): string {
  piezas.push(html);
  return `${RESERVADO}${String(piezas.length - 1)}${RESERVADO}`;
}

function restaurar(texto: string, piezas: string[]): string {
  return texto.replace(
    new RegExp(`${RESERVADO}(\\d+)${RESERVADO}`, 'gu'),
    (_, indice: string) => piezas[Number(indice)] ?? ''
  );
}

/**
 * A markdown table on a phone is unreadable: the pipes do not line up with anything. It is
 * converted to monospaced rows with aligned columns, which is the closest Telegram can get to
 * the original intent.
 */
function convertirTabla(lineas: string[]): string | undefined {
  const filas = lineas
    .map((linea) => linea.trim())
    .filter((linea) => linea.startsWith('|'))
    .map((linea) => linea.replace(/^\||\|$/gu, '').split('|').map((celda) => celda.trim()));
  // The second row of a markdown table is the separator (---|---) and carries no content.
  const contenido = filas.filter((fila) => !fila.every((celda) => /^:?-{2,}:?$/u.test(celda)));
  if (contenido.length < 2) return undefined;

  const columnas = Math.max(...contenido.map((fila) => fila.length));
  const anchos = Array.from({ length: columnas }, (_, indice) =>
    Math.max(...contenido.map((fila) => (fila[indice] ?? '').length)));

  const texto = contenido
    .map((fila) => Array.from({ length: columnas }, (_, indice) =>
      (fila[indice] ?? '').padEnd(anchos[indice] ?? 0)).join('  ').trimEnd())
    .join('\n');
  return `<pre>${escapeHtml(texto)}</pre>`;
}

export function markdownToTelegramHtml(source: string): string {
  const piezas: string[] = [];
  // NULs are an internal separator: if the text already carried one, it is discarded.
  let texto = source.split(RESERVADO).join('');

  // 1. Fenced code blocks. They go first: nothing else is interpreted inside them.
  texto = texto.replace(/```[A-Za-z0-9_+-]*\r?\n([\s\S]*?)```/gu, (_, cuerpo: string) =>
    protegido(piezas, `<pre>${escapeHtml(cuerpo.replace(/\n$/u, ''))}</pre>`));

  // 2. Full tables, before touching the loose lines.
  texto = texto.replace(/(?:^\|.*\|[ \t]*\r?\n?){2,}/gmu, (bloque: string) => {
    const html = convertirTabla(bloque.split(/\r?\n/u));
    return html === undefined ? bloque : protegido(piezas, html);
  });

  // 3. Inline code.
  texto = texto.replace(/`([^`\n]+)`/gu, (_, cuerpo: string) =>
    protegido(piezas, `<code>${escapeHtml(cuerpo)}</code>`));

  // 4. Links [text](url). http/https only: a `javascript:` has no business here.
  texto = texto.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu, (entero, etiqueta: string, url: string) =>
    protegido(piezas, `<a href="${escapeHtml(url)}">${escapeHtml(etiqueta)}</a>`) || entero);

  // 5. What is left is user text: it is escaped BEFORE injecting any of our own tags.
  texto = escapeHtml(texto);

  // 6. Headings → bold. Telegram does not have headings.
  texto = texto.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gmu, (_, titulo: string) => `<b>${titulo}</b>`);

  // 7. Horizontal rules: they do not exist; a blank line communicates the same thing.
  texto = texto.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gmu, '');

  // 8. Bullets and numbered lists. Indentation is kept so the hierarchy reads correctly.
  texto = texto.replace(/^([ \t]*)[-*+][ \t]+/gmu, (_, sangria: string) => `${sangria}• `);

  // 9. Emphasis. Bold goes before italic so `**` is not parsed as two `*`.
  texto = texto.replace(/\*\*([^\n*]+)\*\*/gu, '<b>$1</b>');
  texto = texto.replace(/__([^\n_]+)__/gu, '<b>$1</b>');
  texto = texto.replace(/(^|[\s(])\*([^\n*]+)\*/gu, '$1<i>$2</i>');
  texto = texto.replace(/~~([^\n~]+)~~/gu, '<s>$1</s>');

  // 10. Quotes.
  texto = texto.replace(/^[ \t]{0,3}&gt;[ \t]?(.*)$/gmu, '<blockquote>$1</blockquote>');

  // 11. Three blank lines in a row add nothing on a phone screen.
  texto = texto.replace(/\n{3,}/gu, '\n\n');

  return restaurar(texto, piezas).trim();
}

/**
 * Strips the markup and leaves readable plain text.
 *
 * It is the safety net below: if Telegram rejects the HTML, the message is resent with this
 * and arrives the same, with no tags and without the markdown symbols that motivated it all.
 */
export function markdownToPlainText(source: string): string {
  return source
    .replace(/```[A-Za-z0-9_+-]*\r?\n([\s\S]*?)```/gu, (_, cuerpo: string) => cuerpo.replace(/\n$/u, ''))
    .replace(/`([^`\n]+)`/gu, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu, '$1: $2')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gmu, '$1')
    .replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gmu, '')
    .replace(/^([ \t]*)[-*+][ \t]+/gmu, (_, sangria: string) => `${sangria}• `)
    .replace(/\*\*([^\n*]+)\*\*/gu, '$1')
    .replace(/__([^\n_]+)__/gu, '$1')
    .replace(/~~([^\n~]+)~~/gu, '$1')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
