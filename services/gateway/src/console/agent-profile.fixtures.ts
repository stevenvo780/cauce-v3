import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@cauce/store';
import type { ContextWriteCoordinateInput, CoordinateResult } from './agent-context-write-coordinator.js';
import type {
  AgentProfileDeps, PreparedProfileRuntime, ProfileRuntimePreflight,
} from './agent-profile.routes.js';
import type { ContextoDeAlias } from '@cauce/protocol';
import { createHash } from 'node:crypto';

export const ACTOR = { tenant_id: 'Steven', alias: 'zeus' };

export function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function contexto(parcial: Partial<ContextoDeAlias['perfil']>, harness: string): ContextoDeAlias {
  return {
    perfil: {
      tenant_id: 'Steven', alias: 'zeus',
      purpose: null, role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
      ...parcial
    },
    hechos: {
      permisos: { ruta: true, lectura: true, control: false, notificacion: true },
      cuotas: [{ proveedor: 'claude', cuenta: 'saldantia', limite: '3% semanal' }],
      arnes: { harness, home: '/home/dev', contenedor: 'ws-zeus', capacidades: ['bash', 'read'] },
      destinos: ['kant', 'argos']
    }
  };
}


export const PERFIL_BODY = {
  purpose: 'coordinar la flota',
  role_summary: 'coordinador',
  human_brief: 'Steven, directo',
  responsibilities: ['coordinar'],
  restrictions: ['no tocar secretos'],
  tools: ['cauce'],
  operating_rules: ['verificar'],
};

export const REPLACE_PROFILE: NonNullable<AgentProfileDeps['replaceProfile']> = async (profile) => ({
  perfil: profile, exists: true, revision: 2, applied_revision: 1,
});
export const RUNTIME_VERIFICATION = {
  state: 'current' as const,
  generation: 'gen-1',
  container_id: 'ws-zeus',
  observed_at: '2026-08-26T00:00:00.000Z',
  documents: [{
    name: 'AGENTS.md', path: '/home/dev/.codex/AGENTS.md',
    expected_sha: sha('nuevo'), observed_sha: sha('nuevo'),
    expected_bytes: 5, observed_bytes: 5, current: true,
  }],
};
export const RUNTIME_ADOPTION: NonNullable<AgentProfileDeps['readRuntimeAdoption']> = async (
  _tenant, _alias, revision, verification,
) => ({
  evidence: 'adapter_delivery', revision,
  generation: verification.generation ?? 'sin-generacion',
  adopted_at: '2026-08-26T00:01:00.000Z',
  documents: verification.documents.map((document) => ({
    name: document.name, path: document.path, sha: document.expected_sha,
  })),
});
export function preparedRuntime(
  revision: number,
  overrides: Partial<PreparedProfileRuntime> = {},
): PreparedProfileRuntime {
  return {
    revision,
    documents: ['AGENTS.md'],
    harness: 'codex',
    preview: [{ nombre: 'AGENTS.md', politica: 'bloque-gestionado', texto: 'nuevo', unidades: 5 }],
    verification: RUNTIME_VERIFICATION,
    apply: async () => ([{
      name: 'AGENTS.md', path: '/home/dev/.codex/AGENTS.md', state: 'written',
      sha: sha('nuevo'), bytes: 5, generation: 'gen-1', container_id: 'ws-zeus',
    }]),
    ...overrides,
  };
}

export function runtimePreflight(
  materialize: (revision: number) => PreparedProfileRuntime = preparedRuntime,
  harness = 'codex',
): ProfileRuntimePreflight {
  return { harness, materialize };
}

export const PREPARE_RUNTIME: NonNullable<AgentProfileDeps['prepareRuntime']> = async () =>
  runtimePreflight();
export const MARK_PROFILE_APPLIED: NonNullable<AgentProfileDeps['markProfileApplied']> = async (
  _tenant, _alias, revision,
) => ({
  perfil: contexto(PERFIL_BODY, 'codex').perfil,
  exists: true,
  revision,
  applied_revision: revision,
});


export const FIXTURE_WRITE_OPERATION = {
  operationId: randomUUID(), operationToken: randomUUID(), operationGeneration: randomUUID(), runtimeGeneration: 'gen-1',
};

export async function coordinateWriteFixture<T>(input: ContextWriteCoordinateInput<T>,
  onQuery: (sql: string, values: readonly unknown[]) => Promise<void> = async () => undefined,
  runtimeGeneration = 'gen-1',
): Promise<CoordinateResult<T>> {
  try {
    const client = { query: async (sql: string, values: readonly unknown[] = []) => {
      await onQuery(sql, values);
      return { rows: [], rowCount: 1 };
    } } as unknown as DatabaseClient;
    await input.updateDesired?.(client);
    const value = await input.dispatch({ ...FIXTURE_WRITE_OPERATION, runtimeGeneration,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    await input.persistTarget(client, { operationId: FIXTURE_WRITE_OPERATION.operationId,
      token: FIXTURE_WRITE_OPERATION.operationToken, generation: FIXTURE_WRITE_OPERATION.operationGeneration,
      writer: { runtimeGeneration, containerId: 'fixture-container', writerInstanceId: randomUUID() },
      state: 'quiescent', durability: 'post_fsync',
      documents: input.documents.map((doc) => ({ name: doc.name, path: doc.path, sha: doc.targetSha })),
    }, value);
    return { state: 'committed', resolution: 'target', value };
  } catch {
    return { state: 'effect_unknown', operation_id: FIXTURE_WRITE_OPERATION.operationId };
  }
}

export function profileWriteFixtureDeps(overrides: Partial<AgentProfileDeps>, operator: { operator_id: string; attributed: boolean }): AgentProfileDeps {
  const ctx = contexto({ ...PERFIL_BODY, purpose: 'prior purpose' }, 'codex');
  return {
    authorize: async () => ACTOR,
    recordAudit: async () => undefined,
    resolveOperator: () => operator,
    authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias, enabled: true }),
    readContext: async () => ({
      contexto: ctx, exists: true, revision: 1, applied_revision: 1,
    }),
    replaceProfile: REPLACE_PROFILE,
    replaceProfileInTransaction: (_client, profile, revision, actor, source) =>
      source === undefined
        ? (overrides.replaceProfile ?? REPLACE_PROFILE)(profile, revision, actor)
        : (overrides.replaceProfile ?? REPLACE_PROFILE)(profile, revision, actor, source),
    recordAuditInTransaction: async (_client, entry) => { await overrides.recordAudit?.(entry); },
    readWriteExpectation: async () => undefined,
    coordinateWrite: (input) => coordinateWriteFixture(input, async (sql, values) => {
      if (sql.includes('agent_profile_runtime_expectations')) await overrides.recordRuntimeExpectation?.(input.tenantId, input.alias, Number(values[2]), {
        state: 'current', generation: String(values[3]), container_id: 'ws-zeus', observed_at: new Date(0).toISOString(),
        documents: RUNTIME_VERIFICATION.documents,
      });
    }),
    prepareRuntime: PREPARE_RUNTIME,
    readRuntimeAdoption: RUNTIME_ADOPTION,
    markProfileApplied: MARK_PROFILE_APPLIED,
    ...overrides,
  };
}

