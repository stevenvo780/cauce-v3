import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseRichText } from './rich-text';
import { RichText } from './RichText';

describe('parseRichText', () => {
  it('reconoce párrafos, listas, encabezados y bloques de código', () => {
    expect(parseRichText('## Estado\nTodo bien.\nSegunda línea.\n\n- uno\n- dos\n\n1. a\n2) b\n\n```bash\nls -la\n```')).toEqual([
      { kind: 'heading', text: 'Estado' },
      { kind: 'paragraph', text: 'Todo bien.\nSegunda línea.' },
      { kind: 'list', ordered: false, items: ['uno', 'dos'] },
      { kind: 'list', ordered: true, items: ['a', 'b'] },
      { kind: 'code', text: 'ls -la', lang: 'bash' },
    ]);
  });

  it('una lista pegada a un párrafo no se mezcla con él', () => {
    expect(parseRichText('Resumen:\n- uno\n  sigue\nFin')).toEqual([
      { kind: 'paragraph', text: 'Resumen:' },
      { kind: 'list', ordered: false, items: ['uno\nsigue'] },
      { kind: 'paragraph', text: 'Fin' },
    ]);
  });

  it('una vista previa recortada dentro de un bloque de código lo conserva como código', () => {
    expect(parseRichText('Mirá:\n```\nconst a = 1;\nconst b')).toEqual([
      { kind: 'paragraph', text: 'Mirá:' },
      { kind: 'code', text: 'const a = 1;\nconst b' },
    ]);
  });

  it('un texto vacío no produce bloques', () => {
    expect(parseRichText('  \n\n ')).toEqual([]);
  });
});

describe('RichText', () => {
  it('nunca interpreta HTML y pinta código en línea y negritas como texto', () => {
    const { container } = render(<RichText text={'<img src=x onerror=alert(1)> usá `npm ci` y **listo**'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('npm ci').tagName).toBe('CODE');
    expect(screen.getByText('listo').tagName).toBe('STRONG');
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)> usá npm ci y listo');
  });

  it('el código en bloque se desplaza en horizontal en vez de romper la columna', () => {
    const { container } = render(<RichText text={'```\n' + 'x'.repeat(400) + '\n```'} />);
    expect(container.querySelector('pre')).toHaveClass('overflow-x-auto');
  });
});
