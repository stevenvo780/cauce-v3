import { describe, expect, it } from 'vitest';
import {
  componerBloqueDePerfil, emptyAgentProfile, type AgentProfile, type HechosDelAlias
} from '@cauce/protocol';
import {
  componerBloqueDePerfil as reexportadaPorElAdaptador, compilarContexto
} from '../../packages/adapter-sdk/src/context/perfil-a-contexto.js';

/**
 * PROFILE COMPOSITION LIVES IN ONE PLACE.
 *
 * The adapter uses it to SEED the container's file; the gateway needs it to show a PREVIEW of
 * what will be written before writing it. If they were two implementations, they would diverge
 * on the first fix and the operator would approve a block different from the one that ends up
 * on disk — without any error, because each one on its own would be fine. That is the failure
 * these tests prevent, which is why the first one compares by IDENTITY, not by behaviour.
 */

const HECHOS: HechosDelAlias = {
  permisos: { ruta: true, lectura: true, control: false, notificacion: false },
  cuotas: [{ proveedor: 'anthropic', cuenta: 'cuenta-a', limite: '40% disponible en la ventana 5h' }],
  arnes: { harness: 'claude', home: '/home/dev', contenedor: 'claw-zeus', capacidades: ['pty'] },
  destinos: ['kant', 'argos']
};

function perfil(sobrescribe: Partial<AgentProfile> = {}): AgentProfile {
  return { ...emptyAgentProfile('Steven', 'zeus'), ...sobrescribe };
}

describe('la composición del perfil', () => {
  /**
   * The test that makes the others meaningful: the two paths are THE SAME object.
   *
   * If the adapter had its own copy, this would go red even though both currently produce the
   * same text — which is exactly when you have to find out, before they diverge, not after.
   */
  it('el adaptador re-exporta la del protocolo, no una copia suya', () => {
    expect(reexportadaPorElAdaptador).toBe(componerBloqueDePerfil);
  });

  it('`compilarContexto` del adaptador pasa por esa misma función, sin hechos derivados', () => {
    const contexto = { perfil: perfil({ purpose: 'Orquestar la flota.' }), hechos: HECHOS };
    expect(compilarContexto(contexto)).toBe(
      componerBloqueDePerfil(contexto.perfil, contexto.hechos, { includeDerivedFacts: false })
    );
    expect(compilarContexto(contexto)).not.toBe(
      componerBloqueDePerfil(contexto.perfil, contexto.hechos)
    );
  });

  it('emite las secciones del perfil autorado', () => {
    const bloque = componerBloqueDePerfil(perfil({
      purpose: 'Orquestar la flota y reparar Cauce.',
      role_summary: 'Médico de la flota.',
      responsibilities: ['diagnosticar fallos'],
      restrictions: ['no tocar credenciales'],
      tools: ['ssh a kratos'],
      operating_rules: ['persistir antes de narrar']
    }), HECHOS);

    expect(bloque).toContain('## Identidad y propósito');
    expect(bloque).toContain('Orquestar la flota y reparar Cauce.');
    expect(bloque).toContain('- no tocar credenciales');
    // DENIED permissions are named the same way as granted ones: an agent that does not know
    // whether it can do something tries it and spends the turn. Saying "no" closes the doubt.
    expect(bloque).toContain('Cambiar configuración (control): no');
    expect(bloque).toContain('Rutear mensajes a otros alias: sí');
  });

  /**
   * NEGATIVE CONTROL of the whole design: a profile with nothing authored produces an EMPTY STRING.
   *
   * Not a skeleton of headings. Permissions and harness are facts that always exist, so without
   * this cut an alias without a written profile would only get told which container it runs in
   * — noise shaped like a contract. The empty string is the signal that there is no profile.
   */
  it('un perfil sin nada autorado no produce un esqueleto de encabezados', () => {
    expect(componerBloqueDePerfil(perfil(), HECHOS)).toBe('');
  });

  /**
   * DETERMINISM: the same profile and the same facts produce the SAME bytes.
   *
   * The whole saving hinges on this. The seal is the sha256 of the block, so a non-deterministic
   * composition would make the seal change on its own and every seal change costs a rewrite of
   * the file in every container of the fleet — without anyone seeing an error.
   */
  it('es determinista: mismos datos, mismos bytes', () => {
    const datos = perfil({ purpose: 'Orquestar.', tools: ['a', 'b'] });
    expect(componerBloqueDePerfil(datos, HECHOS)).toBe(componerBloqueDePerfil(datos, HECHOS));
  });

  /** A section with no body disappears ENTIRELY, instead of leaving an empty heading. */
  it('omite las secciones que no tienen cuerpo', () => {
    const bloque = componerBloqueDePerfil(perfil({ purpose: 'Sólo esto.' }), HECHOS);
    expect(bloque).toContain('## Identidad y propósito');
    expect(bloque).not.toContain('## Instrucciones fijas de funcionamiento');
    expect(bloque).not.toContain('## Rol, responsabilidades y restricciones');
  });
});
