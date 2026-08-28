import { describe, expect, it } from 'vitest';
import { ROLE_BRIEF_MAX, bloqueoPorRuntimeDesplegado, contarRoleBrief } from './role-brief';

/**
 * The guard exists because this screen makes REACHABLE a hole that was not before: deployed
 * adapters measure `self_role` in UTF-16 units and the database in code points.
 * See the long comment of `bloqueoPorRuntimeDesplegado`.
 */
describe('bloqueoPorRuntimeDesplegado', () => {
  it('no molesta al caso normal: un brief largo sin emojis pasa', () => {
    const texto = 'a'.repeat(ROLE_BRIEF_MAX);
    expect(contarRoleBrief(texto)).toBe(1200);
    expect(texto.length).toBe(1200);
    expect(bloqueoPorRuntimeDesplegado(texto)).toBeUndefined();
  });

  it('bloquea el caso exacto que dejaría SORDO al alias: 1200 puntos, 1300 UTF-16', () => {
    const texto = 'a'.repeat(1100) + '\u{1F389}'.repeat(100);
    expect(contarRoleBrief(texto)).toBe(1200);   // la base lo aceptaría
    expect(texto.length).toBe(1300);             // el adaptador desplegado lo rechaza
    const motivo = bloqueoPorRuntimeDesplegado(texto);
    expect(motivo).toBeDefined();
    // The message must give BOTH numbers: without them the operator does not understand why a
    // text that "measures 1200" cannot be saved.
    expect(motivo).toContain('1200');
    expect(motivo).toContain('1300');
    expect(motivo).toContain('SORDO');
  });

  it('no se superpone con el tope normal: pasado de 1200 puntos lo avisa el contador, no esta guarda', () => {
    const texto = 'a'.repeat(1150) + '\u{1F389}'.repeat(60); // 1210 puntos, 1270 UTF-16
    expect(contarRoleBrief(texto)).toBeGreaterThan(ROLE_BRIEF_MAX);
    expect(bloqueoPorRuntimeDesplegado(texto)).toBeUndefined();
  });

  it('mide sobre el texto RECORTADO, igual que el contador y que el store', () => {
    const texto = '\n  ' + 'a'.repeat(1100) + '\u{1F389}'.repeat(100) + '  \n';
    expect(bloqueoPorRuntimeDesplegado(texto)).toBeDefined();
    expect(bloqueoPorRuntimeDesplegado('  ' + 'a'.repeat(1200) + '  ')).toBeUndefined();
  });
});
