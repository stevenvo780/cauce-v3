import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  markdownToPlainText,
  markdownToTelegramHtml
} from '../../services/telegram-bridge/src/markdown.js';

/**
 * Cobertura pura de `services/telegram-bridge/src/markdown.ts`.
 *
 * El contrato de Telegram es HTML restringido: bold (`<b>`), italic (`<i>`),
 * strikethrough (`<s>`), code (`<code>`), pre (`<pre>`), blockquote, links
 * (`<a href>`). Cualquier tag desconocido rompe el render. El módulo:
 *   * Convierte sintaxis markdown al subset Telegram.
 *   * Escapa `<`, `>`, `&` en TODO lo que no es markup propio (incluido el
 *     contenido de los code blocks, que es donde más inyecciones se ven).
 *   * Descarta enlaces no-http(s) para impedir `javascript:`.
 *   * Tiene un fallback (`markdownToPlainText`) por si Telegram rechaza el HTML.
 */

describe('escapeHtml: la primitiva mínima anti-inyección', () => {
  it('escapa & primero para no romper las entidades que introducen los demás reemplazos', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
  });

  it('no escapa " ni \'\u2014, no son peligrosos para el subset de Telegram', () => {
    expect(escapeHtml('"hola"')).toBe('"hola"');
    expect(escapeHtml("don't")).toBe("don't");
  });

  it('escapa caracteres típicos de inyección HTML/CSS', () => {
    expect(escapeHtml('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('<img src=x onerror=alert(1)>'))
      .toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('preserva emojis, multibyte y saltos de línea tal cual', () => {
    expect(escapeHtml('中文 😀\nlínea')).toBe('中文 😀\nlínea');
    expect(escapeHtml('')).toBe('');
  });
});

describe('markdownToTelegramHtml: convierte markdown al subset HTML de Telegram', () => {
  it('convierte encabezados en negrita porque Telegram no tiene headings', () => {
    expect(markdownToTelegramHtml('## Trazado')).toBe('<b>Trazado</b>');
    expect(markdownToTelegramHtml('# Causa raíz\ntexto')).toBe('<b>Causa raíz</b>\ntexto');
  });

  it('convierte **negrita**, __negrita__, *itálica* y ~~tachado~~', () => {
    expect(markdownToTelegramHtml('**importante**')).toBe('<b>importante</b>');
    expect(markdownToTelegramHtml('__fuerte__')).toBe('<b>fuerte</b>');
    expect(markdownToTelegramHtml('*sutil*')).toBe('<i>sutil</i>');
    expect(markdownToTelegramHtml('~~descartado~~')).toBe('<s>descartado</s>');
  });

  it('la negrita (**) tiene prioridad sobre la itálica (*)', () => {
    // **a*b** no matchea el regex de bold (que excluye * adentro), así que se preserva literal.
    expect(markdownToTelegramHtml('**a*b**')).toBe('**a*b**');
    // Pero **foo** limpio sí se vuelve bold.
    expect(markdownToTelegramHtml('**foo**')).toBe('<b>foo</b>');
  });

  it('convierte código en línea y bloques cercados, escapando el contenido', () => {
    expect(markdownToTelegramHtml('usá `grep -c foo`')).toBe('usá <code>grep -c foo</code>');
    expect(markdownToTelegramHtml('```sql\nSELECT 1;\n```')).toBe('<pre>SELECT 1;</pre>');
    // El contenido del code block se escapa (es donde más aparece HTML del usuario).
    const out = markdownToTelegramHtml('```\nif (a < b && c) return "<x>";\n```');
    expect(out).toBe('<pre>if (a &lt; b &amp;&amp; c) return "&lt;x&gt;";</pre>');
  });

  it('convierte enlaces http(s) y descarta javascript: / file: / data:', () => {
    expect(markdownToTelegramHtml('[panel](https://consola.elenxos.com/activity)'))
      .toBe('<a href="https://consola.elenxos.com/activity">panel</a>');
    const malo = markdownToTelegramHtml('[malo](javascript:alert(1))');
    expect(malo).toContain('javascript:alert(1)');
    expect(malo).not.toContain('<a ');
  });

  it('alinea una tabla markdown como bloque monoespaciado sin pipes', () => {
    const tabla = '| alias | estado |\n|---|---|\n| janus | activo |\n| kant | activo |';
    const out = markdownToTelegramHtml(tabla);
    expect(out).toContain('<pre>');
    expect(out).toContain('alias  estado');
    expect(out).toContain('janus  activo');
    expect(out).not.toContain('|');
  });

  it('rellena con espacios las celdas faltantes en filas de largo desigual', () => {
    // La última fila tiene una sola columna; convertirTabla rellena con '' las celdas
    // que faltan y luego alinea por padEnd (la fila final se trimea al final de línea).
    const tabla = '| alias | estado | tipo |\n|---|---|---|\n| kant | activo | bot |\n| argos |';
    const out = markdownToTelegramHtml(tabla);
    expect(out).toContain('<pre>');
    expect(out).toContain('alias  estado  tipo');
    expect(out).toContain('kant   activo  bot');
    // La última fila solo trae la primera celda — el resto se rellena en blanco y se trimea.
    expect(out).toContain('argos</pre>');
  });

  it('preserva el bloque como literal cuando la tabla no tiene contenido suficiente', () => {
    // Solo header + separador (0 filas de contenido) → convertirTabla devuelve undefined
    // y el bloque original se devuelve intacto.
    const rota = '| a |\n|---|';
    expect(markdownToTelegramHtml(rota)).toBe('| a |\n|---|');
  });

  it('no deja que el usuario inyecte etiquetas propias ni rompa el HTML', () => {
    const out = markdownToTelegramHtml('<b>no soy negrita</b> <script>alert(1)</script>');
    expect(out).not.toContain('<b>no soy');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('convierte bullets, reglas horizontales y blockquotes', () => {
    expect(markdownToTelegramHtml('- uno\n  - anidado')).toBe('• uno\n  • anidado');
    expect(markdownToTelegramHtml('---')).toBe('');
    expect(markdownToTelegramHtml('> una cita')).toBe('<blockquote>una cita</blockquote>');
  });

  it('colapsa tres o más saltos de línea en exactamente dos', () => {
    expect(markdownToTelegramHtml('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('hace trim del resultado final para no dejar líneas vacías en el chat', () => {
    expect(markdownToTelegramHtml('  texto  ')).toBe('texto');
    expect(markdownToTelegramHtml('\n\nhola\n\n')).toBe('hola');
  });

  it('input vacío produce string vacío', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });
});

describe('markdownToPlainText: el fallback que Telegram siempre acepta', () => {
  it('elimina los marcadores de bloque (headings, **, ~~); el * suelto se preserva porque no hay regla de itálica', () => {
    const src = '## Trazado\n**importante** ~~descartado~~ *sutil*';
    expect(markdownToPlainText(src)).toBe('Trazado\nimportante descartado *sutil*');
  });

  it('reemplaza el code block cercado por su contenido literal', () => {
    expect(markdownToPlainText('```sql\nSELECT 1;\n```')).toBe('SELECT 1;');
  });

  it('conserva el código en línea pero sin los backticks', () => {
    expect(markdownToPlainText('usá `grep -c foo`')).toBe('usá grep -c foo');
  });

  it('convierte un enlace en "texto: url" para no perder el destino', () => {
    expect(markdownToPlainText('[panel](https://consola.elenxos.com/activity)'))
      .toBe('panel: https://consola.elenxos.com/activity');
  });

  it('convierte bullets a "•" y descarta reglas horizontales y headings', () => {
    expect(markdownToPlainText('- uno\n---\n## dos')).toBe('• uno\n\ndos');
  });

  it('colapsa tres o más saltos de línea en dos y hace trim', () => {
    expect(markdownToPlainText('a\n\n\n\nb\n\n')).toBe('a\n\nb');
  });

  it('input vacío produce string vacío', () => {
    expect(markdownToPlainText('')).toBe('');
  });
});