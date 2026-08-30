import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUERPO_BASE,
  CUERPO_MINIMO,
  FUENTE_TERMINAL,
  TEMA_TERMINAL,
  documentoQueNiegaLosEstilos,
  pintarPiel,
} from './pty-theme';
import type { PtyEntry } from './pty-types';

function makeEntry(fontSize?: number): PtyEntry {
  const container = document.createElement('div');
  const terminal = { options: fontSize === undefined ? {} : { fontSize } } as unknown as PtyEntry['terminal'];
  return { container, terminal } as unknown as PtyEntry;
}

describe('pintarPiel', () => {
  it('siete variables CSS con los valores del tema y la fuente monoespaciada', () => {
    const entry = makeEntry(15);

    pintarPiel(entry);

    const estilo = entry.container.style;
    expect(estilo.getPropertyValue('--pty-fuente')).toBe(FUENTE_TERMINAL);
    expect(estilo.getPropertyValue('--pty-cuerpo')).toBe('15px');
    expect(estilo.getPropertyValue('--pty-tinta')).toBe(TEMA_TERMINAL.foreground);
    expect(estilo.getPropertyValue('--pty-fondo')).toBe(TEMA_TERMINAL.background);
    expect(estilo.getPropertyValue('--pty-cursor')).toBe(TEMA_TERMINAL.cursor);
    expect(estilo.getPropertyValue('--pty-cursor-tinta')).toBe(TEMA_TERMINAL.cursorAccent);
    expect(estilo.getPropertyValue('--pty-seleccion')).toBe(TEMA_TERMINAL.selectionBackground);
  });

  it('si el terminal no expone fontSize, cae al CUERPO_BASE y NO escribe "undefinedpx"', () => {
    const entry = makeEntry();

    pintarPiel(entry);

    expect(entry.container.style.getPropertyValue('--pty-cuerpo')).toBe(`${String(CUERPO_BASE)}px`);
    expect(entry.container.style.getPropertyValue('--pty-cuerpo')).not.toBe('undefinedpx');
  });

  it('el cuerpo calculado respeta un tamaño distinto al mínimo y al base', () => {
    const entry = makeEntry(CUERPO_MINIMO + 1);

    pintarPiel(entry);

    expect(entry.container.style.getPropertyValue('--pty-cuerpo')).toBe(`${String(CUERPO_MINIMO + 1)}px`);
  });
});

describe('holder', () => {
  beforeEach(() => {
    vi.resetModules();
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  afterEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  it('crea un div escondido con la clase pty-detached-holder y lo agrega al body', async () => {
    const { holder: freshHolder } = await import('./pty-theme');

    const element = freshHolder();

    expect(element.tagName).toBe('DIV');
    expect(element.className).toBe('pty-detached-holder');
    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect(element.parentElement).toBe(document.body);
  });

  it('llamadas sucesivas devuelven el MISMO elemento (singleton) y no duplican el holder', async () => {
    const { holder: freshHolder } = await import('./pty-theme');

    const first = freshHolder();
    const second = freshHolder();

    expect(second).toBe(first);
    expect(document.body.querySelectorAll('.pty-detached-holder')).toHaveLength(1);
  });
});

describe('documentoQueNiegaLosEstilos', () => {
  it('un <style> se sirve como <template> para que xterm no inyecte CSS', () => {
    const doc = documentoQueNiegaLosEstilos();
    const style = doc.createElement('style');

    expect(style.tagName.toLowerCase()).toBe('template');
  });

  it('cualquier etiqueta que NO sea style se crea como tal', () => {
    const doc = documentoQueNiegaLosEstilos();
    const div = doc.createElement('div');

    expect(div.tagName.toLowerCase()).toBe('div');
  });

  it('las propiedades ajenas a createElement se delegan al document real sin alterarlas', () => {
    const doc = documentoQueNiegaLosEstilos();

    expect(doc.body).toBe(document.body);
    expect(typeof doc.getElementById).toBe('function');
  });
});
