/**
 * Conversión de Markdown a subconjunto HTML compatible con Telegram.
 */

const ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/gu, '&amp;'],
  [/</gu, '&lt;'],
  [/>/gu, '&gt;']
];

export function escapeHtml(value: string): string {
  return ESCAPES.reduce((texto, [patron, reemplazo]) => texto.replace(patron, reemplazo), value);
}

/** Marcador interno para proteger un tramo ya convertido de las pasadas siguientes. */
const RESERVADO = '\u0000';

function protegido(piezas: string[], html: string): string {
  piezas.push(html);
  return `${RESERVADO}${piezas.length - 1}${RESERVADO}`;
}

function restaurar(texto: string, piezas: string[]): string {
  return texto.replace(
    new RegExp(`${RESERVADO}(\\d+)${RESERVADO}`, 'gu'),
    (_, indice: string) => piezas[Number(indice)] ?? ''
  );
}

/**
 * Una tabla de markdown en un teléfono es ilegible: las barras no se alinean con nada. Se
 * convierte a filas monoespaciadas con las columnas alineadas, que es lo más parecido a la
 * intención original que Telegram puede mostrar.
 */
function convertirTabla(lineas: string[]): string | undefined {
  const filas = lineas
    .map((linea) => linea.trim())
    .filter((linea) => linea.startsWith('|'))
    .map((linea) => linea.replace(/^\||\|$/gu, '').split('|').map((celda) => celda.trim()));
  // La segunda fila de una tabla markdown es el separador (---|---) y no lleva contenido.
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
  // Los nulos son separador interno: si el texto ya traía uno, se descarta.
  let texto = source.split(RESERVADO).join('');

  // 1. Bloques de código cercados. Van primero: adentro no se interpreta nada más.
  texto = texto.replace(/```[A-Za-z0-9_+-]*\r?\n([\s\S]*?)```/gu, (_, cuerpo: string) =>
    protegido(piezas, `<pre>${escapeHtml(String(cuerpo).replace(/\n$/u, ''))}</pre>`));

  // 2. Tablas completas, antes de tocar las líneas sueltas.
  texto = texto.replace(/(?:^\|.*\|[ \t]*\r?\n?){2,}/gmu, (bloque: string) => {
    const html = convertirTabla(bloque.split(/\r?\n/u));
    return html === undefined ? bloque : protegido(piezas, html);
  });

  // 3. Código en línea.
  texto = texto.replace(/`([^`\n]+)`/gu, (_, cuerpo: string) =>
    protegido(piezas, `<code>${escapeHtml(cuerpo)}</code>`));

  // 4. Enlaces [texto](url). Sólo http/https: un `javascript:` no tiene nada que hacer acá.
  texto = texto.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu, (entero, etiqueta: string, url: string) =>
    protegido(piezas, `<a href="${escapeHtml(url)}">${escapeHtml(etiqueta)}</a>`) || entero);

  // 5. Lo que queda es texto del usuario: se escapa ANTES de inyectar ninguna etiqueta nuestra.
  texto = escapeHtml(texto);

  // 6. Encabezados → negrita. Telegram no tiene encabezados.
  texto = texto.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gmu, (_, titulo: string) => `<b>${titulo}</b>`);

  // 7. Reglas horizontales: no existen; una línea en blanco comunica lo mismo.
  texto = texto.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gmu, '');

  // 8. Viñetas y numeradas. La sangría se conserva para que se lea la jerarquía.
  texto = texto.replace(/^([ \t]*)[-*+][ \t]+/gmu, (_, sangria: string) => `${sangria}• `);

  // 9. Énfasis. El negrita va antes que la itálica para que `**` no se lea como dos `*`.
  texto = texto.replace(/\*\*([^\n*]+)\*\*/gu, '<b>$1</b>');
  texto = texto.replace(/__([^\n_]+)__/gu, '<b>$1</b>');
  texto = texto.replace(/(^|[\s(])\*([^\n*]+)\*/gu, '$1<i>$2</i>');
  texto = texto.replace(/~~([^\n~]+)~~/gu, '<s>$1</s>');

  // 10. Citas.
  texto = texto.replace(/^[ \t]{0,3}&gt;[ \t]?(.*)$/gmu, '<blockquote>$1</blockquote>');

  // 11. Tres líneas en blanco seguidas no aportan nada en una pantalla de teléfono.
  texto = texto.replace(/\n{3,}/gu, '\n\n');

  return restaurar(texto, piezas).trim();
}

/**
 * Quita el marcado y deja texto plano legible.
 *
 * Es la red de abajo: si Telegram rechaza el HTML, el mensaje se reenvía con esto y llega igual,
 * sin etiquetas y sin los símbolos del markdown que motivaron todo el ejercicio.
 */
export function markdownToPlainText(source: string): string {
  return source
    .replace(/```[A-Za-z0-9_+-]*\r?\n([\s\S]*?)```/gu, (_, cuerpo: string) => String(cuerpo).replace(/\n$/u, ''))
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
