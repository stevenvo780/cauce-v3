import { describe, expect, it, vi } from 'vitest';
import { AgentProfileRepository } from '../src/agent-profile.js';
import type { DatabasePool } from '../src/db.js';

function poolWith(rows: Record<string, unknown>[]): DatabasePool {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
  } as unknown as DatabasePool;
}

describe('AgentProfileRepository.readWithPresence', () => {
  it('una fila persistida completamente vacía existe', async () => {
    const repo = new AgentProfileRepository(poolWith([{
      tenant_id: 'Steven', alias: 'kant',
      purpose: null, role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
      revision: '3', applied_revision: '2',
    }]));

    const result = await repo.readWithPresence('Steven', 'kant');

    expect(result.exists).toBe(true);
    expect(result.perfil).toMatchObject({
      tenant_id: 'Steven', alias: 'kant', purpose: null, tools: [],
    });
    expect(result).toMatchObject({ revision: 3, applied_revision: 2 });
  });

  it('sin fila devuelve el perfil neutro pero exists=false', async () => {
    const repo = new AgentProfileRepository(poolWith([]));

    const result = await repo.readWithPresence('Miguel', 'kant');

    expect(result.exists).toBe(false);
    expect(result.revision).toBeNull();
    expect(result.applied_revision).toBeNull();
    expect(result.perfil).toMatchObject({ tenant_id: 'Miguel', alias: 'kant', purpose: null });
  });
});
