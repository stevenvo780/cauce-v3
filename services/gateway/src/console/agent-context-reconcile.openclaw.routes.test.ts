import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { conBloqueDePerfil, esFicheroDelAgente, ficherosDelArnes, type ContextoDeAlias } from '@cauce/protocol';
import { registerAgentContextReconcileRoutes } from './agent-context-reconcile.routes.js';
import { prepareAgentProfileRuntime } from './agent-profile-runtime.js';
import type { AgentFactsProbe, GovernanceBatchWrite } from './agent-documents.routes.js';

const ROOT = '/home/claw/workspace';
const URL = '/v3/console/tenants/Miguel/agents/iza/context/reconcile';
const REASON = 'Revisar las notas locales y conservar todos sus bytes';
const live: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map(async (app) => app.close())); });

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function fixture(options: { truncatedMemory?: boolean; changedMemory?: boolean } = {}) {
  const context: ContextoDeAlias = {
    perfil: {
      tenant_id: 'Miguel', alias: 'iza', purpose: 'Asistente', role_summary: 'Operador',
      human_brief: null, responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    },
    hechos: {
      permisos: { ruta: true, lectura: true, control: true, notificacion: false }, cuotas: [],
      arnes: { harness: 'openclaw', home: '/home/claw', capacidades: [] }, destinos: [],
    },
  };
  const initial = new Map([
    ['TOOLS.md', '# Notas locales\n'], ['MEMORY.md', 'Recuerdo del agente\n'],
    ['HEARTBEAT.md', 'Tareas propias\n'],
  ]);
  const disk = new Map(ficherosDelArnes('openclaw', context, initial, { revision: 4 })
    .map((document) => [`${ROOT}/${document.nombre}`, document.texto]));
  const expectation = {
    revision: 4, generation: 'runtime-iza',
    documents: [...disk].filter(([path]) => !esFicheroDelAgente(path.slice(ROOT.length + 1)))
      .map(([path, text]) => ({ name: path.slice(ROOT.length + 1), path, sha: sha(text) })),
  };
  disk.set(`${ROOT}/TOOLS.md`, '# Notas locales\nCron corregido por el agente.\n');
  if (options.changedMemory) disk.set(`${ROOT}/MEMORY.md`, 'Recuerdo nuevo no leído\n');
  const before = new Map(disk);
  const writes: GovernanceBatchWrite[][] = [];
  const probe: AgentFactsProbe = {
    factsFor: async () => ({
      source: 'measured',
      facts: {
        harness: 'openclaw', home: '/home/claw', openclawWorkspace: ROOT,
        generation: 'runtime-iza', containerId: 'claw-iza',
      },
    }),
    readGovernanceDocument: async (path) => {
      const text = disk.get(path);
      if (text === undefined) return { error: 'not_found', reason: 'absent' };
      const truncated = options.truncatedMemory === true && path.endsWith('/MEMORY.md');
      return {
        text: truncated ? text.slice(0, 2) : text, sha: sha(text), bytes: Buffer.byteLength(text),
        truncated, modified_at: '2026-09-08T00:00:00.000Z',
      };
    },
    listMemoryDirectory: async () => ({ error: 'unavailable', reason: 'not used' }),
    writeGovernanceBatch: async (batch) => {
      writes.push([...batch]);
      if (batch.some((write) => write.precondition.state !== 'present'
        || write.precondition.sha256 !== sha(disk.get(write.path) ?? ''))) {
        return { error: 'conflict', reason: 'concurrent change' };
      }
      return batch.map((write) => {
        if (write.mode === 'write') disk.set(write.path, write.content);
        const text = disk.get(write.path) ?? '';
        return {
          path: write.path, operation: write.mode === 'verify' ? 'unchanged' as const : 'replace' as const,
          sha: sha(text), bytes: Buffer.byteLength(text),
        };
      });
    },
  };
  const recordExpectation = vi.fn();
  const app = Fastify();
  registerAgentContextReconcileRoutes(app, {
    authorize: async () => ({ tenant_id: 'Steven', alias: 'kant' }),
    authorizeTarget: async () => ({ tenant_id: 'Miguel', alias: 'iza', enabled: true }),
    resolveOperator: async () => ({ operator_id: 'steven', attributed: true }),
    readContext: async () => ({ contexto: context, exists: true, revision: 4, applied_revision: 4 }),
    readRuntimeExpectation: async () => expectation,
    prepareRuntime: (tenantId, alias, current) => prepareAgentProfileRuntime(probe, tenantId, alias, current),
    deliveryInFlight: async () => ({ count: 0, deliveries: [] }),
    reconcileRuntime: async (input) => {
      try {
        const effect = await input.apply();
        recordExpectation(effect.expectation);
        return { state: 'committed', value: effect.value };
      } catch {
        return { state: 'effect_unknown' };
      }
    },
    recordAudit: vi.fn(async () => undefined),
  });
  live.push(app);
  const preview = async () => app.inject({ method: 'POST', url: `${URL}/preview`, payload: { reason: REASON } });
  return { app, disk, before, writes, expectation, recordExpectation, preview };
}

it.each([{ truncatedMemory: false }, { truncatedMemory: true }, { truncatedMemory: true, changedMemory: true }])(
  'reconciles five authored documents while preserving seven runtime files: %j', async (options) => {
  const current = fixture(options);
  const preview = await current.preview();
  expect(preview.statusCode).toBe(200);
  const { expected_revision, expected_runtime_generation, documents } = preview.json<Record<string, unknown>>();
  expect(documents).toHaveLength(5);
  expect(current.writes).toHaveLength(0);
  const applied = await current.app.inject({
    method: 'POST', url: `${URL}/apply`,
    payload: { reason: REASON, expected_revision, expected_runtime_generation, documents, preserve_external: true },
  });
  expect(applied.statusCode).toBe(200);
  expect(applied.json()).toMatchObject({ contaminacion: { contaminated: false }, runtime_verification: { state: 'current' } });
  expect(current.writes).toHaveLength(1);
  expect(current.writes[0]?.filter((write) => write.mode === 'verify').map((write) => write.path).sort())
    .toEqual([`${ROOT}/HEARTBEAT.md`, `${ROOT}/MEMORY.md`]);
  expect(current.disk).toEqual(current.before);
  expect(current.recordExpectation).toHaveBeenCalledOnce();
  const stored: unknown = current.recordExpectation.mock.calls[0]?.[0];
  expect(stored).toEqual({ ...current.expectation, documents: current.expectation.documents
    .map((document) => ({ ...document, sha: sha(current.disk.get(document.path) ?? '') })) });
  expect(applied.json<{ runtime_verification: { documents: unknown[] } }>().runtime_verification.documents).toHaveLength(5);
});

it('rejects a foreign managed block', async () => {
  const name = 'TOOLS.md';
  const current = fixture();
  current.disk.set(`${ROOT}/${name}`, conBloqueDePerfil('', '<!-- alias: Steven/zeus -->\nForeign'));
  const response = await current.preview();
  expect(response.statusCode).toBe(409);
  expect(current.writes).toHaveLength(0);
  expect(current.recordExpectation).not.toHaveBeenCalled();
});

it('rejects a local edit made after preview without writing or adopting it', async () => {
  const current = fixture();
  const preview = await current.preview();
  expect(preview.statusCode).toBe(200);
  const { expected_revision, expected_runtime_generation, documents } = preview.json<Record<string, unknown>>();
  const concurrent = 'Otra corrección concurrente\n';
  current.disk.set(`${ROOT}/TOOLS.md`, concurrent);
  const applied = await current.app.inject({
    method: 'POST', url: `${URL}/apply`,
    payload: { reason: REASON, expected_revision, expected_runtime_generation, documents, preserve_external: true },
  });
  expect(applied.statusCode).toBe(409);
  expect(applied.json()).toMatchObject({ error: 'reconcile_snapshot_conflict' });
  expect(current.disk.get(`${ROOT}/TOOLS.md`)).toBe(concurrent);
  expect(current.writes).toHaveLength(0);
});
