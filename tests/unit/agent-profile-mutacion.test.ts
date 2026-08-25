import { describe, expect, it } from 'vitest';
import {
  AGENT_PROFILE_LIMITS, ConfigChangeRequestSchema, ConfigMutationSchema
} from '@cauce/protocol';

/**
 * EL PERFIL ENTRA POR LA MUTACIÓN DE CONFIGURACIÓN, NO POR UNA RUTA PROPIA.
 *
 * Es la decisión de diseño que sostiene el resto y por eso se prueba acá antes que nada:
 * `POST /v3/console/config/changes` ya trae bloqueo optimista de revisión, `config_revisions` con
 * mutación INVERSA (o sea, botón de deshacer), asiento en `audit_events`, `assertControl` contra la
 * base DOS veces y el aislamiento por inquilino de `authorizeMutation`. Una ruta HTTP nueva no
 * hereda casi nada de eso y habría que reimplementarlo a mano, que es como se pierde una guarda sin
 * que nadie lo note.
 *
 * Lo que estas pruebas fijan es el CONTRATO de la mutación. Los topes exactos —y el mensaje que
 * nombra el campo que no entra— los decide `normalizeAgentProfile()` en el store, que es quien
 * puede contestar «cuántos caracteres mandaste»; acá sólo se corta un cuerpo absurdo antes de abrir
 * transacción.
 */

const BASE = { tenant_id: 'Steven', alias: 'zeus' } as const;

describe('agent_profile como recurso de la mutación de configuración', () => {
  it('acepta un perfil completo con sus cuatro listas', () => {
    const parsed = ConfigMutationSchema.parse({
      resource: 'agent_profile', action: 'update', ...BASE,
      value: {
        purpose: 'Orquestar la flota y reparar Cauce.',
        role_summary: 'Médico de la flota.',
        responsibilities: ['diagnosticar fallos', 'desplegar arreglos'],
        restrictions: ['no tocar credenciales'],
        tools: ['ssh a kratos'],
        operating_rules: ['persistir antes de narrar']
      }
    });
    expect(parsed.resource).toBe('agent_profile');
    // El discriminante tiene que estrechar el tipo, o el manejador del store no compila.
    if (parsed.resource !== 'agent_profile') throw new Error('la unión no discriminó');
    expect(parsed.alias).toBe('zeus');
    expect(parsed.value?.responsibilities).toEqual(['diagnosticar fallos', 'desplegar arreglos']);
  });

  it('admite borrar el perfil sin mandar valor', () => {
    const parsed = ConfigMutationSchema.parse({
      resource: 'agent_profile', action: 'delete', ...BASE
    });
    expect(parsed.resource).toBe('agent_profile');
  });

  it('admite NULL en los textos, que es como se declara «no declarado»', () => {
    const parsed = ConfigMutationSchema.parse({
      resource: 'agent_profile', action: 'update', ...BASE,
      value: { purpose: null, role_summary: null }
    });
    if (parsed.resource !== 'agent_profile') throw new Error('la unión no discriminó');
    expect(parsed.value?.purpose).toBeNull();
  });

  /**
   * CONTROL NEGATIVO del `.strict()`: un campo que no es del perfil tiene que REBOTAR.
   *
   * Sin esto, un `role_brief` colado dentro del perfil se aceptaría en el borde y se perdería en
   * silencio en el store, y el operador vería «guardado» sobre un campo que nunca se escribió.
   */
  it('rechaza un campo que no es del perfil', () => {
    expect(() => ConfigMutationSchema.parse({
      resource: 'agent_profile', action: 'update', ...BASE,
      value: { purpose: 'algo', role_brief: 'esto no va acá' }
    })).toThrow();
  });

  /** CONTROL NEGATIVO: una lista tiene que ser una lista, no un texto con comas. */
  it('rechaza una lista mandada como texto', () => {
    expect(() => ConfigMutationSchema.parse({
      resource: 'agent_profile', action: 'update', ...BASE,
      value: { responsibilities: 'diagnosticar, desplegar' }
    })).toThrow();
  });

  /** CONTROL NEGATIVO: el alias tiene que pasar por `AliasSchema`, como en el recurso `agent`. */
  it('rechaza un alias con forma inválida', () => {
    expect(() => ConfigMutationSchema.parse({
      resource: 'agent_profile', action: 'update', tenant_id: 'Steven', alias: 'Zeus Mayúsculo'
    })).toThrow();
  });

  /**
   * El guardia de tamaño del BORDE corta lo absurdo antes de abrir transacción, pero NO es el tope
   * real: el tope real lo aplica `normalizeAgentProfile()`, que mide en las dos unidades y nombra
   * el campo. Acá se comprueba que lo que entra en el tope de verdad PASA el borde — si el borde
   * fuera más estricto que la base, el operador recibiría un rechazo sin campo y sin número.
   */
  it('deja pasar un perfil que llena el tope real, porque el borde no es el tope', () => {
    const parsed = ConfigMutationSchema.parse({
      resource: 'agent_profile', action: 'update', ...BASE,
      value: {
        purpose: 'a'.repeat(AGENT_PROFILE_LIMITS.purpose),
        role_summary: 'b'.repeat(AGENT_PROFILE_LIMITS.role_summary)
      }
    });
    if (parsed.resource !== 'agent_profile') throw new Error('la unión no discriminó');
    expect(parsed.value?.purpose).toHaveLength(AGENT_PROFILE_LIMITS.purpose);
  });

  /**
   * CONTROL NEGATIVO del guardia del borde: un cuerpo monstruoso NO llega a la transacción.
   *
   * Sin este corte, un megabyte de texto abre un `BEGIN`, toma el lock consultivo de configuración
   * —que es GLOBAL, uno solo para toda la instalación— y lo suelta cuando Postgres termina de
   * rechazarlo. El resto de operadores espera detrás.
   */
  it('rechaza en el borde un cuerpo que jamás podría entrar', () => {
    expect(() => ConfigMutationSchema.parse({
      resource: 'agent_profile', action: 'update', ...BASE,
      value: { purpose: 'a'.repeat(200_000) }
    })).toThrow();
  });

  /**
   * LA DESIGUALDAD QUE SOSTIENE EL DISEÑO, medida en vez de supuesta.
   *
   * El borde de zod tiene que ser MÁS FLOJO que el tope real en todos los campos. Si alguien
   * aprieta el borde por debajo del tope, este test se pone rojo — y sin él, el síntoma en
   * producción sería un operador recibiendo «invalid_request» sin campo y sin número sobre un
   * formulario de seis cajas, que es exactamente el rechazo mudo que el diseño quiere evitar.
   *
   * Se mide por EFECTO (¿pasa el esquema un valor del tamaño del tope real?) y no comparando dos
   * constantes, porque las constantes del borde son privadas de `schemas.ts` a propósito.
   */
  it('el borde es más flojo que el tope real en todos los campos', () => {
    const enElTope = {
      purpose: 'a'.repeat(AGENT_PROFILE_LIMITS.purpose),
      role_summary: 'b'.repeat(AGENT_PROFILE_LIMITS.role_summary),
      responsibilities: Array.from(
        { length: AGENT_PROFILE_LIMITS.items }, () => 'c'.repeat(AGENT_PROFILE_LIMITS.item)
      ),
      restrictions: Array.from(
        { length: AGENT_PROFILE_LIMITS.items }, () => 'd'.repeat(AGENT_PROFILE_LIMITS.item)
      ),
      tools: Array.from(
        { length: AGENT_PROFILE_LIMITS.items }, () => 'e'.repeat(AGENT_PROFILE_LIMITS.item)
      ),
      operating_rules: Array.from(
        { length: AGENT_PROFILE_LIMITS.items }, () => 'f'.repeat(AGENT_PROFILE_LIMITS.item)
      )
    };
    // Pasa el BORDE. Que el TOTAL no entre lo dirá `normalizeAgentProfile()` en el store, con el
    // campo `total` y el número — que es justamente la división de trabajo que se está fijando.
    expect(() => ConfigMutationSchema.parse({
      resource: 'agent_profile', action: 'update', ...BASE, value: enElTope
    })).not.toThrow();
  });

  /** El sobre completo tiene que aceptar `expected_revision`: sin él no hay bloqueo optimista. */
  it('viaja dentro del sobre con expected_revision', () => {
    const parsed = ConfigChangeRequestSchema.parse({
      dry_run: false,
      expected_revision: 42,
      mutation: {
        resource: 'agent_profile', action: 'update', ...BASE,
        value: { purpose: 'Orquestar.' }
      }
    });
    expect(parsed.expected_revision).toBe(42);
    expect(parsed.mutation.resource).toBe('agent_profile');
  });
});
