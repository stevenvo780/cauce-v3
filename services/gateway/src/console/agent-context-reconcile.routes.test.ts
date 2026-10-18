import { coordinateWriteFixture, FIXTURE_WRITE_OPERATION } from './agent-profile.fixtures.js';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conBloqueDePerfil, sinBloqueDePerfil, type ContextoDeAlias } from '@cauce/protocol';
import {
  registerAgentContextReconcileRoutes, type AgentContextReconcileDeps,
} from './agent-context-reconcile.routes.js';
import type { TerminalAuditEntry } from './agent-documents.routes.js';
import type { AgentFactsProbe } from './agent-documents.routes.js';
import type {
  PreparedProfileRuntime, ProfileRuntimeAck, ProfileRuntimePreflight,
} from './agent-profile.routes.js';
import { prepareAgentProfileRuntime } from './agent-profile-runtime.js';

const TARGET = { tenant_id: 'Miguel', alias: 'atlas', enabled: true };
const ACTOR = { tenant_id: 'Steven', alias: 'kant' };
const OPERATOR = { operator_id: 'steven@elenxos', attributed: true };
const REASON = 'reconciliar el bloque gestionado sin adoptar el observado';
const PATH = '/home/dev/.codex/AGENTS.md';
const GENERATION = 'generation-live';
const REVISION = 4;

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function managed(exterior: string, body: string, owner = 'Miguel/atlas'): string {
  return conBloqueDePerfil(exterior, `<!-- alias: ${owner} -->\n${body}`);
}

const EXTERIOR = '# Manual del operador\n';
const CURRENT = managed(EXTERIOR, 'bloque observado');
const PROJECTED = managed(EXTERIOR, 'bloque durable');

function contexto(): ContextoDeAlias {
  return {
    perfil: {
      tenant_id: TARGET.tenant_id,
      alias: TARGET.alias,
      purpose: 'validar',
      role_summary: 'Validador',
      human_brief: null,
      responsibilities: [],
      restrictions: [],
      tools: [],
      operating_rules: [],
    },
    hechos: {
      permisos: { ruta: true, lectura: true, control: true, notificacion: false },
      cuotas: [],
      arnes: { harness: 'codex', home: '/home/dev', capacidades: [] },
      destinos: [],
    },
  };
}

interface RuntimeFixture {
  current: string;
  projected: string;
  generation: string;
  apply: ReturnType<typeof vi.fn<() => Promise<readonly ProfileRuntimeAck[]>>>;
}

function runtimeFixture(): RuntimeFixture {
  const fixture: RuntimeFixture = {
    current: CURRENT,
    projected: PROJECTED,
    generation: GENERATION,
    apply: vi.fn(async () => [ack(fixture)]),
  };
  return fixture;
}

function ack(runtime: RuntimeFixture): ProfileRuntimeAck {
  return {
    name: 'AGENTS.md',
    path: PATH,
    state: 'written',
    sha: sha(runtime.projected),
    bytes: Buffer.byteLength(runtime.projected, 'utf8'),
    generation: runtime.generation,
    container_id: 'container-atlas',
  };
}

function preflight(runtime: RuntimeFixture): ProfileRuntimePreflight {
  return {
    harness: 'codex',
    existentes: new Map([['AGENTS.md', runtime.current]]),
    materialize: (revision): PreparedProfileRuntime => ({
      revision,
      documents: ['AGENTS.md'],
      harness: 'codex',
      preview: [{
        nombre: 'AGENTS.md',
        politica: 'bloque-gestionado',
        texto: runtime.projected,
        unidades: runtime.projected.length,
      }],
      verification: {
        state: 'drifted',
        generation: runtime.generation,
        container_id: 'container-atlas',
        observed_at: '2026-09-05T20:00:00.000Z',
        documents: [{
          name: 'AGENTS.md',
          path: PATH,
          expected_sha: sha(runtime.projected),
          observed_sha: sha(runtime.current),
          expected_bytes: Buffer.byteLength(runtime.projected, 'utf8'),
          observed_bytes: Buffer.byteLength(runtime.current, 'utf8'),
          current: false,
        }],
      },
      apply: runtime.apply,
    }),
  };
}

interface ServerFixture {
  readonly app: FastifyInstance;
  readonly runtime: RuntimeFixture;
  readonly audits: TerminalAuditEntry[];
  readonly events: string[];
  readonly recordExpectation: ReturnType<typeof vi.fn>;
  readonly recordRevision: ReturnType<typeof vi.fn>;
  readonly deps: AgentContextReconcileDeps;
}

function server(overrides: Partial<AgentContextReconcileDeps> = {}): ServerFixture {
  const app = Fastify();
  const runtime = runtimeFixture();
  const audits: TerminalAuditEntry[] = [];
  const events: string[] = [];
  const originalApply = runtime.apply;
  runtime.apply = vi.fn(async () => {
    events.push('apply');
    return await originalApply();
  });
  const recordExpectation = vi.fn(async (_input: unknown) => { events.push('expectation'); });
  const recordRevision = vi.fn(async (_input: unknown) => { events.push('revision'); });
  const deps: AgentContextReconcileDeps = {
    authorize: async () => ACTOR,
    authorizeTarget: async () => TARGET,
    resolveOperator: async () => OPERATOR,
    readContext: async () => ({
      contexto: contexto(), exists: true, revision: REVISION, applied_revision: REVISION,
    }),
    prepareRuntime: async () => preflight(runtime),
    readRuntimeExpectation: async () => ({
      revision: REVISION,
      generation: runtime.generation,
      documents: [{ name: 'AGENTS.md', path: PATH, sha: sha('prior expectation') }],
    }),
    deliveryInFlight: async () => ({ count: 0, deliveries: [] }),
    coordinateWrite: (input) => coordinateWriteFixture(input, async (sql, values) => {
      if (sql.includes('agent_profile_runtime_expectations')) await recordExpectation({ revision: values[2],
        generation: values[3], documents: JSON.parse(String(values[4])) as unknown });
      if (sql.includes('agent_document_revisions')) await recordRevision({ path: values[2], sha256: values[3], bytes: values[4] });
      if (sql.includes('audit_events')) events.push('audit:result');
    }, runtime.generation),
    recordAudit: async (entry) => {
      audits.push(entry);
      const phase = Reflect.get(entry.metadata, 'phase');
      events.push(`audit:${String(phase)}`);
    },
    ...overrides,
  };
  registerAgentContextReconcileRoutes(app, deps);
  return { app, runtime, audits, events, recordExpectation, recordRevision, deps };
}

function previewBody(): Record<string, unknown> {
  return { reason: REASON };
}

function applyBody(runtime: RuntimeFixture, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reason: REASON,
    expected_revision: REVISION,
    expected_runtime_generation: runtime.generation,
    preserve_external: true,
    documents: [{
      name: 'AGENTS.md',
      observed_sha: sha(runtime.current),
      exterior_sha: sha(sinBloqueDePerfil(runtime.current)),
    }],
    ...extra,
  };
}

const live: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map(async (app) => app.close()));
});

describe('context reconciliation', () => {
  it('returns an audited read-only preview with the exact CAS contract', async () => {
    const fixture = server();
    live.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/preview',
      payload: previewBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      tenant_id: 'Miguel',
      alias: 'atlas',
      expected_revision: REVISION,
      expected_runtime_generation: GENERATION,
      preserve_external: true,
      documents: [{
        name: 'AGENTS.md',
        observed_sha: sha(CURRENT),
        exterior_sha: sha(EXTERIOR),
      }],
    });
    expect(fixture.runtime.apply).not.toHaveBeenCalled();
    expect(fixture.recordExpectation).not.toHaveBeenCalled();
    expect(fixture.audits).toHaveLength(1);
    expect(fixture.audits[0]).toMatchObject({
      action: 'agent_document.read', decision: 'allow',
      metadata: { operation: 'context_reconcile', phase: 'preview', attributed: true },
    });
  });

  it('applies only after durable intent and records expectation from an exact ACK', async () => {
    const fixture = server();
    live.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/apply',
      payload: applyBody(fixture.runtime),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      state: 'pending_session_refresh',
      evidence: 'runtime_verification',
      tenant_id: 'Miguel',
      alias: 'atlas',
      revision: REVISION,
      preserve_external: true,
      contaminacion: { contaminated: false, findings: [] },
      documents: [{
        name: 'AGENTS.md', path: PATH, sha_before: sha(CURRENT),
        sha_after: sha(PROJECTED), bytes: Buffer.byteLength(PROJECTED, 'utf8'),
      }],
      runtime_verification: { state: 'current', generation: GENERATION },
    });
    expect(fixture.events).toEqual([
      'audit:intent', 'apply', 'expectation', 'revision', 'audit:result',
    ]);
    expect(fixture.recordExpectation).toHaveBeenCalledWith(expect.objectContaining({
      revision: REVISION,
      generation: GENERATION,
      documents: [{ name: 'AGENTS.md', path: PATH, sha: sha(PROJECTED) }],
    }));
  });

  it('preserves concurrent runtime bytes when the batch CAS rejects its measured SHA', async () => {
    let disk = CURRENT;
    const concurrent = managed(EXTERIOR, 'cambio concurrente');
    const probe: AgentFactsProbe = {
      factsFor: async () => ({
        source: 'measured',
        facts: {
          harness: 'codex',
          home: '/home/dev',
          codexHome: '/home/dev/.codex',
          generation: GENERATION,
          containerId: 'container-atlas',
        },
      }),
      readGovernanceDocument: async () => ({
        text: disk,
        sha: sha(disk),
        bytes: Buffer.byteLength(disk, 'utf8'),
        truncated: false,
        modified_at: '2026-09-05T20:00:00.000Z',
      }),
      listMemoryDirectory: async () => ({ error: 'unavailable', reason: 'not used' }),
      writeGovernanceBatchDurable: async (batch) => {
        disk = concurrent;
        const write = batch[0];
        if (write?.precondition.state !== 'present'
          || write.precondition.sha256 !== sha(disk)) {
          return { error: 'conflict', reason: 'stale write' };
        }
        throw new Error('the stale CAS unexpectedly admitted the write');
      },
    };
    const fixture = server({
      prepareRuntime: (tenantId, alias, profileContext) =>
        prepareAgentProfileRuntime(probe, tenantId, alias, profileContext),
    });
    live.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/apply',
      payload: applyBody(fixture.runtime),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'context_reconcile_effect_unknown' });
    expect(disk).toBe(concurrent);
    expect(fixture.recordExpectation).not.toHaveBeenCalled();
    expect(fixture.recordRevision).not.toHaveBeenCalled();
  });

  it('requires an attributed human even for preview', async () => {
    const fixture = server({
      resolveOperator: async () => ({ operator_id: 'sin-persona', attributed: false }),
    });
    live.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/preview',
      payload: previewBody(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: 'forbidden', reason: 'writable_requires_attribution',
    });
    expect(fixture.runtime.apply).not.toHaveBeenCalled();
  });

  it('reports an unknown effect when the atomic post-ACK commit cannot be confirmed', async () => {
    const fixture = server({
      coordinateWrite: async (input) => {
        await input.dispatch(FIXTURE_WRITE_OPERATION);
        return { state: 'effect_unknown', operation_id: FIXTURE_WRITE_OPERATION.operationId };
      },
    });
    live.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/apply',
      payload: applyBody(fixture.runtime),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: 'context_reconcile_effect_unknown', state: 'effect_unknown',
    });
    expect(fixture.runtime.apply).toHaveBeenCalledOnce();
    expect(fixture.recordExpectation).not.toHaveBeenCalled();
    expect(fixture.audits.at(-1)).toMatchObject({
      action: 'agent_document.write', decision: 'info',
      metadata: { phase: 'effect_unknown' },
    });
  });

  it('does not record a new expectation from an incomplete ACK', async () => {
    const fixture = server();
    fixture.runtime.apply = vi.fn(async () => []);
    live.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/apply',
      payload: applyBody(fixture.runtime),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'context_reconcile_effect_unknown' });
    expect(fixture.recordExpectation).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign block', managed(EXTERIOR, 'ajeno', 'Steven/zeus'), 'context_contaminated'],
    ['missing block', EXTERIOR, 'context_contaminated'],
  ])('quarantines a %s without writing', async (_case, current, code) => {
    const fixture = server();
    fixture.runtime.current = current;
    live.push(fixture.app);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/preview',
      payload: previewBody(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: code });
    expect(fixture.runtime.apply).not.toHaveBeenCalled();
  });
});
