import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conBloqueDePerfil, sinBloqueDePerfil, type ContextoDeAlias } from '@cauce/protocol';
import {
  registerAgentContextReconcileRoutes, type AgentContextReconcileDeps,
} from './agent-context-reconcile.routes.js';
import { ContextReconcileError } from './agent-context-reconcile.js';
import type { TerminalAuditEntry } from './agent-documents.routes.js';
import type { AgentFactsProbe, GovernanceBatchWrite } from './agent-documents.routes.js';
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
    reconcileRuntime: async (input) => {
      try {
        const effect = await input.apply();
        await recordExpectation(effect.expectation);
        for (const document of effect.documentRevisions) await recordRevision(document);
        events.push('audit:result');
        return { state: 'committed', value: effect.value };
      } catch {
        return { state: 'effect_unknown' };
      }
    },
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

  it('uses the canonical batch CAS to replace only the managed block', async () => {
    let disk = CURRENT;
    const writes: GovernanceBatchWrite[][] = [];
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
      writeGovernanceBatch: async (batch) => {
        writes.push([...batch]);
        const write = batch[0];
        if (batch.length !== 1 || write?.mode !== 'write'
          || write.precondition.state !== 'present'
          || write.precondition.sha256 !== sha(disk)) {
          return { error: 'conflict', reason: 'stale write' };
        }
        disk = write.content;
        return [{
          path: write.path,
          operation: 'replace',
          sha: sha(disk),
          bytes: Buffer.byteLength(disk, 'utf8'),
        }];
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

    expect(response.statusCode).toBe(200);
    expect(writes).toHaveLength(1);
    expect(sinBloqueDePerfil(disk)).toBe(EXTERIOR);
    expect(disk).not.toContain('bloque observado');
    expect(disk).toContain('<!-- alias: Miguel/atlas -->');
  });

  it('does not write when durable intent cannot be recorded', async () => {
    const fixture = server({
      recordAudit: async (entry) => {
        if (Reflect.get(entry.metadata, 'phase') === 'intent') throw new Error('audit unavailable');
      },
    });
    live.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/apply',
      payload: applyBody(fixture.runtime),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'context_reconcile_intent_not_recorded' });
    expect(fixture.runtime.apply).not.toHaveBeenCalled();
    expect(fixture.recordExpectation).not.toHaveBeenCalled();
    expect(fixture.recordRevision).not.toHaveBeenCalled();
    expect(fixture.events).not.toContain('apply');
    expect(fixture.events).not.toContain('audit:result');
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
      writeGovernanceBatch: async (batch) => {
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

  it('lets the transactional fence reject work acquired after the snapshot', async () => {
    const fixture = server({
      reconcileRuntime: async () => {
        throw new ContextReconcileError('delivery_in_flight', 'work acquired before the fence');
      },
    });
    live.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/apply',
      payload: applyBody(fixture.runtime),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'delivery_in_flight' });
    expect(fixture.runtime.apply).not.toHaveBeenCalled();
    expect(fixture.events).toContain('audit:intent');
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
      reconcileRuntime: async (input) => {
        await input.apply();
        return { state: 'effect_unknown' };
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

  it('journals an exact already-current ACK when retrying an unknown effect', async () => {
    const fixture = server();
    fixture.runtime.apply = vi.fn(async () => [{
      ...ack(fixture.runtime), state: 'already_current' as const,
    }]);
    live.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/apply',
      payload: applyBody(fixture.runtime),
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.recordRevision).toHaveBeenCalledOnce();
    expect(fixture.recordRevision).toHaveBeenCalledWith(expect.objectContaining({
      path: PATH, sha256: sha(PROJECTED), bytes: Buffer.byteLength(PROJECTED, 'utf8'),
    }));
  });

  it('reports when only the durable intent survives an unknown-effect audit failure', async () => {
    const fixture = server({
      reconcileRuntime: async (input) => {
        await input.apply();
        return { state: 'effect_unknown' };
      },
      recordAudit: async (entry) => {
        if (Reflect.get(entry.metadata, 'phase') === 'effect_unknown') {
          throw new Error('audit unavailable');
        }
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
      error: 'context_reconcile_effect_unknown_audit_failed', state: 'effect_unknown',
    });
    expect(fixture.runtime.apply).toHaveBeenCalledOnce();
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
    ['revision', { expected_revision: REVISION - 1 }],
    ['generation', { expected_runtime_generation: 'generation-old' }],
    ['observed SHA', { documents: [{
      name: 'AGENTS.md', observed_sha: sha('changed'), exterior_sha: sha(EXTERIOR),
    }] }],
    ['exterior SHA', { documents: [{
      name: 'AGENTS.md', observed_sha: sha(CURRENT), exterior_sha: sha('changed exterior'),
    }] }],
  ])('rejects a stale %s preview without applying', async (_field, changed) => {
    const fixture = server();
    live.push(fixture.app);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/apply',
      payload: applyBody(fixture.runtime, changed),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'reconcile_snapshot_conflict' });
    expect(fixture.runtime.apply).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown field', { ...previewBody(), extra: true }],
    ['missing confirmation', {
      reason: REASON,
      expected_revision: REVISION,
      expected_runtime_generation: GENERATION,
      documents: [{ name: 'AGENTS.md', observed_sha: sha(CURRENT), exterior_sha: sha(EXTERIOR) }],
    }],
    ['duplicate documents', {
      ...applyBody(runtimeFixture()),
      documents: [
        { name: 'AGENTS.md', observed_sha: sha(CURRENT), exterior_sha: sha(EXTERIOR) },
        { name: 'AGENTS.md', observed_sha: sha(CURRENT), exterior_sha: sha(EXTERIOR) },
      ],
    }],
    ['invalid hash', {
      ...applyBody(runtimeFixture()),
      documents: [{ name: 'AGENTS.md', observed_sha: 'short', exterior_sha: sha(EXTERIOR) }],
    }],
  ])('rejects an exact-schema violation: %s', async (_case, payload) => {
    const fixture = server();
    live.push(fixture.app);
    const url = 'expected_revision' in payload
      ? '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/apply'
      : '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/preview';
    const response = await fixture.app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_input' });
    expect(fixture.runtime.apply).not.toHaveBeenCalled();
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

  it('rejects an exact expectation document-set mismatch', async () => {
    const fixture = server({
      readRuntimeExpectation: async () => ({
        revision: REVISION,
        generation: GENERATION,
        documents: [
          { name: 'AGENTS.md', path: PATH, sha: sha('prior') },
          { name: 'EXTRA.md', path: '/home/dev/EXTRA.md', sha: sha('extra') },
        ],
      }),
    });
    live.push(fixture.app);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/preview',
      payload: previewBody(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'document_set_conflict' });
  });

  it.each([
    ['missing', new Map<string, string>()],
    ['extra', new Map([['AGENTS.md', CURRENT], ['EXTRA.md', 'extra']])],
  ])('rejects a %s runtime document from the exact managed set', async (_case, existing) => {
    const measured = runtimeFixture();
    const fixture = server({
      prepareRuntime: async () => ({ ...preflight(measured), existentes: existing }),
    });
    live.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/preview',
      payload: previewBody(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'document_set_conflict' });
    expect(measured.apply).not.toHaveBeenCalled();
  });

  it.each([
    ['revision', { revision: REVISION - 1, generation: GENERATION }],
    ['generation', { revision: REVISION, generation: 'generation-old' }],
  ])('rejects a server-side expectation %s mismatch', async (_case, changed) => {
    const fixture = server({
      readRuntimeExpectation: async () => ({
        ...changed,
        documents: [{ name: 'AGENTS.md', path: PATH, sha: sha('prior') }],
      }),
    });
    live.push(fixture.app);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/preview',
      payload: previewBody(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: _case === 'revision' ? 'profile_revision_conflict' : 'runtime_generation_conflict',
    });
    expect(fixture.runtime.apply).not.toHaveBeenCalled();
  });

  it('rechecks in-flight work at apply time', async () => {
    const deliveryInFlight = vi.fn()
      .mockResolvedValueOnce({ count: 0, deliveries: [] })
      .mockResolvedValueOnce({
        count: 1,
        deliveries: [{ delivery_id: 'not-returned', status: 'started', claimed_at: null, deadline_at: null }],
      });
    const fixture = server({ deliveryInFlight });
    live.push(fixture.app);
    const preview = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/preview',
      payload: previewBody(),
    });
    expect(preview.statusCode).toBe(200);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/apply',
      payload: applyBody(fixture.runtime),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'delivery_in_flight' });
    expect(fixture.runtime.apply).not.toHaveBeenCalled();
  });

  it('rejects a projection that would alter the confirmed exterior', async () => {
    const fixture = server();
    fixture.runtime.projected = managed('# Otro exterior\n', 'bloque durable');
    live.push(fixture.app);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/preview',
      payload: previewBody(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'external_context_changed' });
    expect(fixture.runtime.apply).not.toHaveBeenCalled();
  });

  it('does not rewrite when the expectation already matches the observed document', async () => {
    const fixture = server({
      readRuntimeExpectation: async () => ({
        revision: REVISION,
        generation: GENERATION,
        documents: [{ name: 'AGENTS.md', path: PATH, sha: sha(CURRENT) }],
      }),
    });
    live.push(fixture.app);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v3/console/tenants/Miguel/agents/atlas/context/reconcile/preview',
      payload: previewBody(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'context_not_drifted' });
    expect(fixture.runtime.apply).not.toHaveBeenCalled();
  });
});
