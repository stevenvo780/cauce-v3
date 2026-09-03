import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextoDeAlias } from '@cauce/protocol';
import {
  registerAgentProfileRoutes, type AgentProfileDeps,
  type RespuestaDelPerfil, type TopeSuperado,
} from './agent-profile.routes.js';
import { ACTOR, contexto, PERFIL_BODY, REPLACE_PROFILE } from './agent-profile.fixtures.js';

const RUTA = '/v3/console/tenants/Steven/agents/zeus/perfil';
const MOTIVO = 'recorto el perfil para que entre en el tope del arnés';

let abierto: FastifyInstance | undefined;

afterEach(async () => {
  await abierto?.close();
  abierto = undefined;
});

describe('la vista previa y la siembra no pueden discrepar', () => {
  function contextoAcentuadoAlTope(): ContextoDeAlias {
    const acento = '\u00e1';
    return contexto({
      purpose: acento.repeat(2_000),
      role_summary: acento.repeat(4_000),
      human_brief: acento.repeat(2_000),
      responsibilities: Array.from({ length: 8 }, () => acento.repeat(1_000)),
      restrictions: Array.from({ length: 4 }, () => acento.repeat(1_000)),
      tools: [],
      operating_rules: Array.from({ length: 4 }, () => acento.repeat(1_000)),
    }, 'codex');
  }

  async function conPreflight(
    ctx: ContextoDeAlias, preflight: AgentProfileDeps['prepareRuntime'],
  ) {
    const app = Fastify();
    registerAgentProfileRoutes(app, {
      authorize: async () => ACTOR,
    recordAudit: async () => undefined,
    resolveOperator: () => ({ operator_id: 'steven@elenxos', attributed: true }),
      authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias, enabled: true }),
      readContext: async () => ({ contexto: ctx, exists: true, revision: 1, applied_revision: 1 }),
      ...(preflight === undefined ? {} : { prepareRuntime: preflight }),
    });
    await app.ready();
    abierto = app;
    return app;
  }

  it('compone sobre los BYTES medidos del contenedor, no sobre un fichero imaginado', async () => {
    const app = await conPreflight(contexto({ purpose: 'x' }, 'codex'), async () => ({
      harness: 'codex',
      topes: { unit: 'utf8_bytes', porFichero: 65_536, fuente: 'measured' },
      existentes: new Map([['AGENTS.md', '# manual escrito a mano\n']]),
      materialize: () => { throw new Error('la generación medida cambió'); },
    }));

    const body = (await app.inject({ method: 'GET', url: RUTA })).json<RespuestaDelPerfil>();

    expect(body.base).toBe('runtime-medido');
    expect(body.ficheros[0]?.texto).toContain('# manual escrito a mano');
  });

  it('el tope medido del alias llega a la vista previa: 48 kB acentuados entran con 65 536', async () => {
    const app = await conPreflight(contextoAcentuadoAlTope(), async () => ({
      harness: 'codex',
      topes: { unit: 'utf8_bytes', porFichero: 65_536, fuente: 'measured' },
      existentes: new Map(),
      materialize: () => { throw new Error('la generación medida cambió'); },
    }));

    const res = await app.inject({ method: 'GET', url: RUTA });

    expect(res.statusCode).toBe(200);
    const texto = res.json<RespuestaDelPerfil>().ficheros[0]?.texto ?? '';
    expect(Buffer.byteLength(texto, 'utf8')).toBeGreaterThan(48_000);
  });

  it('sin hecho medido rige el DEFECTO y el GET deja editar diciendo unidad, origen y números', async () => {
    const app = await conPreflight(contextoAcentuadoAlTope(), undefined);

    const res = await app.inject({ method: 'GET', url: RUTA });

    expect(res.statusCode).toBe(200);
    const cuerpo = res.json<RespuestaDelPerfil>();
    expect(cuerpo.perfil.purpose).toMatch(/\u00e1/u);
    expect(cuerpo.ficheros).toEqual([]);
    expect(cuerpo.runtime_verification?.state).toBe('unverified');
    const motivo = cuerpo.runtime_verification?.reason ?? '';
    expect(motivo).toContain('AGENTS.md');
    expect(motivo).toContain('bytes UTF-8');
    expect(motivo).toContain('por defecto del arn\u00e9s');
    expect(motivo).toContain(String(32 * 1_024));
    expect(cuerpo.runtime_reason).toBe(motivo);
    expect(cuerpo.aviso ?? '').toContain(String(32 * 1_024));
  });

  it('un preflight que ya rechazó por tope no se contesta con una vista previa verde', async () => {
    const app = await conPreflight(contexto({ purpose: 'x' }, 'codex'), async () => {
      throw Object.assign(
        new Error('AGENTS.md mide 70000 bytes UTF-8 y el tope por fichero es 65536 (tope medido del alias)'),
        {
          code: 'too_large',
          cause: Object.assign(new Error('tope'), {
            name: 'ErrorDeTopeDelArnes', fichero: 'AGENTS.md', medido: 70_000, tope: 65_536,
          }),
        },
      );
    });

    const res = await app.inject({ method: 'GET', url: RUTA });

    expect(res.statusCode).toBe(200);
    const cuerpo = res.json<RespuestaDelPerfil>();
    expect(cuerpo.ficheros).toEqual([]);
    expect(cuerpo.runtime_verification).toMatchObject({ state: 'unverified', documents: [] });
    const motivo = cuerpo.runtime_verification?.reason ?? '';
    expect(motivo).toContain('70000');
    expect(motivo).toContain('65536');
    expect(motivo).toContain('tope medido del alias');
  });

  it('el PUT sigue negándose con 422 ANTES del CAS durable', async () => {
    const replaceProfile = vi.fn(REPLACE_PROFILE);
    const app = Fastify();
    registerAgentProfileRoutes(app, {
      authorize: async () => ACTOR,
    recordAudit: async () => undefined,
    resolveOperator: () => ({ operator_id: 'steven@elenxos', attributed: true }),
      authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias, enabled: true }),
      readContext: async () => ({
        contexto: contexto({ purpose: 'x' }, 'codex'), exists: true, revision: 1, applied_revision: 1,
      }),
      replaceProfile,
      prepareRuntime: async () => {
        throw Object.assign(
          new Error('AGENTS.md mide 70000 bytes UTF-8 y el tope por fichero es 65536 (tope medido del alias)'),
          {
            code: 'too_large',
            cause: Object.assign(new Error('tope'), {
              name: 'ErrorDeTopeDelArnes', fichero: 'AGENTS.md', medido: 70_000, tope: 65_536,
            }),
          },
        );
      },
    });
    await app.ready();
    abierto = app;

    const res = await app.inject({
      method: 'PUT', url: RUTA, payload: { expected_revision: 1, profile: PERFIL_BODY, reason: MOTIVO },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<TopeSuperado>()).toMatchObject({
      error: 'tope_del_arnes', fichero: 'AGENTS.md', medido: 70_000, tope: 65_536,
    });
    expect(res.json<TopeSuperado>().message).toContain('tope medido del alias');
    expect(replaceProfile).not.toHaveBeenCalled();
  });
});
