import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';
import { sinComentarios } from '../../test/css-parser';

/**
 * No class of this view may point at a rule that does not exist.
 *
 * The check is the cheap one and the one that would have caught the bug: every class the
 * `features/messages` folder writes must be defined in one of the two sheets the view loads
 * (`styles.css`, global, and `messages.css`, own).
 */
/**
 * Resolved from `process.cwd()` (the root of the `@cauce/console` package, both with `pnpm test`
 * and with `pnpm --filter`) and NOT from `import.meta.url`: under vitest that URL is the vite
 * server's (`/src/features/messages`), not a path on disk.
 */
const DIRECTORIO = resolve(process.cwd(), 'src/features/messages');
const HOJAS = [
  join(DIRECTORIO, 'messages.css'),
  join(DIRECTORIO, '..', '..', 'styles.css'),
  join(DIRECTORIO, '..', 'terminal', 'terminal-panel.css'),
];

/** Classes painted by a SHARED component (components/ui, TerminalTranscript) and not by this view. */
const AJENAS = new Set(['sr-only', 'mono', 'eyebrow', 'button', 'small', 'secondary', 'primary', 'unknown']);

function clasesDefinidas(): Set<string> {
  const definidas = new Set<string>();
  for (const hoja of HOJAS) {
    let css: string;
    try {
      css = leerCss(hoja);
    } catch {
      continue;
    }
    // Comment blocks are ignored so a name quoted in an explanation — like the removed
    // `.metadata-grid`, mentioned precisely because it no longer exists — does not count.
    const limpio = sinComentarios(css);
    for (const coincidencia of limpio.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      definidas.add(coincidencia[1]);
    }
  }
  return definidas;
}

/**
 * `className="..."` literal, or the FIXED part of a template (`className={\`messenger-avatar
 * ${...}\`}`). Built with `new RegExp` because backticks inside a regular expression literal
 * break rollup's parser.
 */
const PATRON_CLASSNAME = new RegExp('className=(?:"([^"]*)"|\\{`([^`$]*))', 'g');

function clasesUsadas(): Map<string, string> {
  const usadas = new Map<string, string>();
  for (const fichero of readdirSync(DIRECTORIO)) {
    if (!fichero.endsWith('.tsx') || fichero.includes('.test.')) continue;
    const fuente = readFileSync(join(DIRECTORIO, fichero), 'utf8');
    // Only literal `className` values. Composed ones via template keep their fixed part at the
    // front (`messenger-avatar ${...}`) and that part IS checked.
    for (const coincidencia of fuente.matchAll(PATRON_CLASSNAME)) {
      for (const clase of (coincidencia.at(1) ?? coincidencia.at(2) ?? '').split(/\s+/)) {
        if (clase && !AJENAS.has(clase)) usadas.set(clase, fichero);
      }
    }
  }
  return usadas;
}

describe('las clases de la vista de mensajes', () => {
  it('están todas definidas en alguna hoja que la vista carga', () => {
    const definidas = clasesDefinidas();
    const huerfanas = [...clasesUsadas()]
      .filter(([clase]) => !definidas.has(clase))
      .map(([clase, fichero]) => `${clase} (${fichero})`);
    expect(huerfanas).toEqual([]);
  });

  /**
   * NEGATIVE CONTROL of the guard itself. A checker that approves everything is worse than
   * not having one: here it is fed the exact class that was retired and is required to flag it.
   */
  it('marcaría una clase retirada como la `metadata-grid` que rompió el detalle', () => {
    expect(clasesDefinidas().has('metadata-grid')).toBe(false);
    expect(clasesDefinidas().has('messenger-message-meta')).toBe(true);
  });
});
