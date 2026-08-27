import { describe, expect, it } from 'vitest';
import { WsOutboundSchema } from '@cauce/protocol';

/**
 * Verifica la inclusión del perfil de agente en la trama `hello_ack`, validando compatibilidad
 * de esquema y el control mediante la capability `agent_profile_v1`.
 */

describe('el esquema del saludo acepta el perfil sin romper a quien no lo espera', () => {
  const saludoBase = {
    type: 'hello_ack' as const,
    version: '3.0' as const,
    epoch: 1,
    lease_expires_at: '2026-08-25T12:00:00.000Z'
  };

  it('un saludo SIN perfil sigue siendo válido: es el de un adaptador viejo', () => {
    expect(WsOutboundSchema.safeParse(saludoBase).success).toBe(true);
  });

  it('un saludo CON perfil es válido', () => {
    const conPerfil = {
      ...saludoBase,
      agent_profile: {
        perfil: {
          tenant_id: 'Steven', alias: 'zeus',
          purpose: 'el médico de la flota', role_summary: null, human_brief: null,
          responsibilities: [], restrictions: [], tools: [], operating_rules: []
        },
        hechos: {
          permisos: { ruta: true, lectura: true, control: false, notificacion: true },
          cuotas: [{ proveedor: 'claude', cuenta: 'saldantia' }],
          arnes: { harness: 'claude', home: '/home/dev', capacidades: ['bash'] },
          destinos: ['kant']
        }
      }
    };
    const resultado = WsOutboundSchema.safeParse(conPerfil);
    expect(resultado.success).toBe(true);
  });

  it('CONTROL NEGATIVO: un perfil a medias se RECHAZA, no se siembra medio', () => {
    /*
     * Lo que llega por el socket es dato ajeno y con ello se escriben ficheros que un modelo va a
     * leer como autoritativos. Un campo que falta significa que las dos puntas no hablan la misma
     * versión, y ante eso vale más fallar el saludo que sembrar media persona.
     */
    const aMedias = {
      ...saludoBase,
      agent_profile: {
        perfil: { tenant_id: 'Steven', alias: 'zeus', purpose: 'x' },
        hechos: {
          permisos: { ruta: true, lectura: true, control: false, notificacion: true },
          cuotas: [], arnes: { harness: 'claude', home: '/h', capacidades: [] }, destinos: []
        }
      }
    };
    expect(WsOutboundSchema.safeParse(aMedias).success).toBe(false);
  });

  it('CONTROL NEGATIVO: un campo de MÁS también se rechaza', () => {
    // `.strict()`: un campo desconocido es la señal de que la otra punta habla otra versión.
    const conExtra = {
      ...saludoBase,
      agent_profile: {
        perfil: {
          tenant_id: 'Steven', alias: 'zeus',
          purpose: null, role_summary: null, human_brief: null,
          responsibilities: [], restrictions: [], tools: [], operating_rules: [],
          campo_inventado: 'x'
        },
        hechos: {
          permisos: { ruta: true, lectura: true, control: false, notificacion: true },
          cuotas: [], arnes: { harness: 'claude', home: '/h', capacidades: [] }, destinos: []
        }
      }
    };
    expect(WsOutboundSchema.safeParse(conExtra).success).toBe(false);
  });
});

describe('el gateway no manda el perfil a quien no lo declaró', () => {
  it('la capability tiene un nombre versionado, como las otras dos', async () => {
    /*
     * `agent_profile_v1`, no `agent_profile`. El sufijo es lo que permite cambiar la forma del
     * campo sin dejar mudos a los adaptadores de la versión anterior: se declara `_v2` y el
     * gateway sigue mandando `_v1` a quien sólo pida eso. Sin sufijo, el primer cambio de forma es
     * otra vez el problema del `.strict()`.
     */
    const fuente = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../services/gateway/src/routes/core.ts', import.meta.url), 'utf8'
    ));
    expect(fuente).toContain("hello.capabilities.includes('agent_profile_v1')");
  });

  it('el adaptador declara esa MISMA capability, o el gateway no le mandaría nada', async () => {
    /*
     * Las dos puntas tienen que nombrar la misma cadena. Un desajuste de una letra deja el campo
     * sin mandarse para siempre, sin error: el gateway cree que el adaptador no lo pidió y el
     * adaptador espera un campo que no llega. Esta prueba es la única que puede verlo, porque el
     * tipo de TS no cruza los dos ficheros.
     */
    const fuente = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../packages/adapter-sdk/src/harnesses/shared.ts', import.meta.url), 'utf8'
    ));
    expect(fuente).toContain('agent_profile_v1: true');
  });
});
