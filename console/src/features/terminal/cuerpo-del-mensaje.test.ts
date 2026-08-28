import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARACTERES_DE_PREVISUALIZACION, previsualizacionRecortada, textoDelCuerpo } from './cuerpo-del-mensaje';

describe('el recorte del cuerpo que hace el servidor', () => {
  /**
   * THE CROSS-CHECK AGAINST THE SQL.**
   *
   * The 240 is not a console choice: it is the `left(...,240)` of the `CauceRepository.listMessages`
   * query. They are two numbers in two different code repositories and nothing binds them.
   * If someone raises the server truncation to 500 and does not touch this constant, the
   * console starts labelling a full 240-char message as "truncated" and presenting a 500-truncated
   * one as full — and the typecheck does not fail, nor the lint, nor a single DOM test. This
   * is the cheap check that does catch it.
   */
  it('el número que la consola dice es el que el servidor aplica', () => {
    let consulta: string;
    try {
      consulta = readFileSync(resolve(process.cwd(), '../packages/store/src/repository/messages.ts'), 'utf8');
    } catch {
      consulta = readFileSync(resolve(process.cwd(), '../packages/store/src/repository.ts'), 'utf8');
    }
    const recorte = /left\(COALESCE\(m\.body->>'text',m\.body->>'prompt',m\.body::text\),(\d+)\)/.exec(consulta);
    expect(recorte, 'no se encontró el recorte de listMessages en packages/store/src/repository').not.toBeNull();
    expect(Number(recorte?.[1])).toBe(CARACTERES_DE_PREVISUALIZACION);
  });

  it('un cuerpo corto NO se rotula como recortado', () => {
    expect(previsualizacionRecortada('todo bien')).toBe(false);
    expect(previsualizacionRecortada('')).toBe(false);
    expect(previsualizacionRecortada(null)).toBe(false);
    expect(previsualizacionRecortada(undefined)).toBe(false);
    expect(previsualizacionRecortada('x'.repeat(CARACTERES_DE_PREVISUALIZACION - 1))).toBe(false);
  });

  it('un cuerpo del largo exacto del tope se rotula, porque el error caro es el otro', () => {
    expect(previsualizacionRecortada('x'.repeat(CARACTERES_DE_PREVISUALIZACION))).toBe(true);
  });
});

describe('de dónde sale el texto del cuerpo entero', () => {
  it('lee las dos formas que publica la flota', () => {
    expect(textoDelCuerpo({ text: 'hola' })).toBe('hola');
    expect(textoDelCuerpo({ prompt: 'tomá el encargo' })).toBe('tomá el encargo');
    expect(textoDelCuerpo('ya es texto')).toBe('ya es texto');
  });

  /**
   * An unknown shape does NOT hide. Returning `undefined` here would paint "the server returned
   * the message without a body" over a row that DOES have a body: it would be the same bug
   * being fixed, in a new version.
   */
  it('una forma desconocida se muestra tal cual en vez de desaparecer', () => {
    expect(textoDelCuerpo({ attachments: [1, 2] })).toContain('attachments');
  });

  it('sin cuerpo devuelve indefinido, y eso la vista lo dice con esas palabras', () => {
    expect(textoDelCuerpo(null)).toBeUndefined();
    expect(textoDelCuerpo(undefined)).toBeUndefined();
  });
});
