import type { AgentPerfil } from '../../api/types';

/**
 * The applied profile of an alias, for the tests that exercise the editor from the keyboard. It
 * lives outside the test files because two of them need the same coherent snapshot —presence,
 * revision, verification and adoption— and a second copy would drift on the first correction.
 */

export const RUTA_PERFIL = 'http://localhost/v3/console/tenants/Steven/agents/kant/perfil';
export const SHA_PERFIL = 'a'.repeat(64);

const DOCUMENTO = { name: 'CLAUDE.md', path: '/home/stev/.claude/CLAUDE.md' };

export function perfilAplicado(
  revision = 4,
  overrides: Partial<Omit<AgentPerfil, 'publicado'>> = {},
): Omit<AgentPerfil, 'publicado'> {
  return {
    tenant_id: 'Steven', alias: 'kant', agent_enabled: true, exists: true, revision,
    applied_revision: revision, runtime_state: 'applied', harness: 'claude',
    runtime_verification: {
      state: 'current', generation: 'gen-4', container_id: 'ws-kant',
      observed_at: '2026-08-26T00:00:00Z',
      documents: [{
        ...DOCUMENTO, expected_sha: SHA_PERFIL, observed_sha: SHA_PERFIL,
        expected_bytes: 0, observed_bytes: 0, current: true,
      }],
    },
    runtime_adoption: {
      evidence: 'adapter_delivery', revision, generation: 'gen-4',
      adopted_at: '2026-08-26T00:01:00Z',
      documents: [{ ...DOCUMENTO, sha: SHA_PERFIL }],
    },
    perfil: {
      purpose: null, role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    },
    limites: { purpose: 2_000, role_summary: 4_000, item: 1_000, items: 64, total: 24_000 },
    medida: { unidades: 0, tope: 24_000 }, base: 'runtime-medido',
    ficheros: [{ nombre: 'CLAUDE.md', politica: 'bloque-gestionado', texto: '', unidades: 0 }],
    ...overrides,
  };
}

export function ackAplicado(revision: number) {
  return {
    ok: true, state: 'applied', tenant_id: 'Steven', alias: 'kant', revision,
    applied_revision: revision,
    acknowledgements: [{
      ...DOCUMENTO, state: 'written', sha: SHA_PERFIL, bytes: 18,
      generation: 'gen-4', container_id: 'ws-kant',
    }],
    runtime_adoption: {
      evidence: 'adapter_delivery', revision, generation: 'gen-4',
      adopted_at: '2026-08-26T00:01:00Z',
      documents: [{ ...DOCUMENTO, sha: SHA_PERFIL }],
    },
  };
}
