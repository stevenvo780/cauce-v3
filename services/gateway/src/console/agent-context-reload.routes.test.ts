import { coordinateWriteFixture, FIXTURE_WRITE_OPERATION } from './agent-profile.fixtures.js';
import { createHash } from 'node:crypto';
import { StoreError } from '@cauce/store';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO,
  type ContextoDeAlias,
} from '@cauce/protocol';
import {
  medirContextoDeGobierno, registerAgentContextReloadRoutes, type AgentContextReloadDeps,
  type DeliveriesInFlight,
} from './agent-context-reload.routes.js';
import {
  registerAgentContextHistoryRoutes, type DocumentRevisionView,
} from './agent-context-history.routes.js';
import { ContextContaminationTelemetry } from './contaminacion-de-contexto.js';
import { CONTEXT_APPLY_POLICY } from './context-apply-policy.js';
import { prepareAgentProfileRuntime } from './agent-profile-runtime.js';
import type { AgentFactsProbe, TerminalAuditEntry } from './agent-documents.routes.js';
import type { RuntimeFacts } from './agent-documents.js';
import type {
  PreparedProfileRuntime, ProfileRuntimeAck, ProfileRuntimePreflight, ProfileRuntimeVerification,
} from './agent-profile.routes.js';

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

type TestReloadDeps = AgentContextReloadDeps & {
  recordRuntimeExpectation(tenant: string, alias: string, revision: number, verification: ProfileRuntimeVerification): Promise<void>;
  recordDocumentRevision(input: { tenantId: string; alias: string; kind: string; path: string;
    sha256: string | null; bytes: number; actorTenant: string | null; actorAlias: string | null }): Promise<unknown>;
};

function servidor(deps: Partial<TestReloadDeps> = {}, doble = runtime()) {
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
      generation: 'gen-viva', revision: 3,
      documents: [{ name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('a') }],
    }),
    coordinateWrite: (input) => coordinateWriteFixture(input, async (sql, values) => {
      if (sql.includes('agent_profile_runtime_expectations')) await deps.recordRuntimeExpectation?.(input.tenantId, input.alias, Number(values[2]), {
        state: 'current', generation: String(values[3]), container_id: null,
        observed_at: new Date(0).toISOString(), documents: [],
      });
      if (sql.includes('agent_document_revisions')) await deps.recordDocumentRevision?.({
        tenantId: input.tenantId, alias: input.alias, path: String(values[2]), sha256: String(values[3]),
        bytes: Number(values[4]), actorTenant: String(values[5]), actorAlias: String(values[6]), kind: String(values[7]),
      });
      if (sql.includes('audit_events')) await (deps.recordAudit ?? (async (entry) => { auditoria.push(entry); }))({
        tenant_id: String(values[0]), actor_alias: String(values[1]), action: 'agent_document.write', decision: 'allow',
        metadata: JSON.parse(String(values[3])) as Record<string, unknown>,
      });
    }),
    deliveryInFlight: async () => ({ count: 0, deliveries: [] }),
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

  it('denies a delivery claimed after preflight before writing the runtime', async () => {
    const double = runtime();
    let reached = (): void => undefined;
    const prepared = new Promise<void>((resolve) => { reached = resolve; });
    let resume = (): void => undefined;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let busy = false;
    vivo = servidor({
      prepareRuntime: async () => { reached(); await gate; return double.preflight; },
      coordinateWrite: async (input) => {
        if (busy) throw new StoreError('conflict', 'context reload target has work in flight');
        const effect = await input.dispatch(FIXTURE_WRITE_OPERATION);
        return { state: 'committed', resolution: 'target', value: effect };
      },
    }, double);
    const request = vivo.inject({ method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO } });
    await prepared;
    busy = true;
    resume();
    const response = await request;
    expect(double.aplicaciones).toEqual([]);
    expect(response.statusCode).toBe(409);
  });

  it('re-materializes and answers the written-but-not-yet-read state with its evidence', async () => {
    const doble = runtime();
    const recordDocumentRevision =
      vi.fn<TestReloadDeps['recordDocumentRevision']>(async () => undefined);
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

  it('refuses to let one alias reload another one through the tenant-less form', async () => {
    const doble = runtime();
    vivo = servidor({ authorize: async () => OPERADOR_ACTOR }, doble);
    const response = await vivo.inject({ method: 'POST', url: RUTA_PROPIA });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ reason: string }>().reason).toBe('self_reload_only');
    expect(doble.aplicaciones).toEqual([]);
    expect(auditoria.map((entry) => entry.decision)).toEqual(['deny']);
  });
});

describe('a reload never claims more than it proved', () => {
  it('reports unknown effect without advancing metadata when the batch is not attested', async () => {
    const doble = runtime({
      aplicar: async () => { throw Object.assign(new Error('el lote no acreditó'), { code: 'conflict' }); },
    });
    const recordRuntimeExpectation =
      vi.fn<TestReloadDeps['recordRuntimeExpectation']>(async () => undefined);
    vivo = servidor({ recordRuntimeExpectation }, doble);
    const response = await vivo.inject({
      method: 'POST', url: RUTA_OPERADOR, payload: { reason: MOTIVO },
    });
    expect(response.statusCode).toBe(503);
    expect(recordRuntimeExpectation).not.toHaveBeenCalled();
    expect(auditoria.map((entry) => entry.decision)).toEqual(['allow']);
  });
});
