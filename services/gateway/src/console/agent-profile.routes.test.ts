import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextoDeAlias } from '@cauce/protocol';
import {
  registerAgentProfileRoutes, type AgentProfileDeps, type RespuestaDelPerfil, type TopeSuperado,
} from './agent-profile.routes.js';

/**
 * LA VISTA PREVIA DEL PERFIL, probada por donde puede MENTIR.
 *
 * El valor de esta ruta no es devolver JSON: es que lo que enseña sea, byte a byte, lo que va a
 * quedar escrito en el contenedor. Todo lo que se prueba acá defiende esa propiedad, más las dos
 * cosas que la ruta no puede saber y tiene que decir en vez de callarse.
 */

const ACTOR = { tenant_id: 'Steven', alias: 'zeus' };
const RUTA = '/v3/console/tenants/Steven/agents/zeus/perfil';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function contexto(parcial: Partial<ContextoDeAlias['perfil']>, harness: string): ContextoDeAlias {
  return {
    perfil: {
      tenant_id: 'Steven', alias: 'zeus',
      purpose: null, role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
      ...parcial
    },
    hechos: {
      permisos: { ruta: true, lectura: true, control: false, notificacion: true },
      cuotas: [{ proveedor: 'claude', cuenta: 'saldantia', limite: '3% semanal' }],
      arnes: { harness, home: '/home/dev', contenedor: 'ws-zeus', capacidades: ['bash', 'read'] },
      destinos: ['kant', 'argos']
    }
  };
}

async function servidor(ctx: ContextoDeAlias | (() => Promise<never>), exists = true) {
  const app = Fastify();
  registerAgentProfileRoutes(app, {
    authorize: async () => ACTOR,
    authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias, enabled: true }),
    readContext: async () => {
      if (typeof ctx === 'function') return ctx();
      return {
        contexto: ctx, exists,
        revision: exists ? 1 : null,
        applied_revision: exists ? 1 : null,
      };
    },
  });
  await app.ready();
  return app;
}

let abierto: Awaited<ReturnType<typeof servidor>> | undefined;
afterEach(async () => { await abierto?.close(); abierto = undefined; });

describe('qué ficheros le tocan a cada arnés', () => {
  it('claude recibe UN fichero: CLAUDE.md', async () => {
    abierto = await servidor(contexto({ purpose: 'el médico de la flota' }, 'claude'));
    const res = await abierto.inject({ method: 'GET', url: RUTA });
    expect(res.statusCode).toBe(200);
    const cuerpo = res.json<RespuestaDelPerfil>();
    expect(cuerpo.ficheros.map((f) => f.nombre)).toEqual(['CLAUDE.md']);
    expect(cuerpo.ficheros[0]?.texto).toContain('el médico de la flota');
  });

  it('codex recibe UN fichero: AGENTS.md', async () => {
    abierto = await servidor(contexto({ purpose: 'x' }, 'codex'));
    const res = await abierto.inject({ method: 'GET', url: RUTA });
    expect(res.json<RespuestaDelPerfil>().ficheros.map((f) => f.nombre)).toEqual(['AGENTS.md']);
  });

  it('openclaw recibe los SIETE, en el orden medido en la flota', async () => {
    abierto = await servidor(contexto({ purpose: 'x' }, 'openclaw'));
    const res = await abierto.inject({ method: 'GET', url: RUTA });
    expect(res.json<RespuestaDelPerfil>().ficheros.map((f) => f.nombre)).toEqual([
      'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md', 'AGENTS.md', 'TOOLS.md'
    ]);
  });
});

describe('el reparto de openclaw pone cada cara donde toca', () => {
  it('el propósito va a SOUL.md y el rol a IDENTITY.md, y NO al revés', async () => {
    /*
     * No es orden: es la diferencia entre enseñarle a un modelo quién es y enseñarle qué hace.
     * Un `SOUL.md` que hable de tareas le enseña que su identidad son sus tareas.
     */
    abierto = await servidor(contexto({
      purpose: 'existo para reparar Cauce', role_summary: 'médico de la flota'
    }, 'openclaw'));
    const ficheros = (await abierto.inject({
      method: 'GET', url: RUTA
    })).json<RespuestaDelPerfil>().ficheros;
    const de = (nombre: string) => ficheros.find((f) => f.nombre === nombre)?.texto ?? '';

    expect(de('SOUL.md')).toContain('existo para reparar Cauce');
    expect(de('SOUL.md')).not.toContain('médico de la flota');
    expect(de('IDENTITY.md')).toContain('médico de la flota');
    expect(de('IDENTITY.md')).not.toContain('existo para reparar Cauce');
  });

  it('human_brief va a USER.md — el campo que no tenía camino', async () => {
    abierto = await servidor(contexto({ human_brief: 'Steven, directo y sin rodeos' }, 'openclaw'));
    const ficheros = (await abierto.inject({
      method: 'GET', url: RUTA
    })).json<RespuestaDelPerfil>().ficheros;
    expect(ficheros.find((f) => f.nombre === 'USER.md')?.texto).toContain('Steven, directo y sin rodeos');
  });

  it('MEMORY.md y HEARTBEAT.md son DEL AGENTE: no reciben nada nuestro', async () => {
    /*
     * Pisarlos es borrarle la memoria a un compañero, y desde dentro del contenedor no hay marcha
     * atrás. La política tiene que viajar en la respuesta para que la pantalla lo pueda decir.
     */
    abierto = await servidor(contexto({
      purpose: 'p', role_summary: 'r', human_brief: 'h', tools: ['ssh'], operating_rules: ['no tocar credenciales']
    }, 'openclaw'));
    const ficheros = (await abierto.inject({
      method: 'GET', url: RUTA
    })).json<RespuestaDelPerfil>().ficheros;
    for (const nombre of ['MEMORY.md', 'HEARTBEAT.md']) {
      const fichero = ficheros.find((f) => f.nombre === nombre);
      expect(fichero?.politica).toBe('solo-si-falta');
      expect(fichero?.texto).toBe('');
    }
  });

  it('la vista previa no congela permisos ni destinos dinámicos dentro del perfil autorado', async () => {
    /*
     * Revocar un permiso o cambiar un destino no cambia la revisión del perfil autorado. Si esta
     * vista los materializara, el disco podría seguir afirmando un poder que ya fue revocado.
     */
    abierto = await servidor(contexto({ purpose: 'x', responsibilities: ['reparar Cauce'] }, 'openclaw'));
    const ficheros = (await abierto.inject({
      method: 'GET', url: RUTA
    })).json<RespuestaDelPerfil>().ficheros;
    const agents = ficheros.find((f) => f.nombre === 'AGENTS.md')?.texto ?? '';
    expect(agents).toContain('reparar Cauce');
    expect(agents).not.toContain('control): no');
    expect(agents).not.toContain('otros alias: sí');
  });
});

describe('lo que la ruta NO sabe, lo dice', () => {
  it('declara que la vista previa se compuso sobre fichero vacío', async () => {
    /*
     * El gateway no lee el disco del contenedor. Decir «así queda el fichero» sobre una medición
     * que no se hizo es la clase de mentira que cuesta un despliegue: alguien mira la vista previa,
     * no ve su manual escrito a mano, y concluye que se lo borraron.
     */
    abierto = await servidor(contexto({ purpose: 'x' }, 'claude'));
    expect((await abierto.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>().base)
      .toBe('fichero-vacio');
  });

  it('un arnés desconocido devuelve CERO ficheros con el motivo, no un vacío mudo', async () => {
    abierto = await servidor(contexto({ purpose: 'x' }, 'hermes'));
    const cuerpo = (await abierto.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();
    expect(cuerpo.ficheros).toEqual([]);
    expect(cuerpo.aviso).toContain('hermes');
  });

  it('un perfil ENTERAMENTE vacío no produce un esqueleto de encabezados', async () => {
    /*
     * Los permisos y la configuración del arnés son hechos que SIEMPRE existen. Sin el corte, un
     * alias sin nada escrito recibiría un fichero que sólo le dice en qué contenedor corre: ruido
     * con forma de contrato.
     */
    abierto = await servidor(contexto({}, 'claude'));
    const ficheros = (await abierto.inject({
      method: 'GET', url: RUTA
    })).json<RespuestaDelPerfil>().ficheros;
    expect(ficheros[0]?.texto).toBe('');
  });
});

describe('los topes del arnés se contestan con los dos números, no con un 500', () => {
  it('un openclaw pasado de tope devuelve 422 diciendo QUÉ fichero y cuánto mide', async () => {
    // «No entra» sobre siete ficheros no le dice a nadie qué recortar.
    abierto = await servidor(contexto({ purpose: 'x'.repeat(60_001) }, 'openclaw'));
    const res = await abierto.inject({ method: 'GET', url: RUTA });
    expect(res.statusCode).toBe(422);
    const cuerpo = res.json<TopeSuperado>();
    expect(cuerpo.error).toBe('tope_del_arnes');
    expect(cuerpo.fichero).toBe('SOUL.md');
    expect(cuerpo.medido).toBeGreaterThan(cuerpo.tope);
  });

  it('CONTROL NEGATIVO: a claude NO se le inventa un tope que su arnés no declara', async () => {
    abierto = await servidor(contexto({ purpose: 'x'.repeat(60_001) }, 'claude'));
    expect((await abierto.inject({ method: 'GET', url: RUTA })).statusCode)
      .toBe(200);
  });
});

describe('identidad canónica, autorización y presencia de fila', () => {
  it('devuelve exists=true aunque la fila persistida esté completamente vacía', async () => {
    abierto = await servidor(contexto({}, 'claude'), true);

    const body = (await abierto.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();

    expect(body.exists).toBe(true);
    expect(body.perfil).toMatchObject({ purpose: null, tools: [] });
  });

  it('devuelve exists=false sólo cuando el store no encontró fila', async () => {
    abierto = await servidor(contexto({}, 'claude'), false);

    expect((await abierto.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>().exists)
      .toBe(false);
  });

  it('pasa tenant y alias del destino exactos aunque el actor pertenezca a otro tenant', async () => {
    const app = Fastify();
    let autorizado: readonly string[] | undefined;
    let leido: readonly string[] | undefined;
    const base = contexto({ purpose: 'destino Miguel' }, 'codex');
    const ctx: ContextoDeAlias = {
      ...base, perfil: { ...base.perfil, tenant_id: 'Miguel', alias: 'kant' },
    };
    registerAgentProfileRoutes(app, {
      authorize: async () => ACTOR,
      authorizeTarget: async (_actor, tenantId, alias) => {
        autorizado = [tenantId, alias];
        return { tenant_id: 'Miguel', alias: 'kant', enabled: true };
      },
      readContext: async (tenantId, alias) => {
        leido = [tenantId, alias];
        return { contexto: ctx, exists: true, revision: 4, applied_revision: 3 };
      },
    });
    await app.ready();
    abierto = app;

    const res = await app.inject({
      method: 'GET', url: '/v3/console/tenants/Miguel/agents/kant/perfil',
    });

    expect(res.statusCode).toBe(200);
    expect(autorizado).toEqual(['Miguel', 'kant']);
    expect(leido).toEqual(['Miguel', 'kant']);
    expect(res.json<RespuestaDelPerfil>()).toMatchObject({ tenant_id: 'Miguel', alias: 'kant' });
  });

  it('expone el estado disabled sin inventarle permisos efectivos ni aplicación', async () => {
    const app = Fastify();
    const ctx = contexto({ role_summary: 'rol apagado' }, 'codex');
    registerAgentProfileRoutes(app, {
      authorize: async () => ACTOR,
      authorizeTarget: async () => ({ tenant_id: 'Steven', alias: 'zeus', enabled: false }),
      readContext: async () => ({
        contexto: ctx, exists: true, revision: 2, applied_revision: 2,
      }),
    });
    await app.ready();
    abierto = app;

    const body = (await app.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();

    expect(body.agent_enabled).toBe(false);
    expect(body.runtime_state).toBe('disabled');
    expect(body.self_role).toBe('rol apagado');
  });

  it('falla cerrado si el store devuelve un perfil de otra identidad', async () => {
    const app = Fastify();
    const base = contexto({}, 'codex');
    registerAgentProfileRoutes(app, {
      authorize: async () => ACTOR,
      authorizeTarget: async () => ({ tenant_id: 'Steven', alias: 'zeus', enabled: true }),
      readContext: async () => ({
        contexto: { ...base, perfil: { ...base.perfil, tenant_id: 'Miguel', alias: 'zeus' } },
        exists: true,
        revision: 1,
        applied_revision: null,
      }),
    });
    await app.ready();
    abierto = app;

    expect((await app.inject({ method: 'GET', url: RUTA })).statusCode).toBe(500);
  });

  it('deniega por defecto y no consulta el perfil cuando el destino no está autorizado', async () => {
    const app = Fastify();
    let consultada = false;
    registerAgentProfileRoutes(app, {
      authorize: async () => ACTOR,
      authorizeTarget: async () => undefined,
      readContext: async () => {
        consultada = true;
        throw new Error('no debería leer');
      },
    });
    await app.ready();
    abierto = app;

    const res = await app.inject({ method: 'GET', url: RUTA });

    expect(res.statusCode).toBe(404);
    expect(consultada).toBe(false);
  });

  it('la ruta legacy queda en el tenant del actor y se marca deprecada', async () => {
    abierto = await servidor(contexto({}, 'claude'));

    const res = await abierto.inject({ method: 'GET', url: '/v3/console/agents/zeus/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.headers.deprecation).toBe('true');
    expect(res.json<RespuestaDelPerfil>()).toMatchObject({ tenant_id: 'Steven', alias: 'zeus' });
  });
});

describe('la guarda del alias', () => {
  it('un alias con forma inválida se rechaza ANTES de tocar la base', async () => {
    let consultada = false;
    const app = Fastify();
    registerAgentProfileRoutes(app, {
      authorize: async () => ACTOR,
      authorizeTarget: async () => { throw new Error('no debería autorizar'); },
      readContext: async () => { consultada = true; throw new Error('no debería llegar acá'); }
    });
    await app.ready();
    abierto = app;
    const res = await app.inject({
      method: 'GET', url: '/v3/console/tenants/Steven/agents/..%2F..%2Fetc/perfil',
    });
    expect(res.statusCode).toBe(400);
    expect(consultada).toBe(false);
  });
});

const PERFIL_BODY = {
  purpose: 'coordinar la flota',
  role_summary: 'coordinador',
  human_brief: 'Steven, directo',
  responsibilities: ['coordinar'],
  restrictions: ['no tocar secretos'],
  tools: ['cauce'],
  operating_rules: ['verificar'],
};

const REPLACE_PROFILE: NonNullable<AgentProfileDeps['replaceProfile']> = async (profile) => ({
  perfil: profile, exists: true, revision: 2, applied_revision: 1,
});
const PREPARE_RUNTIME: NonNullable<AgentProfileDeps['prepareRuntime']> = async () => ({
  documents: ['AGENTS.md'],
  apply: async () => ([{
    name: 'AGENTS.md', path: '/home/dev/.codex/AGENTS.md', state: 'written',
    sha: sha('nuevo'), bytes: 5,
  }]),
});
const MARK_PROFILE_APPLIED: NonNullable<AgentProfileDeps['markProfileApplied']> = async (
  _tenant, _alias, revision,
) => ({
  perfil: contexto(PERFIL_BODY, 'codex').perfil,
  exists: true,
  revision,
  applied_revision: revision,
});

function depsDeEscritura(overrides: Partial<AgentProfileDeps> = {}): AgentProfileDeps {
  const ctx = contexto(PERFIL_BODY, 'codex');
  return {
    authorize: async () => ACTOR,
    authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias, enabled: true }),
    readContext: async () => ({
      contexto: ctx, exists: true, revision: 1, applied_revision: 1,
    }),
    replaceProfile: REPLACE_PROFILE,
    prepareRuntime: PREPARE_RUNTIME,
    markProfileApplied: MARK_PROFILE_APPLIED,
    ...overrides,
  };
}

async function appDeEscritura(overrides: Partial<AgentProfileDeps> = {}) {
  const app = Fastify();
  registerAgentProfileRoutes(app, depsDeEscritura(overrides));
  await app.ready();
  abierto = app;
  return app;
}

describe('PUT perfil: desired durable + ACK runtime', () => {
  it('sólo responde applied cuando CAS, lote completo y applied_revision coinciden', async () => {
    const replaceProfile = vi.fn(REPLACE_PROFILE);
    const markProfileApplied = vi.fn(MARK_PROFILE_APPLIED);
    const app = await appDeEscritura({ replaceProfile, markProfileApplied });

    const res = await app.inject({
      method: 'PUT', url: RUTA,
      payload: { expected_revision: 1, profile: PERFIL_BODY },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true, state: 'applied', revision: 2, applied_revision: 2,
      acknowledgements: [{ name: 'AGENTS.md', sha: sha('nuevo'), bytes: 5 }],
    });
    expect(replaceProfile).toHaveBeenCalledWith(expect.objectContaining(PERFIL_BODY), 1, ACTOR);
    expect(markProfileApplied).toHaveBeenCalledWith('Steven', 'zeus', 2, ACTOR);
  });

  it('un ACK parcial deja desired pendiente y nunca llama markApplied', async () => {
    const markProfileApplied = vi.fn(MARK_PROFILE_APPLIED);
    const app = await appDeEscritura({
      prepareRuntime: async () => ({
        documents: ['AGENTS.md', 'TOOLS.md'],
        apply: async () => ([{
          name: 'AGENTS.md', path: '/workspace/AGENTS.md', state: 'written',
          sha: sha('x'), bytes: 1,
        }]),
      }),
      markProfileApplied,
    });

    const res = await app.inject({
      method: 'PUT', url: RUTA,
      payload: { expected_revision: 1, profile: PERFIL_BODY },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: 'runtime_ack_incomplete', state: 'pending', revision: 2, applied_revision: 1,
    });
    expect(markProfileApplied).not.toHaveBeenCalled();
  });

  it('si falla el preflight no persiste desired ni toca runtime', async () => {
    const replaceProfile = vi.fn(REPLACE_PROFILE);
    const app = await appDeEscritura({
      prepareRuntime: async () => {
        throw Object.assign(new Error('el fichero llegó truncado'), { code: 'truncated' });
      },
      replaceProfile,
    });
    const res = await app.inject({
      method: 'PUT', url: RUTA,
      payload: { expected_revision: 1, profile: PERFIL_BODY },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'truncated', revision: 1, applied_revision: 1 });
    expect(replaceProfile).not.toHaveBeenCalled();
  });

  it('si el lote falla después del CAS conserva desired pendiente y no afirma éxito', async () => {
    const markProfileApplied = vi.fn(MARK_PROFILE_APPLIED);
    const app = await appDeEscritura({
      prepareRuntime: async () => ({
        documents: ['AGENTS.md'],
        apply: async () => {
          throw Object.assign(new Error('rollback completo del lote'), { code: 'conflict' });
        },
      }),
      markProfileApplied,
    });
    const res = await app.inject({
      method: 'PUT', url: RUTA,
      payload: { expected_revision: 1, profile: PERFIL_BODY },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ state: 'pending', revision: 2, applied_revision: 1 });
    expect(markProfileApplied).not.toHaveBeenCalled();
  });

  it('una revisión desired nueva después del ACK devuelve conflicto aunque registra el ACK viejo', async () => {
    const app = await appDeEscritura({
      markProfileApplied: async () => ({
        perfil: contexto({ ...PERFIL_BODY, purpose: 'más nuevo' }, 'codex').perfil,
        exists: true, revision: 3, applied_revision: 2,
      }),
    });
    const res = await app.inject({
      method: 'PUT', url: RUTA,
      payload: { expected_revision: 1, profile: PERFIL_BODY },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'profile_superseded_after_runtime_ack', state: 'pending',
      revision: 3, applied_revision: 2,
    });
  });

  it('un desired pendiente se puede reintentar idempotentemente con su misma revisión', async () => {
    const replaceProfile = vi.fn<NonNullable<AgentProfileDeps['replaceProfile']>>(async (profile) => ({
      perfil: profile, exists: true, revision: 2, applied_revision: 1,
    }));
    const app = await appDeEscritura({
      readContext: async () => ({
        contexto: contexto(PERFIL_BODY, 'codex'), exists: true,
        revision: 2, applied_revision: 1,
      }),
      replaceProfile,
    });
    const res = await app.inject({
      method: 'PUT', url: RUTA,
      payload: { expected_revision: 2, profile: PERFIL_BODY },
    });
    expect(res.statusCode).toBe(200);
    expect(replaceProfile).toHaveBeenCalledWith(expect.objectContaining(PERFIL_BODY), 2, ACTOR);
  });

  it('alias disabled falla antes de preflight, CAS o disco', async () => {
    const prepareRuntime = vi.fn(PREPARE_RUNTIME);
    const replaceProfile = vi.fn(REPLACE_PROFILE);
    const app = await appDeEscritura({
      authorizeTarget: async () => ({ tenant_id: 'Steven', alias: 'zeus', enabled: false }),
      prepareRuntime,
      replaceProfile,
    });
    const res = await app.inject({
      method: 'PUT', url: RUTA,
      payload: { expected_revision: 1, profile: PERFIL_BODY },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'agent_disabled' });
    expect(prepareRuntime).not.toHaveBeenCalled();
    expect(replaceProfile).not.toHaveBeenCalled();
  });

  it('el tenant objetivo del PUT viene de la ruta canónica, nunca del actor', async () => {
    const autorizado = vi.fn(async () => ({ tenant_id: 'Miguel', alias: 'kant', enabled: true }));
    const ctx = contexto(PERFIL_BODY, 'codex');
    const perfilMiguel = { ...ctx.perfil, tenant_id: 'Miguel', alias: 'kant' };
    const app = await appDeEscritura({
      authorizeTarget: autorizado,
      readContext: async () => ({
        contexto: { ...ctx, perfil: perfilMiguel }, exists: true, revision: 1, applied_revision: 1,
      }),
      replaceProfile: async () => ({
        perfil: perfilMiguel, exists: true, revision: 2, applied_revision: 1,
      }),
      markProfileApplied: async () => ({
        perfil: perfilMiguel, exists: true, revision: 2, applied_revision: 2,
      }),
    });
    const res = await app.inject({
      method: 'PUT', url: '/v3/console/tenants/Miguel/agents/kant/perfil',
      payload: { expected_revision: 1, profile: PERFIL_BODY },
    });
    expect(res.statusCode).toBe(200);
    expect(autorizado).toHaveBeenCalledWith(ACTOR, 'Miguel', 'kant', 'control', false);
  });
});
