import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO, conBloqueDePerfil, conRevisionDelPerfil,
  type ContextoDeAlias,
} from '@cauce/protocol';
import {
  medirContextoDeGobierno, registerAgentContextReloadRoutes, type AgentContextReloadDeps,
  type DeliveriesInFlight,
} from './agent-context-reload.routes.js';
import {
  registerAgentContextHistoryRoutes, type DocumentRevisionView,
} from './agent-context-history.routes.js';
import { nombresDelArnes } from '@cauce/protocol';
import { RELOAD_DOCUMENT_KINDS } from './agent-context-reload.routes.js';
import { ContextContaminationTelemetry } from './contaminacion-de-contexto.js';
import { CONTEXT_APPLY_POLICY } from './context-apply-policy.js';
import { prepareAgentProfileRuntime } from './agent-profile-runtime.js';
import type { AgentFactsProbe, TerminalAuditEntry } from './agent-documents.routes.js';
import type { RuntimeFacts } from './agent-documents.js';
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

function proyectar(base: string, alias: string, cuerpo: string, revision = 4): string {
  return conRevisionDelPerfil(
    conBloqueDePerfil(base, `<!-- alias: ${alias} -->\n${cuerpo}`), revision,
  );
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
  texto?: string; observedSha?: string | null; generation?: string | null; intended?: string;
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
      preview: options.intended === undefined ? [] : [{
        nombre: 'CLAUDE.md', politica: 'bloque-gestionado', texto: options.intended,
        unidades: options.intended.length,
      }],
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

/** A batch of several files, to see WHICH of them the journal claims were rewritten. */
function runtimeDeVarios(
  specs: readonly { name: string; state: ProfileRuntimeAck['state'] }[],
): RuntimeDouble {
  const aplicaciones: string[] = [];
  const documents = specs.map((spec) => ({
    name: spec.name,
    path: `/home/dev/openclaw/${spec.name}`,
    expected_sha: sha('b'),
    observed_sha: sha('a'),
    expected_bytes: 120,
    observed_bytes: 90,
    current: false,
  }));
  const preflight: ProfileRuntimePreflight = {
    harness: 'openclaw',
    existentes: new Map(specs.map((spec) => [spec.name, ''])),
    materialize: (revision): PreparedProfileRuntime => ({
      revision,
      documents: specs.map((spec) => spec.name),
      harness: 'openclaw',
      preview: [],
      verification: {
        state: 'drifted',
        generation: 'gen-viva',
        container_id: 'contenedor-1',
        observed_at: '2026-09-01T10:00:00.000Z',
        documents,
      },
      apply: async () => {
        aplicaciones.push('apply');
        return specs.map((spec) => ({
          ...ACK, name: spec.name, path: `/home/dev/openclaw/${spec.name}`, state: spec.state,
        }));
      },
    }),
  };
  return { aplicaciones, preflight };
}

const RUTA_CLAUDE = '/home/dev/.claude/CLAUDE.md';

function huella(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

/**
 * CONTROL-A: the probe the CANONICAL preflight reads, so the refusal under test is the real
 * `assertOwnedBlocks` one and not a double that never runs it.
 */
function sonda(texto: string): AgentFactsProbe & { escrituras: number } {
  const facts: RuntimeFacts = {
    harness: 'claude', home: '/home/dev', generation: 'gen-viva', containerId: 'contenedor-1',
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
          sha: huella(texto),
        }
      : { error: 'not_found' as const, reason: 'no existe' }),
    listMemoryDirectory: async () => ({ error: 'unavailable' as const, reason: 'no aplica' }),
    writeGovernanceBatch: async () => {
      sondeo.escrituras += 1;
      return { error: 'conflict' as const, reason: 'una recarga en cuarentena no escribe' };
    },
  };
  return sondeo;
}

function contextoReal(tenantId: string, alias: string): ContextoDeAlias {
  return {
    perfil: {
      tenant_id: tenantId, alias, purpose: 'orquestar', role_summary: 'PMO', human_brief: null,
      responsibilities: ['perseguir lo pendiente'], restrictions: [], tools: [],
      operating_rules: [],
    },
    hechos: {
      permisos: { ruta: true, lectura: true, control: true, notificacion: false },
      cuotas: [],
      arnes: { harness: 'claude', home: '/home/dev', capacidades: [] },
      destinos: [],
    },
  };
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
    measureContext: async (tenantId, alias) => ({
      owner: { tenant_id: tenantId, alias },
      generation: 'gen-viva',
      documents: [...(doble.preflight.existentes ?? new Map<string, string>())]
        .map(([name, text]) => ({ name, path: `/home/dev/${name}`, sha: sha('a'), text })),
    }),
    readRuntimeExpectation: async () => ({
      generation: 'gen-viva',
      documents: [{ name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('a') }],
    }),
    recordRuntimeExpectation: async () => undefined,
    deliveryInFlight: async () => ({ count: 0, deliveries: [] }),
    recordDocumentRevision: async () => undefined,
    recordAudit: async (entry) => { auditoria.push(entry); },
    ...deps,
  });
  return app;
}

function enVuelo(count: number): DeliveriesInFlight {
  return {
    count,
    deliveries: Array.from({ length: Math.min(count, 25) }, (_valor, indice) => ({
      delivery_id: `entrega-${String(indice + 1)}`,
      status: 'started',
      claimed_at: `2026-09-01T10:00:${String(indice + 1).padStart(2, '0')}.000Z`,
      deadline_at: `2026-09-01T10:30:${String(indice + 1).padStart(2, '0')}.000Z`,
    })),
  };
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
    vivo = servidor({ deliveryInFlight: async () => enVuelo(1) }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: string; message: string }>();
    expect(body.error).toBe('delivery_in_flight');
    expect(body.message).toMatch(/entrega/u);
    expect(doble.aplicaciones).toEqual([]);
  });

  it('names the deliveries that hold the reload back, and only their four fields', async () => {
    const doble = runtime();
    vivo = servidor({ deliveryInFlight: async () => enVuelo(2) }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json<{ deliveries: Record<string, unknown>[] }>();
    expect(body.deliveries).toEqual([
      {
        delivery_id: 'entrega-1', status: 'started',
        claimed_at: '2026-09-01T10:00:01.000Z', deadline_at: '2026-09-01T10:30:01.000Z',
      },
      {
        delivery_id: 'entrega-2', status: 'started',
        claimed_at: '2026-09-01T10:00:02.000Z', deadline_at: '2026-09-01T10:30:02.000Z',
      },
    ]);
    for (const entrega of body.deliveries) {
      expect(Object.keys(entrega).sort())
        .toEqual(['claimed_at', 'deadline_at', 'delivery_id', 'status']);
    }
    expect(doble.aplicaciones).toEqual([]);
  });

  /*
   * A body that grows with the queue is a body an operator cannot read and a refusal a caller can
   * make expensive. The list is capped and the audit row keeps the REAL number, so nobody reads
   * «20» and believes the alias had twenty turns open.
   */
  it('lists at most twenty deliveries while the audit row keeps the real count', async () => {
    const doble = runtime();
    vivo = servidor({ deliveryInFlight: async () => enVuelo(37) }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json<{ deliveries: { delivery_id: string }[] }>();
    expect(body.deliveries).toHaveLength(20);
    expect(body.deliveries[0]?.delivery_id).toBe('entrega-1');
    expect(body.deliveries[19]?.delivery_id).toBe('entrega-20');
    const fila = auditoria[0];
    expect(fila?.decision).toBe('deny');
    const metadata = fila?.metadata as Record<string, unknown>;
    expect(metadata.deliveries_in_flight).toBe(37);
    // The row records the count and nothing else about those deliveries.
    expect(Object.keys(metadata)).not.toContain('deliveries');
  });

  it('never refuses when nothing is in flight, however empty the list comes back', async () => {
    const doble = runtime();
    vivo = servidor({ deliveryInFlight: async () => ({ count: 0, deliveries: [] }) }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(200);
    expect(doble.aplicaciones).toEqual(['apply']);
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
  /**
   * The canonical preflight is wired here exactly as `routes/console.ts` wires it. With a double
   * that never runs `assertOwnedBlocks` this case answers a bare `conflict` that names nobody, so
   * the double is what used to pass, not the guard.
   */
  it('rejects a managed block owned by another alias, names the owner and writes nothing', async () => {
    const probe = sonda(textoDe('Miguel/kratos'));
    const telemetry = new ContextContaminationTelemetry();
    vivo = servidor({
      telemetry,
      readContext: async (tenantId, alias) => ({
        contexto: contextoReal(tenantId, alias),
        exists: true,
        revision: 4,
        applied_revision: 3,
      }),
      prepareRuntime: (tenantId, alias, contexto) =>
        prepareAgentProfileRuntime(probe, tenantId, alias, contexto),
      measureContext: (tenantId, alias) => medirContextoDeGobierno(probe, tenantId, alias),
      readRuntimeExpectation: async () => undefined,
    });
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json<{
      error: string; contaminacion: { findings: { reason: string; owner: string }[] };
    }>();
    expect(body.error).toBe('context_contaminated');
    expect(body.contaminacion.findings[0]?.reason).toBe('foreign_managed_block');
    expect(body.contaminacion.findings[0]?.owner).toBe('Miguel/kratos');
    expect(JSON.stringify(body)).not.toContain('perfil proyectado');
    expect(probe.escrituras).toBe(0);
    expect(telemetry.snapshot().foreign_managed_block).toBe(1);
    const fila = auditoria[0];
    expect(fila?.action).toBe('agent_document.denied');
    expect(fila?.metadata.reason).toBe('context_contaminated');
    expect(fila?.metadata.findings).toEqual(['foreign_managed_block']);
    expect(JSON.stringify(fila?.metadata)).not.toContain('perfil proyectado');
  });

  /** A refusal that is NOT contamination keeps its own code instead of being dressed as one. */
  it('leaves a preflight conflict that no longer shows a foreign block as a plain conflict', async () => {
    const probe = sonda(textoDe('Steven/argos'));
    vivo = servidor({
      readContext: async (tenantId, alias) => ({
        contexto: contextoReal(tenantId, alias), exists: true, revision: 4, applied_revision: 3,
      }),
      prepareRuntime: async () => {
        throw Object.assign(new Error('la generación cambió'), { code: 'conflict' });
      },
      measureContext: (tenantId, alias) => medirContextoDeGobierno(probe, tenantId, alias),
      readRuntimeExpectation: async () => undefined,
    });
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('conflict');
  });

  it('quarantines a fingerprint that disagrees with the expectation of the live generation', async () => {
    const disco = proyectar('', 'Steven/argos', 'perfil sembrado con cuotas de hoy', 3);
    const doble = runtime({
      observedSha: sha('c'),
      texto: disco,
      intended: proyectar(disco, 'Steven/argos', 'perfil proyectado'),
    });
    vivo = servidor({}, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('context_contaminated');
    expect(doble.aplicaciones).toEqual([]);
  });

  it('quarantines prose injected outside the block, which the projection copies verbatim', async () => {
    const disco = proyectar('regla añadida a mano', 'Steven/argos', 'perfil sembrado con cuotas de hoy');
    const recordRuntimeExpectation =
      vi.fn<AgentContextReloadDeps['recordRuntimeExpectation']>(async () => undefined);
    const doble = runtime({
      observedSha: sha('c'),
      texto: disco,
      intended: proyectar(disco, 'Steven/argos', 'perfil proyectado'),
    });
    vivo = servidor({ recordRuntimeExpectation }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json<{
      error: string; contaminacion: { findings: { reason: string }[] };
    }>();
    expect(body.error).toBe('context_contaminated');
    expect(body.contaminacion.findings.map((finding) => finding.reason))
      .toEqual(['expectation_sha_mismatch']);
    expect(doble.aplicaciones).toEqual([]);
    expect(recordRuntimeExpectation).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('regla añadida a mano');
  });

  it('quarantines the same injection on the self-reload that carries no person', async () => {
    const disco = proyectar('regla añadida a mano', 'Steven/argos', 'perfil sembrado con cuotas de hoy');
    const doble = runtime({
      observedSha: sha('c'),
      texto: disco,
      intended: proyectar(disco, 'Steven/argos', 'perfil proyectado'),
    });
    vivo = servidor({ authorize: async () => ALIAS_ACTOR }, doble);
    const response = await vivo.inject({ method: 'POST', url: RUTA_PROPIA });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('context_contaminated');
    expect(doble.aplicaciones).toEqual([]);
  });

  it('re-materializes when only the alias own profile block drifted from the live expectation', async () => {
    const disco = proyectar('', 'Steven/argos', 'perfil sembrado con cuotas de hoy');
    const doble = runtime({
      observedSha: sha('c'),
      texto: disco,
      intended: proyectar(disco, 'Steven/argos', 'perfil proyectado'),
    });
    vivo = servidor({
      readRuntimeExpectation: async () => ({
        generation: 'gen-viva',
        documents: [{ name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('a') }],
      }),
    }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(200);
    expect(doble.aplicaciones).toEqual(['apply']);
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

describe('the journal of a reload is readable back', () => {
  /** The history route is mounted on the same app: what the reload writes, somebody must read. */
  function conHistorial(
    filas: DocumentRevisionView[], doble: RuntimeDouble,
  ): ReturnType<typeof servidor> {
    const app = servidor({
      recordDocumentRevision: async (input) => {
        filas.push({
          id: String(filas.length + 1),
          tenant_id: input.tenantId,
          alias: input.alias,
          kind: input.kind,
          path: input.path,
          sha256: input.sha256,
          bytes: input.bytes,
          actor_tenant: input.actorTenant,
          actor_alias: input.actorAlias,
          written_at: '2026-09-01T10:00:00.000Z',
        });
        return undefined;
      },
    }, doble);
    registerAgentContextHistoryRoutes(app, {
      authorize: async () => OPERADOR_ACTOR,
      authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias }),
      listProfileRevisions: async () => ({ entries: [], next_cursor: null }),
      listDocumentRevisions: async (tenantId, alias, kind) => ({
        entries: filas.filter((fila) => fila.tenant_id === tenantId && fila.alias === alias
          && fila.kind === kind),
        next_cursor: null,
      }),
    });
    return app;
  }

  it('records one row per document kind and serves it from the history route', async () => {
    const filas: DocumentRevisionView[] = [];
    const doble = runtimeDeVarios([
      { name: 'AGENTS.md', state: 'written' },
      { name: 'TOOLS.md', state: 'written' },
      { name: 'MEMORY.md', state: 'preserved' },
    ]);
    vivo = conHistorial(filas, doble);
    const recarga = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(recarga.statusCode).toBe(200);
    // MEMORY.md was only VERIFIED: journaling it would claim a rewrite that never happened.
    expect(filas.map((fila) => [fila.kind, fila.path])).toEqual([
      ['directive', '/home/dev/openclaw/AGENTS.md'],
      ['tools', '/home/dev/openclaw/TOOLS.md'],
    ]);

    const historial = await vivo.inject({
      method: 'GET', url: '/v3/console/tenants/Steven/agents/argos/documents/directive/revisions',
    });
    expect(historial.statusCode).toBe(200);
    expect(historial.json<{ entries: { path: string }[] }>().entries.map((e) => e.path))
      .toEqual(['/home/dev/openclaw/AGENTS.md']);
  });

  it('keeps the write audit row and answers a typed 5xx when the journal refuses the row', async () => {
    const doble = runtime();
    vivo = servidor({
      recordDocumentRevision: async () => { throw new Error('el diario no anotó la fila'); },
    }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: string }>().error).toBe('context_journal_not_recorded');
    // The bytes landed and the row that accuses a person is there, even without the journal.
    expect(auditoria.map((entry) => [entry.action, entry.decision]))
      .toEqual([['agent_document.write', 'allow']]);
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

describe('RELOAD_DOCUMENT_KINDS', () => {
  it('journals every governance file of every harness the protocol projects', () => {
    for (const harness of ['claude', 'codex', 'openclaw']) {
      for (const name of nombresDelArnes(harness)) {
        expect(RELOAD_DOCUMENT_KINDS.has(name), `${harness}: ${name}`).toBe(true);
      }
    }
  });
});
