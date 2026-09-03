import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO } from '@cauce/protocol';
import {
  registerAgentContextReloadRoutes, type AgentContextReloadDeps,
} from './agent-context-reload.routes.js';
import { ContextContaminationTelemetry } from './contaminacion-de-contexto.js';
import { CONTEXT_APPLY_POLICY } from './context-apply-policy.js';
import type { TerminalAuditEntry } from './agent-documents.routes.js';
import type {
  PreparedProfileRuntime, ProfileRuntimeAck, ProfileRuntimePreflight,
} from './agent-profile.routes.js';

/**
 * The routes are stood up and hit with `app.inject`. The runtime is a double, but the ORDER the
 * handler imposes on it is the thing under test: nothing may be written before the guard runs.
 */

const OPERADOR_ACTOR = { tenant_id: 'Steven', alias: 'zeus' };
const ALIAS_ACTOR = { tenant_id: 'Steven', alias: 'argos' };
const OPERADOR = { operator_id: 'steven@elenxos', attributed: true };
const MOTIVO = 'recargo el contexto tras cambiar la composición del perfil';

const sha = (letter: string): string => letter.repeat(64);

function textoDe(alias: string): string {
  return [
    '# CLAUDE.md', MARCA_PERFIL_INICIO, `<!-- alias: ${alias} -->`, 'perfil proyectado',
    MARCA_PERFIL_FIN, '',
  ].join('\n');
}

const ACK: ProfileRuntimeAck = {
  name: 'CLAUDE.md',
  path: '/home/dev/CLAUDE.md',
  state: 'written',
  sha: sha('b'),
  bytes: 120,
  generation: 'gen-viva',
  container_id: 'contenedor-1',
};

interface RuntimeDouble {
  readonly aplicaciones: string[];
  readonly preflight: ProfileRuntimePreflight;
}

function runtime(options: {
  texto?: string; observedSha?: string | null; generation?: string | null;
  aplicar?: () => Promise<readonly ProfileRuntimeAck[]>;
} = {}): RuntimeDouble {
  const aplicaciones: string[] = [];
  const generation = options.generation === undefined ? 'gen-viva' : options.generation;
  const documents = [{
    name: 'CLAUDE.md',
    path: '/home/dev/CLAUDE.md',
    expected_sha: sha('b'),
    observed_sha: options.observedSha === undefined ? sha('a') : options.observedSha,
    expected_bytes: 120,
    observed_bytes: 90,
    current: false,
  }];
  const preflight: ProfileRuntimePreflight = {
    harness: 'claude',
    existentes: new Map([['CLAUDE.md', options.texto ?? textoDe('Steven/argos')]]),
    materialize: (revision): PreparedProfileRuntime => ({
      revision,
      documents: ['CLAUDE.md'],
      harness: 'claude',
      preview: [],
      verification: {
        state: 'drifted',
        generation,
        container_id: 'contenedor-1',
        observed_at: '2026-09-01T10:00:00.000Z',
        documents,
      },
      apply: async () => {
        aplicaciones.push('apply');
        return options.aplicar === undefined ? [ACK] : await options.aplicar();
      },
    }),
  };
  return { aplicaciones, preflight };
}

const auditoria: TerminalAuditEntry[] = [];

function servidor(deps: Partial<AgentContextReloadDeps> = {}, doble = runtime()) {
  const app = Fastify();
  registerAgentContextReloadRoutes(app, {
    authorize: async () => OPERADOR_ACTOR,
    authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias, enabled: true }),
    resolveOperator: () => OPERADOR,
    readContext: async (tenantId, alias) => ({
      contexto: {
        perfil: {
          tenant_id: tenantId, alias, purpose: null, role_summary: 'PMO', human_brief: null,
          responsibilities: [], restrictions: [], tools: [], operating_rules: [],
        },
        hechos: { arnes: { harness: 'claude', home: '/home/dev' } },
      } as never,
      exists: true,
      revision: 4,
      applied_revision: 3,
    }),
    prepareRuntime: async () => doble.preflight,
    readRuntimeExpectation: async () => ({
      generation: 'gen-viva',
      documents: [{ name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('a') }],
    }),
    recordRuntimeExpectation: async () => undefined,
    deliveryInFlight: async () => false,
    recordDocumentRevision: async () => undefined,
    recordAudit: async (entry) => { auditoria.push(entry); },
    ...deps,
  });
  return app;
}

const RUTA_OPERADOR = '/v3/console/tenants/Steven/agents/argos/context/reload';
const RUTA_PROPIA = '/v3/console/agents/argos/context/reload';

let vivo: ReturnType<typeof servidor> | undefined;
afterEach(async () => { await vivo?.close(); vivo = undefined; auditoria.length = 0; });

describe('POST .../context/reload as an operator', () => {
  it('re-materializes and answers the written-but-not-yet-read state with its evidence', async () => {
    const doble = runtime();
    const recordDocumentRevision =
      vi.fn<AgentContextReloadDeps['recordDocumentRevision']>(async () => undefined);
    vivo = servidor({ recordDocumentRevision }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body.state).toBe('pending_session_refresh');
    expect(body.evidence).toBe(CONTEXT_APPLY_POLICY.pending_session_refresh.evidence);
    expect(body.revision).toBe(4);
    expect(body.documents).toEqual([{
      name: 'CLAUDE.md',
      path: '/home/dev/CLAUDE.md',
      sha_before: sha('a'),
      sha_after: sha('b'),
      bytes: 120,
    }]);
    expect(body.contaminacion).toEqual({ contaminated: false, findings: [] });
    expect(doble.aplicaciones).toEqual(['apply']);
    expect(recordDocumentRevision).toHaveBeenCalledTimes(1);
    expect(auditoria.map((entry) => [entry.action, entry.decision]))
      .toEqual([['agent_document.write', 'allow']]);
  });

  /** A reload writes a person's HOME: the same gate the manual write already applies. */
  it('refuses an unattributed person and never touches the runtime', async () => {
    const doble = runtime();
    vivo = servidor({
      resolveOperator: () => ({ operator_id: 'sin-persona', attributed: false }),
    }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ reason: string }>().reason).toBe('writable_requires_attribution');
    expect(doble.aplicaciones).toEqual([]);
    expect(auditoria.map((entry) => entry.decision)).toEqual(['deny']);
  });

  it('refuses a reason shorter than the one the PTY plane demands', async () => {
    const doble = runtime();
    vivo = servidor({}, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: 'corto' },
    });
    expect(response.statusCode).toBe(400);
    expect(doble.aplicaciones).toEqual([]);
  });

  it('requires the control permission on the operator form', async () => {
    const authorize = vi.fn<AgentContextReloadDeps['authorize']>(async () => OPERADOR_ACTOR);
    vivo = servidor({ authorize });
    await vivo.inject({ method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO } });
    expect(authorize.mock.calls[0]?.[1]).toBe('control');
  });

  it('fails closed while a delivery is in flight and says so in the body', async () => {
    const doble = runtime();
    vivo = servidor({ deliveryInFlight: async () => true }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: string; message: string }>();
    expect(body.error).toBe('delivery_in_flight');
    expect(body.message).toMatch(/entrega/u);
    expect(doble.aplicaciones).toEqual([]);
  });

  it('refuses a disabled alias: a reload does not resurrect a runtime that must stay off', async () => {
    const doble = runtime();
    vivo = servidor({
      authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias, enabled: false }),
    }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('agent_disabled');
    expect(doble.aplicaciones).toEqual([]);
  });

  it('refuses an alias with no durable profile to re-materialize', async () => {
    const doble = runtime();
    vivo = servidor({
      readContext: async (tenantId, alias) => ({
        contexto: {
          perfil: {
            tenant_id: tenantId, alias, purpose: null, role_summary: null, human_brief: null,
            responsibilities: [], restrictions: [], tools: [], operating_rules: [],
          },
          hechos: { arnes: { harness: 'claude', home: '/home/dev' } },
        } as never,
        exists: false,
        revision: null,
        applied_revision: null,
      }),
    }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('profile_absent');
    expect(doble.aplicaciones).toEqual([]);
  });
});

describe('the contamination guard quarantines the reload', () => {
  it('rejects a managed block owned by another alias, names the owner and writes nothing', async () => {
    const doble = runtime({ texto: textoDe('Miguel/kratos') });
    const telemetry = new ContextContaminationTelemetry();
    vivo = servidor({ telemetry }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: string; contaminacion: { findings: { owner: string }[] } }>();
    expect(body.error).toBe('context_contaminated');
    expect(body.contaminacion.findings[0]?.owner).toBe('Miguel/kratos');
    expect(JSON.stringify(body)).not.toContain('perfil proyectado');
    expect(doble.aplicaciones).toEqual([]);
    expect(telemetry.snapshot().foreign_managed_block).toBe(1);
    const fila = auditoria[0];
    expect(fila?.action).toBe('agent_document.denied');
    expect(fila?.metadata.reason).toBe('context_contaminated');
    expect(JSON.stringify(fila?.metadata)).not.toContain('perfil proyectado');
  });

  it('quarantines a fingerprint that disagrees with the expectation of the live generation', async () => {
    const doble = runtime({ observedSha: sha('c') });
    vivo = servidor({}, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('context_contaminated');
    expect(doble.aplicaciones).toEqual([]);
  });

  /** Drift against a dead generation IS what a reload repairs; quarantining it strands the alias. */
  it('re-materializes when the recorded expectation belongs to a generation already gone', async () => {
    const doble = runtime({ observedSha: sha('c') });
    vivo = servidor({
      readRuntimeExpectation: async () => ({
        generation: 'gen-anterior',
        documents: [{ name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('a') }],
      }),
    }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(200);
    expect(doble.aplicaciones).toEqual(['apply']);
  });
});

describe('POST /v3/console/agents/:alias/context/reload as the alias itself', () => {
  it('accepts the alias healing itself over mTLS with no person and no reason', async () => {
    const doble = runtime();
    const resolveOperator = vi.fn(() => OPERADOR);
    vivo = servidor({ authorize: async () => ALIAS_ACTOR, resolveOperator }, doble);
    const response = await vivo.inject({ method: 'POST', url: RUTA_PROPIA });
    expect(response.statusCode).toBe(200);
    expect(doble.aplicaciones).toEqual(['apply']);
    // The self-heal path carries no person, so no operator is even resolved for it.
    expect(resolveOperator).not.toHaveBeenCalled();
    const fila = auditoria[0];
    expect(fila?.metadata.principal).toBe('alias_self');
    expect(fila?.metadata.attributed).toBe(false);
  });

  it('requires only the read permission: the alias is repairing its own files', async () => {
    const authorize = vi.fn<AgentContextReloadDeps['authorize']>(async () => ALIAS_ACTOR);
    vivo = servidor({ authorize });
    await vivo.inject({ method: 'POST', url: RUTA_PROPIA });
    expect(authorize.mock.calls[0]?.[1]).toBe('read');
  });

  it('refuses to let one alias reload another one through the tenant-less form', async () => {
    const doble = runtime();
    vivo = servidor({ authorize: async () => OPERADOR_ACTOR }, doble);
    const response = await vivo.inject({ method: 'POST', url: RUTA_PROPIA });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ reason: string }>().reason).toBe('self_reload_only');
    expect(doble.aplicaciones).toEqual([]);
    expect(auditoria.map((entry) => entry.decision)).toEqual(['deny']);
  });

  it('refuses a body: the self-heal call carries nothing to interpret', async () => {
    const doble = runtime();
    vivo = servidor({ authorize: async () => ALIAS_ACTOR }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_PROPIA, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(400);
    expect(doble.aplicaciones).toEqual([]);
  });
});

describe('a reload never claims more than it proved', () => {
  it('reports the runtime failure without advancing anything when the batch is not attested', async () => {
    const doble = runtime({
      aplicar: async () => { throw Object.assign(new Error('el lote no acreditó'), { code: 'conflict' }); },
    });
    const recordRuntimeExpectation =
      vi.fn<AgentContextReloadDeps['recordRuntimeExpectation']>(async () => undefined);
    vivo = servidor({ recordRuntimeExpectation }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    expect(recordRuntimeExpectation).not.toHaveBeenCalled();
    expect(auditoria.map((entry) => entry.decision)).toEqual(['deny']);
  });

  it('refuses to write without a measured generation able to fence the ACK', async () => {
    const doble = runtime({ generation: null });
    vivo = servidor({}, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('runtime_unverified');
    expect(doble.aplicaciones).toEqual([]);
  });

  it('records the expectation of the revision it re-materialized, never a new one', async () => {
    const recordRuntimeExpectation =
      vi.fn<AgentContextReloadDeps['recordRuntimeExpectation']>(async () => undefined);
    vivo = servidor({ recordRuntimeExpectation });
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(200);
    expect(recordRuntimeExpectation.mock.calls[0]?.[2]).toBe(4);
  });
});
