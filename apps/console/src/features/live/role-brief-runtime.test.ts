import { describe, expect, it } from 'vitest';
import { ROLE_BRIEF_MAX, bloqueoPorRuntimeDesplegado, contarRoleBrief } from './role-brief';

/**
 * La guarda existe porque esta pantalla vuelve ALCANZABLE un agujero que antes no lo era: los
 * adaptadores desplegados miden `self_role` en unidades UTF-16 y la base en puntos de código.
 * Ver el comentario largo de `bloqueoPorRuntimeDesplegado`.
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
    // El mensaje tiene que dar LOS DOS numeros: sin ellos el operador no entiende por que un
    // texto que "mide 1200" no se puede guardar.
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
