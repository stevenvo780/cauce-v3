import { describe, expect, it } from 'vitest';
import {
  ARNESES_REALES, DONDE_SE_ESCRIBE_EL_ROL_DECLARADO,
} from './arneses';

/**
 * **The table of how each harness REALLY works.**
 *
 * It exists because "Settings and enrollments" offered touching `agents.harness_id` as if the
 * program the bot runs came from that column, and it does not (see `campos-inertes.ts`). The
 * question the operator has in front of them —"where is what this bot reads changed?"— can only
 * be answered per harness, and the answer is different for all four.
 *
 * The set is CLOSED and comes from `resolveAgentDocuments()`
 * (services/gateway/src/console/agent-documents/catalog.ts:317): claude, codex and openclaw have a
 * resolved document; everything else —hermes included— falls back to `default` and returns an
 * empty list. If the gateway learns a new harness, this test turns red and forces a decision on
 * what gets shown, instead of leaving a silent row.
 */

const JUEGO_CERRADO = ['claude', 'codex', 'openclaw', 'hermes'] as const;

describe('la tabla de arneses reales', () => {
  it('cubre el juego cerrado que el gateway sabe resolver, más el que no resuelve ninguno', () => {
    expect(ARNESES_REALES.map((arnes) => arnes.id).sort()).toEqual([...JUEGO_CERRADO].sort());
  });

  it('el que lee algo dice DÓNDE, y ninguno repite la ruta de otro', () => {
    const donde = ARNESES_REALES.map((arnes) => arnes.directiva);
    expect(new Set(donde).size, 'dos arneses no pueden leer exactamente lo mismo').toBe(donde.length);
    for (const arnes of ARNESES_REALES) {
      expect(arnes.label.trim().length, `${arnes.id} no tiene rótulo`).toBeGreaterThan(0);
      expect(arnes.detalle.trim().length, `${arnes.id} no explica su ruta`).toBeGreaterThan(0);
      // The empty path is data, not a gap: it means "reads none", and that is checked by the
      // hermes assertion below. What cannot happen is a declared path that is only half there.
      if (arnes.directiva !== '') expect(arnes.directiva.trim()).toBe(arnes.directiva);
    }
  });

  it('hermes es el único que no lee ningún documento de instrucciones', () => {
    expect(ARNESES_REALES.filter((arnes) => arnes.directiva.trim() === '').map((arnes) => arnes.id)).toEqual(['hermes']);
  });

  /**
   * The key thing about the whole table: NONE of those files are touched from "Settings and enrollments".
   * Promising otherwise would send an operator looking here for an editor that lives on another screen.
   */
  it('ninguna fila se declara editable desde esta pantalla, y todas dicen dónde sí se toca', () => {
    for (const arnes of ARNESES_REALES) {
      expect(arnes.editableDesdeAjustes, `${arnes.id} se declara editable acá`).toBe(false);
      expect(arnes.dondeSeToca.trim().length, `${arnes.id} no dice dónde se toca`).toBeGreaterThan(0);
    }
  });

  it('la frase de cierre cita la cadena entera del rol declarado y manda a donde SÍ se escribe', () => {
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/role_brief/);
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/selfRoleFromProfile/);
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/self_role/);
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/«Perfil»/);
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/sólo lectura/);
  });

  it('CONTROL NEGATIVO — la frase no vuelve a prometer que el rol se escribe en esta pantalla', () => {
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO)
      .not.toMatch(/se escribe desde acá|se edita desde acá|se escribe acá|lo único de esta lista/i);
  });
});
