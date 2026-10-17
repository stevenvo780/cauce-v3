import { describe, expect, it } from 'vitest';
import { DOCUMENTOS_DE_GOBIERNO } from '@cauce/protocol';
import {
  ARNESES_REALES, DISTINCION_HERRAMIENTAS_Y_PERMISOS,
  DONDE_SE_ESCRIBE_EL_ROL_DECLARADO,
} from './arneses';

describe('la tabla de arneses reales', () => {
  it('cubre el juego cerrado que el inventario del gateway sabe resolver', () => {
    expect(ARNESES_REALES.map((arnes) => arnes.id).sort()).toEqual(Object.keys(DOCUMENTOS_DE_GOBIERNO).sort());
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

  it.each(['grok', 'muse'])('%s exige su workspace medido y dirige el manual al contexto canónico', (id) => {
    const arnes = ARNESES_REALES.find((entry) => entry.id === id);
    expect(arnes?.directiva).toBe(`<WORKSPACE_${id.toUpperCase()}>/AGENTS.md`);
    expect(arnes?.detalle).toContain(`\`${id}_workspace\``);
    expect(arnes?.detalle).toMatch(/medido en el runtime/);
    expect(arnes?.dondeSeToca).toMatch(/«Perfil y contexto».*workspace medido/);
    expect(arnes?.dondeSeToca).toMatch(/contexto canónico.*lote/);
    expect(arnes?.directiva).not.toMatch(/<HOME>|\.config|\.grok/);
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
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/«Perfil y contexto»/);
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
