import { describe, expect, it } from 'vitest';
import { markdownToPlainText, markdownToTelegramHtml } from '../src/markdown.js';

describe('markdown a HTML de Telegram', () => {
  it('convierte encabezados en negrita, porque Telegram no tiene encabezados', () => {
    expect(markdownToTelegramHtml('## Trazado del 13272')).toBe('<b>Trazado del 13272</b>');
    expect(markdownToTelegramHtml('# Causa raíz\ntexto')).toBe('<b>Causa raíz</b>\ntexto');
  });

  it('convierte negritas, itálicas y tachado', () => {
    expect(markdownToTelegramHtml('esto es **importante**')).toBe('esto es <b>importante</b>');
    expect(markdownToTelegramHtml('esto es *sutil*')).toBe('esto es <i>sutil</i>');
    expect(markdownToTelegramHtml('~~descartado~~')).toBe('<s>descartado</s>');
  });

  it('convierte código en línea y bloques cercados', () => {
    expect(markdownToTelegramHtml('usá `grep -c foo`')).toBe('usá <code>grep -c foo</code>');
    expect(markdownToTelegramHtml('```sql\nSELECT 1;\n```')).toBe('<pre>SELECT 1;</pre>');
  });

  it('convierte viñetas en puntos legibles y conserva la jerarquía', () => {
    expect(markdownToTelegramHtml('- uno\n  - anidado')).toBe('• uno\n  • anidado');
  });

  it('alinea una tabla en un bloque monoespaciado', () => {
    const tabla = '| alias | estado |\n|---|---|\n| janus | activo |\n| kant | activo |';
    const salida = markdownToTelegramHtml(tabla);
    expect(salida).toContain('<pre>');
    expect(salida).toContain('alias  estado');
    expect(salida).toContain('janus  activo');
    expect(salida).not.toContain('|');
  });

  it('convierte enlaces y descarta los que no son http', () => {
    expect(markdownToTelegramHtml('[el panel](https://consola.elenxos.com/activity)'))
      .toBe('<a href="https://consola.elenxos.com/activity">el panel</a>');
    expect(markdownToTelegramHtml('[malo](javascript:alert(1))')).toContain('javascript');
    expect(markdownToTelegramHtml('[malo](javascript:alert(1))')).not.toContain('<a ');
  });

  /* --- What makes Telegram NOT reject the message --- */

  it('escapa los caracteres que romperían el HTML', () => {
    expect(markdownToTelegramHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
  });

  it('escapa el contenido de un bloque de código, que es donde más aparecen', () => {
    const salida = markdownToTelegramHtml('```\nif (a < b && c) return "<x>";\n```');
    expect(salida).toBe('<pre>if (a &lt; b &amp;&amp; c) return "&lt;x&gt;";</pre>');
  });

  it('no deja que el usuario inyecte etiquetas propias', () => {
    const salida = markdownToTelegramHtml('<b>no soy negrita</b> <script>alert(1)</script>');
    expect(salida).not.toContain('<b>no soy');
    expect(salida).not.toContain('<script>');
    expect(salida).toContain('&lt;script&gt;');
  });

  it('produce etiquetas balanceadas en un informe real completo', () => {
    const informe = [
      '## Trazado del 13272',
      '',
      '```',
      '22:06:27.537Z  graf-backend-dev   POST /orders/validate   201',
      '```',
      '',
      '**El corte es la escritura a la base**, no el transporte.',
      '',
      '| capa | resultado |',
      '|---|---|',
      '| Graf | 201 |',
      '| Deméter | 500 |',
      '',
      '- Verificado en `lib/graf/map.ts:242`',
      '- Sin duplicados: 0 filas'
    ].join('\n');
    const salida = markdownToTelegramHtml(informe);
    for (const etiqueta of ['b', 'pre']) {
      const abre = (salida.match(new RegExp(`<${etiqueta}>`, 'gu')) ?? []).length;
      const cierra = (salida.match(new RegExp(`</${etiqueta}>`, 'gu')) ?? []).length;
      expect(abre, `<${etiqueta}> balanceado`).toBe(cierra);
    }
    expect(salida).not.toContain('##');
    expect(salida).not.toContain('**');
    expect(salida).not.toContain('```');
  });

  it('deja el texto plano intacto', () => {
    expect(markdownToTelegramHtml('hola, todo listo')).toBe('hola, todo listo');
  });
});

describe('degradado a texto plano', () => {
  it('quita el marcado sin perder contenido', () => {
    const salida = markdownToPlainText('## Título\n\n**negrita** y `código`\n\n- uno');
    expect(salida).toBe('Título\n\nnegrita y código\n\n• uno');
  });

  it('conserva el contenido de los bloques de código y expande los enlaces', () => {
    expect(markdownToPlainText('```\nSELECT 1;\n```')).toBe('SELECT 1;');
    expect(markdownToPlainText('[panel](https://x.com/a)')).toBe('panel: https://x.com/a');
  });

  it('no deja etiquetas HTML: es la red para cuando Telegram rechaza el formato', () => {
    expect(markdownToPlainText('**a** `b`')).not.toMatch(/[<>]/u);
  });
});
