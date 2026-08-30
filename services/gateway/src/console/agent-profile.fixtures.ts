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

