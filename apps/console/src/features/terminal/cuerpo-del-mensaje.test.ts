import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARACTERES_DE_PREVISUALIZACION, previsualizacionRecortada, textoDelCuerpo } from './cuerpo-del-mensaje';

describe('el recorte del cuerpo que hace el servidor', () => {
  /**
   * LA COMPROBACIÓN CRUZADA CONTRA EL SQL.**
   *
   * El 240 no es una elección de la consola: es el `left(...,240)` de la consulta de
   * `CauceRepository.listMessages`. Son dos números en dos repositorios de código distintos y nada
   * los ata. Si alguien sube el recorte del servidor a 500 y no toca esta constante, la consola
   * empieza a rotular como «recortado» un mensaje entero de 240 y a presentar como entero uno
   * cortado a 500 — y no falla el typecheck, ni el lint, ni una sola prueba de DOM. Esta es la
   * comprobación barata que sí lo atrapa.
   */
  it('el número que la consola dice es el que el servidor aplica', () => {
    const consulta = readFileSync(resolve(process.cwd(), '../../packages/store/src/repository.ts'), 'utf8');
    const recorte = /left\(COALESCE\(m\.body->>'text',m\.body->>'prompt',m\.body::text\),(\d+)\)/.exec(consulta);
    expect(recorte, 'no se encontró el recorte de listMessages en packages/store/src/repository.ts').not.toBeNull();
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
   * Una forma desconocida NO se esconde. Devolver `undefined` acá pintaría «el servidor devolvió
   * el mensaje sin cuerpo» sobre una fila que SÍ tiene cuerpo: sería el mismo defecto que se está
   * arreglando, en versión nueva.
   */
  it('una forma desconocida se muestra tal cual en vez de desaparecer', () => {
    expect(textoDelCuerpo({ attachments: [1, 2] })).toContain('attachments');
  });

  it('sin cuerpo devuelve indefinido, y eso la vista lo dice con esas palabras', () => {
    expect(textoDelCuerpo(null)).toBeUndefined();
    expect(textoDelCuerpo(undefined)).toBeUndefined();
  });
});
