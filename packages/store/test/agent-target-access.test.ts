import { describe, expect, it, vi } from 'vitest';
import { CauceRepository } from '../src/repository.js';
import type { DatabasePool } from '../src/db.js';

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fixture(targetRows: Record<string, unknown>[]) {
  const calls: QueryCall[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' '), params });
      if (sql.includes('FROM agents agent')) return { rows: targetRows, rowCount: targetRows.length };
      return { rows: [{ permitted: true }], rowCount: 1 };
    }),
  } as unknown as DatabasePool;
  return { repo: new CauceRepository(pool), calls };
}

describe('CauceRepository.authorizeAgentTarget', () => {
  it('elige el alias por tenant y alias exactos aunque el nombre se repita', async () => {
    const target = {
      tenant_id: 'Miguel', alias: 'kant', harness_id: 'codex', home_directory: '/home/miguel', enabled: true,
    };
    const { repo, calls } = fixture([target]);

    const result = await repo.authorizeAgentTarget('Steven', 'zeus', 'Miguel', 'kant', 'read');

    expect(result).toEqual(target);
    const lookup = calls.find((call) => call.sql.includes('FROM agents agent'));
    expect(lookup?.params).toEqual(['Steven', 'zeus', 'Miguel', 'kant', 'read']);
    expect(lookup?.sql).toContain('agent.tenant_id=$3 AND agent.alias=$4');
    expect(lookup?.sql).toContain('edge.allow_read');
  });

  it('deniega por defecto cuando no existe la arista actor→tenant destino', async () => {
    const { repo } = fixture([]);

    await expect(repo.authorizeAgentTarget('Steven', 'zeus', 'Miguel', 'kant', 'read'))
      .resolves.toBeUndefined();
  });

  it('una escritura cross-tenant exige control tanto al actor como a la arista', async () => {
    const { repo, calls } = fixture([{
      tenant_id: 'Miguel', alias: 'kant', harness_id: null, home_directory: null, enabled: true,
    }]);

    await repo.authorizeAgentTarget('Steven', 'zeus', 'Miguel', 'kant', 'control');

    expect(calls[0]?.sql).toContain('role.allow_control');
    expect(calls.find((call) => call.sql.includes('FROM agents agent'))?.sql)
      .toContain('edge.allow_control');
  });

  it('el control de un agente disabled falla cerrado, aunque la lectura siga siendo explícita', async () => {
    const { repo, calls } = fixture([]);

    await expect(repo.authorizeAgentTarget('Steven', 'zeus', 'Steven', 'apagado', 'control'))
      .resolves.toBeUndefined();

    const lookup = calls.find((call) => call.sql.includes('FROM agents agent'));
    expect(lookup?.params).toEqual(['Steven', 'zeus', 'Steven', 'apagado', 'control']);
    expect(lookup?.sql).toContain("($5::text='read' OR agent.enabled)");
  });
});
