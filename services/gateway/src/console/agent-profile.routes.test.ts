import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { marcaDeRevisionDelPerfil, TOPES_OPENCLAW, type ContextoDeAlias } from '@cauce/protocol';
import {
  registerAgentProfileRoutes, type AgentProfileDeps, type RespuestaDelPerfil,
} from './agent-profile.routes.js';

/**
 *
 * The value of this route is not returning JSON: it is that what it shows is, byte for byte,
 * what will end up written in the container. Everything tested here defends that property,
 * plus the two things the route cannot know and must say instead of keeping silent.
 */

const RUTA = '/v3/console/tenants/Steven/agents/zeus/perfil';

import {
  ACTOR, contexto, MARK_PROFILE_APPLIED, PERFIL_BODY, PREPARE_RUNTIME, preparedRuntime,
  REPLACE_PROFILE, RUNTIME_ADOPTION, RUNTIME_VERIFICATION, runtimePreflight, sha,
} from './agent-profile.fixtures.js';
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
     * It is not order: it is the difference between teaching a model who it is and what it does.
     * A `SOUL.md` that talks about tasks teaches it that its identity is its tasks.
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
     * Overwriting them means erasing a colleague's memory, and from inside the container there
     * is no way back. The policy has to travel in the response so the screen can say it.
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
    * Revoking a permission or changing a destination does not change the authored profile
    * revision. If this view materialised them, the disk could keep asserting a power already revoked.
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
     * The gateway does not read the container disk. Saying "this is how the file ends up" on a
     * measurement that was not taken is the kind of lie that costs a deployment: someone looks
     * at the preview, does not see their hand-written manual, and concludes it was erased.
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

  it('un perfil vacío sólo proyecta identidad y revisión, nunca encabezados autorados huecos', async () => {
    abierto = await servidor(contexto({}, 'claude'));
    const ficheros = (await abierto.inject({
      method: 'GET', url: RUTA
    })).json<RespuestaDelPerfil>().ficheros;
    expect(ficheros[0]?.texto).toContain(marcaDeRevisionDelPerfil(1));
    expect(ficheros[0]?.texto).toContain('<!-- alias: Steven/zeus -->');
    expect(ficheros[0]?.texto).not.toMatch(/^## /mu);
  });
});

describe('los topes del arnés se contestan con los dos números, no con un 500', () => {
  it('un openclaw pasado de tope sigue devolviendo el perfil y dice QUÉ fichero y cuánto mide', async () => {
    abierto = await servidor(contexto({ purpose: 'x'.repeat(60_001) }, 'openclaw'));
    const res = await abierto.inject({ method: 'GET', url: RUTA });
    expect(res.statusCode).toBe(200);
    const cuerpo = res.json<RespuestaDelPerfil>();
    expect(cuerpo.perfil.purpose).toHaveLength(60_001);
    expect(cuerpo.ficheros).toEqual([]);
    expect(cuerpo.runtime_verification?.state).toBe('unverified');
    const motivo = cuerpo.runtime_verification?.reason ?? '';
    expect(motivo).toContain('SOUL.md');
    expect(motivo).toContain('unidades UTF-16');
    expect(motivo).toContain(String(TOPES_OPENCLAW.porFichero));
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
    readRuntimeAdoption: RUNTIME_ADOPTION,
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

describe('GET perfil: convergencia medida del runtime', () => {
  it('sólo marca applied con revisión durable igual y ruta+SHA+generación actuales', async () => {
    const app = await appDeEscritura();

    const body = (await app.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();

    expect(body).toMatchObject({
      runtime_state: 'applied', harness: 'codex', base: 'runtime-medido',
      runtime_verification: { state: 'current', generation: 'gen-1', container_id: 'ws-zeus' },
      ficheros: [{ nombre: 'AGENTS.md', texto: 'nuevo' }],
    });
  });

  it('misma revisión con bytes distintos se declara drifted, nunca applied', async () => {
    const app = await appDeEscritura({
      prepareRuntime: async () => runtimePreflight((revision) => preparedRuntime(revision, {
        verification: {
          ...RUNTIME_VERIFICATION,
          state: 'drifted',
          documents: RUNTIME_VERIFICATION.documents.map((document) => ({
            ...document, observed_sha: sha('edición directa'), current: false,
          })),
        },
      })),
    });

    const body = (await app.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();

    expect(body.runtime_state).toBe('drifted');
    expect(body.runtime_verification?.documents[0]).toMatchObject({ current: false });
  });

  it('ruta+SHA actuales sin ACK de la TUI quedan pending_session_refresh', async () => {
    const app = await appDeEscritura({ readRuntimeAdoption: async () => undefined });

    const body = (await app.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();

    expect(body).toMatchObject({
      runtime_state: 'pending_session_refresh',
      runtime_verification: { state: 'current', generation: 'gen-1' },
      runtime_adoption: null,
    });
  });

  it('leer el perfil no escribe la expectativa: sólo la consulta la adopción', async () => {
    const recordRuntimeExpectation = vi.fn(async () => undefined);
    const readRuntimeAdoption = vi.fn(RUNTIME_ADOPTION);
    const app = await appDeEscritura({ recordRuntimeExpectation, readRuntimeAdoption });

    const res = await app.inject({ method: 'GET', url: RUTA });

    expect(res.statusCode).toBe(200);
    expect(res.json<RespuestaDelPerfil>().runtime_state).toBe('applied');
    expect(recordRuntimeExpectation).not.toHaveBeenCalled();
    expect(readRuntimeAdoption).toHaveBeenCalledWith(
      'Steven', 'zeus', 1, expect.objectContaining({ state: 'current', generation: 'gen-1' }),
    );
  });

  it('el PUT sigue siendo el que registra la expectativa, después del ACK del lote', async () => {
    const recordRuntimeExpectation = vi.fn(async () => undefined);
    const app = await appDeEscritura({ recordRuntimeExpectation });

    const res = await app.inject({
      method: 'PUT', url: RUTA, payload: { expected_revision: 1, profile: PERFIL_BODY },
    });

    expect(res.statusCode).toBe(200);
    expect(recordRuntimeExpectation).toHaveBeenCalledWith(
      'Steven', 'zeus', 2, expect.objectContaining({ state: 'current', generation: 'gen-1' }),
    );
  });

  it('desired nueva ya escrita sigue pending_session_refresh hasta que la TUI la adopta', async () => {
    const readRuntimeAdoption = vi.fn(async () => undefined);
    const app = await appDeEscritura({
      readContext: async () => ({
        contexto: contexto(PERFIL_BODY, 'codex'), exists: true,
        revision: 2, applied_revision: 1,
      }),
      readRuntimeAdoption,
    });

    const body = (await app.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();

    expect(body.runtime_state).toBe('pending_session_refresh');
    expect(readRuntimeAdoption).toHaveBeenCalledWith(
      'Steven', 'zeus', 2, expect.objectContaining({ state: 'current', generation: 'gen-1' }),
    );
  });

  it('ACK de sesión con applied_revision aún atrasada queda pending durable, no applied', async () => {
    const app = await appDeEscritura({
      readContext: async () => ({
        contexto: contexto(PERFIL_BODY, 'codex'), exists: true,
        revision: 2, applied_revision: 1,
      }),
    });

    const body = (await app.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();

    expect(body).toMatchObject({
      runtime_state: 'pending', revision: 2, applied_revision: 1,
      runtime_adoption: { evidence: 'adapter_delivery', revision: 2, generation: 'gen-1' },
    });
  });

  it('sin sonda de generación expone runtime_unverified y vista no medida', async () => {
    const deps = depsDeEscritura();
    delete deps.prepareRuntime;
    const app = Fastify();
    registerAgentProfileRoutes(app, deps);
    await app.ready();
    abierto = app;

    const body = (await app.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();

    expect(body).toMatchObject({
      runtime_state: 'runtime_unverified', runtime_verification: null, base: 'fichero-vacio',
    });
  });

  it('el arnés y la vista vienen del runtime medido, no de la columna declarada', async () => {
    const app = await appDeEscritura({
      prepareRuntime: async () => runtimePreflight((revision) => preparedRuntime(revision, {
        documents: ['CLAUDE.md'], harness: 'claude',
        preview: [{ nombre: 'CLAUDE.md', politica: 'bloque-gestionado', texto: 'medido', unidades: 6 }],
        verification: {
          ...RUNTIME_VERIFICATION,
          documents: [{
            ...(RUNTIME_VERIFICATION.documents[0]
              ?? expect.unreachable('Runtime verification document is missing')),
            name: 'CLAUDE.md', path: '/home/dev/.claude/CLAUDE.md',
          }],
        },
        apply: async () => [],
      }), 'claude'),
    });

    const body = (await app.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();

    expect(body).toMatchObject({
      harness: 'claude', base: 'runtime-medido',
      ficheros: [{ nombre: 'CLAUDE.md', texto: 'medido' }],
    });
  });
});

describe('PUT perfil: desired durable + ACK runtime', () => {
  it('sólo responde applied cuando CAS, lote completo y applied_revision coinciden', async () => {
    const replaceProfile = vi.fn(REPLACE_PROFILE);
    const readRuntimeAdoption = vi.fn(RUNTIME_ADOPTION);
    const markProfileApplied = vi.fn(MARK_PROFILE_APPLIED);
    const app = await appDeEscritura({ replaceProfile, readRuntimeAdoption, markProfileApplied });

    const res = await app.inject({
      method: 'PUT', url: RUTA,
      payload: { expected_revision: 1, profile: PERFIL_BODY },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true, state: 'applied', revision: 2, applied_revision: 2,
      acknowledgements: [{ name: 'AGENTS.md', sha: sha('nuevo'), bytes: 5 }],
      runtime_adoption: {
        evidence: 'adapter_delivery', revision: 2, generation: 'gen-1',
      },
    });
    expect(replaceProfile).toHaveBeenCalledWith(expect.objectContaining(PERFIL_BODY), 1, ACTOR);
    expect(readRuntimeAdoption).toHaveBeenCalledWith(
      'Steven', 'zeus', 2, expect.objectContaining({ state: 'current', generation: 'gen-1' }),
    );
    expect(markProfileApplied).toHaveBeenCalledWith('Steven', 'zeus', 2, ACTOR);
    expect(readRuntimeAdoption.mock.invocationCallOrder[0])
      .toBeLessThan(markProfileApplied.mock.invocationCallOrder[0]
        ?? expect.unreachable('Applied revision was not marked'));
  });

  it('un ACK de escritura sin adopción de sesión responde 202 y no marca applied', async () => {
    const markProfileApplied = vi.fn(MARK_PROFILE_APPLIED);
    const app = await appDeEscritura({
      readRuntimeAdoption: async () => undefined,
      markProfileApplied,
    });

    const res = await app.inject({
      method: 'PUT', url: RUTA,
      payload: { expected_revision: 1, profile: PERFIL_BODY },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      ok: true, state: 'pending_session_refresh', revision: 2, applied_revision: 1,
      runtime_verification: { state: 'current', generation: 'gen-1' },
      runtime_adoption: null,
    });
    expect(markProfileApplied).not.toHaveBeenCalled();
  });

  it('si no puede registrar la expectativa después del lote, conserva desired y no acredita adopción', async () => {
    const readRuntimeAdoption = vi.fn(RUNTIME_ADOPTION);
    const markProfileApplied = vi.fn(MARK_PROFILE_APPLIED);
    const app = await appDeEscritura({
      recordRuntimeExpectation: async () => {
        throw Object.assign(new Error('la revisión cambió durante el lote'), { code: 'conflict' });
      },
      readRuntimeAdoption,
      markProfileApplied,
    });

    const res = await app.inject({
      method: 'PUT', url: RUTA,
      payload: { expected_revision: 1, profile: PERFIL_BODY },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'conflict', state: 'pending', revision: 2, applied_revision: 1,
      acknowledgements: [{ name: 'AGENTS.md', generation: 'gen-1' }],
    });
    expect(readRuntimeAdoption).not.toHaveBeenCalled();
    expect(markProfileApplied).not.toHaveBeenCalled();
  });

  it('un ACK parcial deja desired pendiente y nunca llama markApplied', async () => {
    const markProfileApplied = vi.fn(MARK_PROFILE_APPLIED);
    const app = await appDeEscritura({
      prepareRuntime: async () => runtimePreflight((revision) => preparedRuntime(revision, {
        documents: ['AGENTS.md', 'TOOLS.md'],
        preview: [],
        verification: {
          ...RUNTIME_VERIFICATION,
          documents: [
            ...RUNTIME_VERIFICATION.documents,
            {
              name: 'TOOLS.md', path: '/workspace/TOOLS.md',
              expected_sha: sha('y'), observed_sha: null,
              expected_bytes: 1, observed_bytes: null, current: false,
            },
          ],
        },
        apply: async () => ([{
          name: 'AGENTS.md', path: '/workspace/AGENTS.md', state: 'written',
          sha: sha('x'), bytes: 1, generation: 'gen-1', container_id: 'ws-zeus',
        }]),
      })),
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
      prepareRuntime: async () => runtimePreflight((revision) => preparedRuntime(revision, {
        preview: [],
        apply: async () => {
          throw Object.assign(new Error('rollback completo del lote'), { code: 'conflict' });
        },
      })),
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

  it('el PUT distingue «no lo controlas» de «no existe», y solo cuando ya acredito lectura', async () => {
    const prepareRuntime = vi.fn(PREPARE_RUNTIME);
    const replaceProfile = vi.fn(REPLACE_PROFILE);
    const permisos: string[] = [];
    const conLectura = await appDeEscritura({
      authorizeTarget: async (_actor, tenantId, alias, permiso) => {
        permisos.push(permiso);
        return permiso === 'read' ? { tenant_id: tenantId, alias, enabled: true } : undefined;
      },
      prepareRuntime,
      replaceProfile,
    });
    const cuerpo = { expected_revision: 1, profile: PERFIL_BODY };
    const visible = await conLectura.inject({ method: 'PUT', url: RUTA, payload: cuerpo });
    expect(visible.statusCode).toBe(403);
    expect(visible.json()).toMatchObject({ error: 'forbidden' });
    expect(visible.json<{ message: string }>().message).toMatch(/no tiene permiso de control/u);
    expect(permisos).toEqual(['control', 'read']);
    expect(prepareRuntime).not.toHaveBeenCalled();
    expect(replaceProfile).not.toHaveBeenCalled();

    // Control negativo: sin control NI lectura sigue siendo 404, que es lo que impide usar esta
    // url como sonda de existencia entre tenants.
    const invisible = await appDeEscritura({ authorizeTarget: async () => undefined });
    const oculto = await invisible.inject({ method: 'PUT', url: RUTA, payload: cuerpo });
    expect(oculto.statusCode).toBe(404);
    expect(oculto.json()).toMatchObject({ error: 'not_found' });
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

describe('GET perfil: una adopción que no coincide nunca puede decir applied', () => {
  type Adopcion = NonNullable<Awaited<ReturnType<NonNullable<AgentProfileDeps['readRuntimeAdoption']>>>>;

  const adopcionParcheada = (
    parche: Record<string, unknown>,
  ): NonNullable<AgentProfileDeps['readRuntimeAdoption']> =>
    async (tenant, alias, revision, verification) => ({
      ...await RUNTIME_ADOPTION(tenant, alias, revision, verification),
      ...parche,
    } as Adopcion);

  it.each([
    ['la evidencia no es una entrega del adaptador', { evidence: 'consola_lo_supuso' }],
    ['la generación del contenedor es otra', { generation: 'gen-vieja' }],
    ['el adopted_at no es una fecha', { adopted_at: 'ayer por la tarde' }],
    ['la revisión adoptada no es la durable', { revision: 99 }],
    ['no se adoptaron todos los documentos', { documents: [] }],
  ])('deja el estado en pending_session_refresh cuando %s', async (_caso, parche) => {
    const app = await appDeEscritura({ readRuntimeAdoption: adopcionParcheada(parche) });

    const body = (await app.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();

    expect(body.runtime_state).toBe('pending_session_refresh');
    expect(body.runtime_adoption).toBeNull();
  });
});
