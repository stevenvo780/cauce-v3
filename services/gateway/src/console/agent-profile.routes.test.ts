import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ContextoDeAlias } from '@cauce/protocol';
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
const OPERADOR = { operator_id: 'steven@elenxos', attributed: true };
const MOTIVO = 'recorto las responsabilidades que ya no le tocan';

import {
  profileWriteFixtureDeps, ACTOR, contexto, MARK_PROFILE_APPLIED, PERFIL_BODY, preparedRuntime,
  REPLACE_PROFILE, RUNTIME_ADOPTION, RUNTIME_VERIFICATION, runtimePreflight, sha,
} from './agent-profile.fixtures.js';
async function servidor(ctx: ContextoDeAlias | (() => Promise<never>), exists = true) {
  const app = Fastify();
  registerAgentProfileRoutes(app, {
    authorize: async () => ACTOR,
    recordAudit: async () => undefined,
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

  it('openclaw recibe los SIETE, en el orden medido en la flota', async () => {
    abierto = await servidor(contexto({ purpose: 'x' }, 'openclaw'));
    const res = await abierto.inject({ method: 'GET', url: RUTA });
    expect(res.json<RespuestaDelPerfil>().ficheros.map((f) => f.nombre)).toEqual([
      'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md', 'AGENTS.md', 'TOOLS.md'
    ]);
  });
});

describe('el reparto de openclaw pone cada cara donde toca', () => {

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
});

describe('identidad canónica, autorización y presencia de fila', () => {

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
      recordAudit: async () => undefined,
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

  it('falla cerrado si el store devuelve un perfil de otra identidad', async () => {
    const app = Fastify();
    const base = contexto({}, 'codex');
    registerAgentProfileRoutes(app, {
      authorize: async () => ACTOR,
      recordAudit: async () => undefined,
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
      recordAudit: async () => undefined,
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
});

function depsDeEscritura(overrides: Partial<AgentProfileDeps> = {}): AgentProfileDeps {
  return profileWriteFixtureDeps(overrides, OPERADOR);
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
});

describe('PUT perfil: desired durable + ACK runtime', () => {

  it('sólo responde applied cuando CAS, lote completo y applied_revision coinciden', async () => {
    const replaceProfile = vi.fn(REPLACE_PROFILE);
    const readRuntimeAdoption = vi.fn(RUNTIME_ADOPTION);
    const markProfileApplied = vi.fn(MARK_PROFILE_APPLIED);
    const app = await appDeEscritura({ replaceProfile, readRuntimeAdoption, markProfileApplied });

    const res = await app.inject({
      method: 'PUT', url: RUTA,
      payload: { expected_revision: 1, profile: PERFIL_BODY, reason: MOTIVO },
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
      payload: { expected_revision: 1, profile: PERFIL_BODY, reason: MOTIVO },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      ok: true, state: 'pending_session_refresh', revision: 2, applied_revision: 1,
      runtime_verification: { state: 'current', generation: 'gen-1' },
      runtime_adoption: null,
    });
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
      payload: { expected_revision: 1, profile: PERFIL_BODY, reason: MOTIVO },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: 'profile_write_unconfirmed', state: 'effect_unknown', revision: 2, applied_revision: 1,
    });
    expect(res.json<{ operation_id: string }>().operation_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(res.json()).not.toHaveProperty('ok', true);
    expect(markProfileApplied).not.toHaveBeenCalled();
  });

  it('el tenant objetivo del PUT viene de la ruta canónica, nunca del actor', async () => {
    const autorizado = vi.fn(async () => ({ tenant_id: 'Miguel', alias: 'kant', enabled: true }));
    const ctx = contexto({ ...PERFIL_BODY, purpose: 'prior purpose' }, 'codex');
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
      payload: { expected_revision: 1, profile: PERFIL_BODY, reason: MOTIVO },
    });
    expect(res.statusCode).toBe(200);
    expect(autorizado).toHaveBeenCalledWith(ACTOR, 'Miguel', 'kant', 'control', false);
  });
});
