import { describe, expect, it } from 'vitest';
import { leerCss } from './test/leer-css';
import { cuerposDeSelector as cuerpos, sinComentarios } from './test/css-parser';

const live = sinComentarios(leerCss('features/live/live.css'));
const licencias = sinComentarios(leerCss('features/accounts/licenses.css'));
const mensajes = sinComentarios(leerCss('features/messages/messages.css'));

describe('la hoja de cada vista no revierte los tokens legibles del tema global', () => {
  it('un contador vacío de la flota atenúa sólo su muestra decorativa, no el texto del botón', () => {
    expect(cuerpos(live, ".live-tally-chip[data-empty='true']")).toEqual([
      expect.stringMatching(/opacity:\s*1\s*;/),
    ]);
    expect(cuerpos(live, ".live-tally-chip[data-empty='true'] .live-tally-swatch")).toEqual([
      expect.stringMatching(/opacity:\s*\.45\s*;/),
    ]);
  });

  it('los hallazgos usan el token secundario en claro y oscuro', () => {
    expect(cuerpos(licencias, '.finding-section p')).toHaveLength(2);
    expect(cuerpos(licencias, '.finding-section p'))
      .toEqual(expect.arrayContaining([expect.stringMatching(/color:\s*var\(--muted\)\s*;/)]));
    expect(cuerpos(licencias, '.finding-section p').every((cuerpo) => (
      /color:\s*var\(--muted\)\s*;/.test(cuerpo)
    ))).toBe(true);
    expect(cuerpos(licencias, '.finding-reason').every((cuerpo) => (
      /color:\s*var\(--muted\)\s*;/.test(cuerpo)
    ))).toBe(true);
  });

  it('las píldoras de reintento y muerte heredan el color sobre tinte de cada tema', () => {
    expect(cuerpos(mensajes, '.messenger-pill[data-kind="retry"]'))
      .toEqual([expect.stringMatching(/color:\s*var\(--on-amber\)\s*;/)]);
    expect(cuerpos(mensajes, '.messenger-pill[data-kind="dead"]'))
      .toEqual([expect.stringMatching(/color:\s*var\(--on-red\)\s*;/)]);
  });
});
