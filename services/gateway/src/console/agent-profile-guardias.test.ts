import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO, type ContextoDeAlias } from '@cauce/protocol';
import type { AgentFactsProbe, TerminalAuditEntry } from './agent-documents.routes.js';
import type { RuntimeFacts } from './agent-documents.js';
import { medirContextoDeGobierno } from './agent-context-reload.routes.js';
import { ContextContaminationTelemetry } from './contaminacion-de-contexto.js';
import { prepareAgentProfileRuntime } from './agent-profile-runtime.js';
import {
  registerAgentProfileRoutes, type AgentProfileDeps, type RespuestaDelPerfil,
} from './agent-profile.routes.js';
import {
  ACTOR, MARK_PROFILE_APPLIED, PERFIL_BODY, PREPARE_RUNTIME, REPLACE_PROFILE, RUNTIME_ADOPTION,
  contexto,
} from './agent-profile.fixtures.js';

/**
 * The profile PUT writes into somebody's HOME, so it answers to the same four gates the document
 * PUT next door already answers to: a named person, a hand-typed reason, the contamination guard
 * and an audit row. What is asserted here is the ORDER they impose on the store: nothing durable
 * may be touched before all four have passed.
 */

const RUTA = '/v3/console/tenants/Steven/agents/zeus/perfil';
const OPERADOR = { operator_id: 'steven@elenxos', attributed: true };
const MOTIVO = 'recorto las responsabilidades que ya no le tocan';
const CUERPO = { expected_revision: 1, profile: PERFIL_BODY, reason: MOTIVO };

let abierto: FastifyInstance | undefined;
afterEach(async () => { await abierto?.close(); abierto = undefined; });

async function servidor(overrides: Partial<AgentProfileDeps> = {}, sinOperador = false) {
  const auditoria: TerminalAuditEntry[] = [];
  const replaceProfile = vi.fn(REPLACE_PROFILE);
  const prepareRuntime = vi.fn(PREPARE_RUNTIME);
  const app = Fastify();
  const deps: AgentProfileDeps = {
    authorize: async () => ACTOR,
    authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias, enabled: true }),
    readContext: async () => ({
      contexto: contexto(PERFIL_BODY, 'codex'), exists: true, revision: 1, applied_revision: 1,
    }),
    resolveOperator: () => OPERADOR,
    recordAudit: async (entry) => { auditoria.push(entry); },
    replaceProfile,
    prepareRuntime,
    readRuntimeAdoption: RUNTIME_ADOPTION,
    markProfileApplied: MARK_PROFILE_APPLIED,
    ...overrides,
  };
  if (sinOperador) delete deps.resolveOperator;
  registerAgentProfileRoutes(app, deps);
  await app.ready();
  abierto = app;
  return { app, auditoria, replaceProfile, prepareRuntime };
}

describe('la persona con nombre es la primera compuerta del PUT', () => {
  it('una sesión sin persona recibe 403 y no toca la base', async () => {
    const montado = await servidor({ resolveOperator: () => ({ operator_id: 'sin-persona', attributed: false }) });

    const res = await montado.app.inject({ method: 'PUT', url: RUTA, payload: CUERPO });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'forbidden', reason: 'writable_requires_attribution',
    });
    expect(montado.replaceProfile).not.toHaveBeenCalled();
    expect(montado.prepareRuntime).not.toHaveBeenCalled();
    expect(montado.auditoria).toHaveLength(1);
    expect(montado.auditoria[0]).toMatchObject({
      action: 'agent_document.denied', decision: 'deny',
    });
    expect(montado.auditoria[0]?.metadata).toMatchObject({
      attributed: false, reason: 'forbidden', operation: 'profile_write',
    });
  });

  it('sin resolveOperator cableado el gateway falla cerrado, no abierto', async () => {
    const montado = await servidor({}, true);

    const res = await montado.app.inject({ method: 'PUT', url: RUTA, payload: CUERPO });

    expect(res.statusCode).toBe(403);
    expect(montado.replaceProfile).not.toHaveBeenCalled();
  });

  it('la falta de persona se decide ANTES que el estado del alias', async () => {
    const montado = await servidor({
      resolveOperator: () => ({ operator_id: 'sin-persona', attributed: false }),
      authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias, enabled: false }),
    });

    const res = await montado.app.inject({ method: 'PUT', url: RUTA, payload: CUERPO });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ reason: string }>().reason).toBe('writable_requires_attribution');
  });

  it('CONTROL NEGATIVO: con persona el mismo cuerpo llega hasta el final', async () => {
    const montado = await servidor();

    const res = await montado.app.inject({ method: 'PUT', url: RUTA, payload: CUERPO });

    expect(res.statusCode).toBe(200);
    expect(montado.replaceProfile).toHaveBeenCalledTimes(1);
  });
});

describe('el motivo escrito a mano', () => {
  it('un PUT sin `reason` es 400 con el campo, y no persiste nada', async () => {
    const montado = await servidor();

    const res = await montado.app.inject({
      method: 'PUT', url: RUTA, payload: { expected_revision: 1, profile: PERFIL_BODY },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_input', field: 'reason' });
    expect(montado.replaceProfile).not.toHaveBeenCalled();
    expect(montado.prepareRuntime).not.toHaveBeenCalled();
    expect(montado.auditoria[0]?.metadata).toMatchObject({ operator_reason: null });
  });

  it('un motivo demasiado corto se rechaza igual que en la escritura de un documento', async () => {
    const montado = await servidor();

    const res = await montado.app.inject({
      method: 'PUT', url: RUTA, payload: { ...CUERPO, reason: 'corto' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ field: string }>().field).toBe('reason');
    expect(montado.replaceProfile).not.toHaveBeenCalled();
  });
});

describe('la fila de auditoría del perfil', () => {
  it('un PUT aceptado deja exactamente una fila `agent_profile.write` sin cuerpos de campo', async () => {
    const montado = await servidor();

    const res = await montado.app.inject({ method: 'PUT', url: RUTA, payload: CUERPO });

    expect(res.statusCode).toBe(200);
    const escrituras = montado.auditoria.filter((fila) => fila.decision === 'allow');
    expect(escrituras).toHaveLength(1);
    expect(escrituras[0]).toMatchObject({
      tenant_id: 'Steven', actor_alias: 'zeus', action: 'agent_profile.write', decision: 'allow',
    });
    expect(escrituras[0]?.metadata).toMatchObject({
      operator_id: 'steven@elenxos', attributed: true, operator_reason: MOTIVO,
      target_tenant: 'Steven', target_alias: 'zeus', revision: 2,
    });
    expect(escrituras[0]?.metadata.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(escrituras[0]?.metadata)).not.toContain('coordinar la flota');
    expect(montado.auditoria.filter((fila) => fila.decision === 'deny')).toHaveLength(0);
  });

  it('una negativa por CAS deja fila denegada y ninguna de escritura', async () => {
    const montado = await servidor();

    const res = await montado.app.inject({
      method: 'PUT', url: RUTA, payload: { ...CUERPO, expected_revision: 9 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('profile_revision_conflict');
    expect(montado.auditoria).toHaveLength(1);
    expect(montado.auditoria[0]).toMatchObject({ action: 'agent_document.denied', decision: 'deny' });
    expect(montado.auditoria[0]?.metadata).toMatchObject({
      reason: 'profile_revision_conflict', operator_reason: MOTIVO,
    });
    expect(montado.replaceProfile).not.toHaveBeenCalled();
  });
});

const RUTA_CLAUDE = '/home/dev/.claude/CLAUDE.md';

function textoDe(alias: string): string {
  return [
    '# CLAUDE.md', MARCA_PERFIL_INICIO, `<!-- alias: ${alias} -->`, 'perfil proyectado',
    MARCA_PERFIL_FIN, '',
  ].join('\n');
}

function sonda(texto: string): AgentFactsProbe & { escrituras: number } {
  const facts: RuntimeFacts = {
    harness: 'claude', home: '/home/dev', generation: 'gen-viva', containerId: 'ws-zeus',
  };
  const sondeo = {
    escrituras: 0,
    factsFor: async () => ({ facts, source: 'measured' as const }),
    readGovernanceDocument: async (path: string) => (path === RUTA_CLAUDE
      ? {
          text: texto,
          bytes: Buffer.byteLength(texto, 'utf8'),
          truncated: false,
          modified_at: '2026-09-01T10:00:00.000Z',
          sha: 'a'.repeat(64),
        }
      : { error: 'not_found' as const, reason: 'no existe' }),
    listMemoryDirectory: async () => ({ error: 'unavailable' as const, reason: 'no aplica' }),
    writeGovernanceBatch: async () => {
      sondeo.escrituras += 1;
      return { error: 'conflict' as const, reason: 'un perfil en cuarentena no escribe' };
    },
  };
  return sondeo;
}

function contextoClaude(tenantId: string, alias: string): ContextoDeAlias {
  const base = contexto(PERFIL_BODY, 'claude');
  return { ...base, perfil: { ...base.perfil, tenant_id: tenantId, alias } };
}

describe('la guarda de contaminación pone el PUT en cuarentena', () => {
  /**
   * Wired exactly as `routes/console.ts` wires it: the canonical preflight and the canonical
   * measurement. With a runtime double that never reads the block this case would answer a bare
   * `conflict` that names nobody, so what passes here is the guard and not the double.
   */
  it('un bloque gestionado de otro alias nombra al dueño y no persiste nada', async () => {
    const probe = sonda(textoDe('Miguel/kratos'));
    const telemetry = new ContextContaminationTelemetry();
    const montado = await servidor({
      telemetry,
      readContext: async (tenantId, alias) => ({
        contexto: contextoClaude(tenantId, alias), exists: true, revision: 1, applied_revision: 1,
      }),
      prepareRuntime: vi.fn((tenantId: string, alias: string, ctx: ContextoDeAlias) =>
        prepareAgentProfileRuntime(probe, tenantId, alias, ctx)),
      measureContext: (tenantId, alias) => medirContextoDeGobierno(probe, tenantId, alias),
      readRuntimeExpectation: async () => undefined,
    });

    const res = await montado.app.inject({ method: 'PUT', url: RUTA, payload: CUERPO });

    expect(res.statusCode).toBe(409);
    const body = res.json<{
      error: string; contaminacion: { findings: { reason: string; owner: string }[] };
    }>();
    expect(body.error).toBe('context_contaminated');
    expect(body.contaminacion.findings[0]).toMatchObject({
      reason: 'foreign_managed_block', owner: 'Miguel/kratos',
    });
    expect(JSON.stringify(body)).not.toContain('perfil proyectado');
    expect(montado.replaceProfile).not.toHaveBeenCalled();
    expect(montado.prepareRuntime).not.toHaveBeenCalled();
    expect(probe.escrituras).toBe(0);
    expect(telemetry.snapshot().foreign_managed_block).toBe(1);
    const fila = montado.auditoria[0];
    expect(fila).toMatchObject({ action: 'agent_document.denied', decision: 'deny' });
    expect(fila?.metadata).toMatchObject({
      reason: 'context_contaminated', findings: ['foreign_managed_block'],
    });
    expect(JSON.stringify(fila?.metadata)).not.toContain('perfil proyectado');
  });

  it('CONTROL NEGATIVO: el mismo bloque a nombre del propio alias sí se guarda', async () => {
    const probe = sonda(textoDe('Steven/zeus'));
    const telemetry = new ContextContaminationTelemetry();
    const montado = await servidor({
      telemetry,
      readContext: async (tenantId, alias) => ({
        contexto: contextoClaude(tenantId, alias), exists: true, revision: 1, applied_revision: 1,
      }),
      measureContext: (tenantId, alias) => medirContextoDeGobierno(probe, tenantId, alias),
      readRuntimeExpectation: async () => undefined,
    });

    const res = await montado.app.inject({ method: 'PUT', url: RUTA, payload: CUERPO });

    expect(res.statusCode).toBe(200);
    expect(montado.replaceProfile).toHaveBeenCalledTimes(1);
    expect(telemetry.snapshot().foreign_managed_block).toBe(0);
  });

  it('el GET sirve a una sesión sin persona y siempre lleva el veredicto', async () => {
    const probe = sonda(textoDe('Miguel/kratos'));
    const montado = await servidor({
      resolveOperator: () => ({ operator_id: 'sin-persona', attributed: false }),
      readContext: async (tenantId, alias) => ({
        contexto: contextoClaude(tenantId, alias), exists: true, revision: 1, applied_revision: 1,
      }),
      measureContext: (tenantId, alias) => medirContextoDeGobierno(probe, tenantId, alias),
      readRuntimeExpectation: async () => undefined,
    });

    const res = await montado.app.inject({ method: 'GET', url: RUTA });

    expect(res.statusCode).toBe(200);
    expect(res.json<RespuestaDelPerfil>().contaminacion.findings[0]).toMatchObject({
      reason: 'foreign_managed_block', owner: 'Miguel/kratos',
    });
  });

  it('sin sonda que mida, el GET declara un veredicto vacío en vez de callarse', async () => {
    const montado = await servidor();

    const res = await montado.app.inject({ method: 'GET', url: RUTA });

    expect(res.statusCode).toBe(200);
    expect(res.json<RespuestaDelPerfil>().contaminacion)
      .toEqual({ contaminated: false, findings: [] });
  });
});
