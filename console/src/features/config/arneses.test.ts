import { describe, expect, it } from 'vitest';
import {
  ARNESES_REALES, DISTINCION_HERRAMIENTAS_Y_PERMISOS,
  DONDE_SE_ESCRIBE_EL_ROL_DECLARADO,
} from './arneses';

/**
 * **The table of how each harness REALLY works.**
 *
 * It exists because "Settings and enrollments" offered touching `agents.harness_id` as if the
 * program the bot runs came from that column, and it does not (see `campos-inertes.ts`). The
 * question the operator has in front of them —"where is what this bot reads changed?"— can only
 * be answered per harness, and the answer is different for all four.
 *
 * The set is CLOSED and comes from `resolveAgentDocuments()`: Claude, Codex, OpenClaw and Hermes
 * have an inventory strategy. That does not mean every one supports the canonical profile batch.
 * If the gateway learns a new harness, this test turns red and forces an explicit UI decision.
 */

const JUEGO_CERRADO = ['claude', 'codex', 'openclaw', 'hermes'] as const;

describe('la tabla de arneses reales', () => {
  it('cubre el juego cerrado que el inventario del gateway sabe resolver', () => {
    expect(ARNESES_REALES.map((arnes) => arnes.id).sort()).toEqual([...JUEGO_CERRADO].sort());
  });

  it('el que lee algo dice DÓNDE, y ninguno repite la ruta de otro', () => {
    const donde = ARNESES_REALES.map((arnes) => arnes.directiva);
    expect(new Set(donde).size, 'dos arneses no pueden leer exactamente lo mismo').toBe(donde.length);
    for (const arnes of ARNESES_REALES) {
      expect(arnes.label.trim().length, `${arnes.id} no tiene rótulo`).toBeGreaterThan(0);
      expect(arnes.detalle.trim().length, `${arnes.id} no explica su ruta`).toBeGreaterThan(0);
      expect(arnes.directiva.trim(), `${arnes.id} no declara su manual efectivo`).toBe(arnes.directiva);
    }
  });

  it('no inventa soporte OpenCode y no presenta un perfil por lote para Hermes', () => {
    expect(ARNESES_REALES.map((arnes) => arnes.id)).not.toContain('opencode');
    const hermes = ARNESES_REALES.find((arnes) => arnes.id === 'hermes');
    expect(hermes?.directiva).toMatch(/AGENTS\.md/);
    expect(hermes?.detalle).toMatch(/no declara soporte para Hermes/i);
    expect(hermes?.dondeSeToca).not.toMatch(/perfil canónico.*aplicado|soportado/i);
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
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/«Contexto»/);
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/sólo lectura/);
  });

  it('separa las herramientas declaradas de capacidades y permisos reales', () => {
    expect(DISTINCION_HERRAMIENTAS_Y_PERMISOS).toMatch(/instrucciones/i);
    expect(DISTINCION_HERRAMIENTAS_Y_PERMISOS).toMatch(/no habilitan/i);
    expect(DISTINCION_HERRAMIENTAS_Y_PERMISOS).toMatch(/capacidades.*runtime/i);
    expect(DISTINCION_HERRAMIENTAS_Y_PERMISOS).toMatch(/membresías.*role_policies.*ACL.*RBAC/i);
  });

  it('CONTROL NEGATIVO — la frase no vuelve a prometer que el rol se escribe en esta pantalla', () => {
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO)
      .not.toMatch(/se escribe desde acá|se edita desde acá|se escribe acá|lo único de esta lista/i);
  });
});
