import { describe, expect, it } from 'vitest';
import {
  componerBloqueDePerfil, emptyAgentProfile, type AgentProfile, type HechosDelAlias
} from '@cauce/protocol';
import {
  componerBloqueDePerfil as reexportadaPorElAdaptador, compilarContexto
} from '../../packages/adapter-sdk/src/context/perfil-a-contexto.js';

/**
 * LA COMPOSICIÓN DEL PERFIL VIVE EN UN SOLO SITIO.
 *
 * El adaptador la usa para SEMBRAR el fichero del contenedor; el gateway la necesita para enseñar
 * una VISTA PREVIA de lo que se va a escribir antes de escribirlo. Si fueran dos implementaciones,
 * divergirían a la primera corrección y el operador aprobaría un bloque distinto del que acaba en
 * el disco — sin que nada diera error, porque cada una por su lado estaría bien. Ese es el fallo
 * que estas pruebas impiden, y por eso la primera compara por IDENTIDAD y no por comportamiento.
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
   * La prueba que hace que las demás signifiquen algo: las dos vías son EL MISMO objeto.
   *
   * Si el adaptador tuviera su propia copia esto daría rojo aunque las dos produjeran hoy el mismo
   * texto, que es exactamente cuándo hay que enterarse — antes de que diverjan, no después.
   */
  it('el adaptador re-exporta la del protocolo, no una copia suya', () => {
    expect(reexportadaPorElAdaptador).toBe(componerBloqueDePerfil);
  });

  it('`compilarContexto` del adaptador pasa por esa misma función', () => {
    const contexto = { perfil: perfil({ purpose: 'Orquestar la flota.' }), hechos: HECHOS };
    expect(compilarContexto(contexto)).toBe(
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
    // Los permisos DENEGADOS se nombran igual que los concedidos: un agente que no sabe si puede
    // hacer algo lo intenta y gasta el turno. Decir «no» cierra la duda.
    expect(bloque).toContain('Cambiar configuración (control): no');
    expect(bloque).toContain('Rutear mensajes a otros alias: sí');
  });

  /**
   * CONTROL NEGATIVO del diseño entero: un perfil sin nada autorado produce CADENA VACÍA.
   *
   * Y no un esqueleto de encabezados. Los permisos y el arnés son hechos que siempre existen, así
   * que sin este corte un alias sin perfil escrito recibiría un fichero que sólo le dice en qué
   * contenedor corre — ruido con forma de contrato. La cadena vacía es la señal de «no hay perfil».
   */
  it('un perfil sin nada autorado no produce un esqueleto de encabezados', () => {
    expect(componerBloqueDePerfil(perfil(), HECHOS)).toBe('');
  });

  /**
   * DETERMINISMO: el mismo perfil y los mismos hechos dan los MISMOS bytes.
   *
   * De esto cuelga el ahorro entero. El sello es el sha256 del bloque, así que una composición no
   * determinista haría que el sello cambiara solo y cada cambio de sello cuesta una reescritura del
   * fichero en cada contenedor de la flota — sin que nadie viera un error.
   */
  it('es determinista: mismos datos, mismos bytes', () => {
    const datos = perfil({ purpose: 'Orquestar.', tools: ['a', 'b'] });
    expect(componerBloqueDePerfil(datos, HECHOS)).toBe(componerBloqueDePerfil(datos, HECHOS));
  });

  /** Una sección sin cuerpo desaparece ENTERA, en vez de dejar un encabezado hueco. */
  it('omite las secciones que no tienen cuerpo', () => {
    const bloque = componerBloqueDePerfil(perfil({ purpose: 'Sólo esto.' }), HECHOS);
    expect(bloque).toContain('## Identidad y propósito');
    expect(bloque).not.toContain('## Instrucciones fijas de funcionamiento');
    expect(bloque).not.toContain('## Rol, responsabilidades y restricciones');
  });
});
