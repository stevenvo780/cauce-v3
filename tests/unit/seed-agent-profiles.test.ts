import { describe, expect, it } from 'vitest';
import {
  applyRoster, capitalizeTenant, composeHumanBrief, inspectRoster, parseGroupsRoster, verifyRoster,
  type AgentProfileLike,
} from '../../deploy/runtime/seed-agent-profiles-core.mjs';

function key(tenantId: string, alias: string): string {
  return `${tenantId}/${alias}`;
}

function emptyPerfil(tenantId: string, alias: string): AgentProfileLike {
  return {
    tenant_id: tenantId, alias, purpose: null, role_summary: null, human_brief: null,
    responsibilities: [], restrictions: [], tools: [], operating_rules: [],
  };
}

/** Minimal in-memory stand-in for `AgentProfileRepository`: same two async methods, CAS included. */
class FakeAgentProfileRepository {
  readonly rows = new Map<string, { perfil: AgentProfileLike; revision: number }>();
  readonly replaceCalls: Array<{ input: AgentProfileLike; expectedRevision: number | null }> = [];
  /** Set from a test to bump a row's revision right after it is read, simulating a racing writer. */
  onRead?: (tenantId: string, alias: string) => void;

  seed(tenantId: string, alias: string, overrides: Partial<AgentProfileLike>, revision = 1): void {
    this.rows.set(key(tenantId, alias), { perfil: { ...emptyPerfil(tenantId, alias), ...overrides }, revision });
  }

  bumpRevision(tenantId: string, alias: string): void {
    const row = this.rows.get(key(tenantId, alias));
    if (row) row.revision += 1;
  }

  async readWithPresence(tenantId: string, alias: string) {
    const row = this.rows.get(key(tenantId, alias));
    const result = row === undefined
      ? { perfil: emptyPerfil(tenantId, alias), exists: false, revision: null, applied_revision: null }
      : { perfil: { ...row.perfil }, exists: true, revision: row.revision, applied_revision: null };
    this.onRead?.(tenantId, alias);
    return result;
  }

  async replace(input: AgentProfileLike, expectedRevision: number | null) {
    this.replaceCalls.push({ input, expectedRevision });
    const k = key(input.tenant_id, input.alias);
    const row = this.rows.get(k);
    if (row === undefined || row.revision !== expectedRevision) {
      throw new Error(`agent profile revision changed from ${String(expectedRevision)}`);
    }
    const nextRevision = row.revision + 1;
    this.rows.set(k, { perfil: { ...input }, revision: nextRevision });
    return { perfil: { ...input }, exists: true, revision: nextRevision, applied_revision: null };
  }
}

const groupsFixture = {
  grupos: [
    { nombre: 'steven', agentes: [{ nombre: 'zeus', rol: 'Encargado de la gestión de Cuce' }] },
    { nombre: 'jhon', agentes: [{ nombre: 'tales', rol: 'Desarrollador para lo que sea que necesite Jhon' }] },
  ],
};

describe('parseGroupsRoster', () => {
  it('flattens every group into one entry per agent, deriving tenant_id from the group name', () => {
    expect(parseGroupsRoster(groupsFixture)).toEqual([
      { tenantId: 'Steven', group: 'steven', alias: 'zeus', rol: 'Encargado de la gestión de Cuce' },
      { tenantId: 'Jhon', group: 'jhon', alias: 'tales', rol: 'Desarrollador para lo que sea que necesite Jhon' },
    ]);
  });

  it('capitalizes only the first letter of the group name', () => {
    expect(capitalizeTenant('isa')).toBe('Isa');
    expect(capitalizeTenant('miguel')).toBe('Miguel');
  });

  it.each([
    [{}, /grupos" array/u],
    [{ grupos: [{ agentes: [] }] }, /nombre/u],
    [{ grupos: [{ nombre: 'steven' }] }, /agentes" array/u],
    [{ grupos: [{ nombre: 'steven', agentes: [{ nombre: 'zeus' }] }] }, /nombre.*rol/u],
    [
      { grupos: [{ nombre: 'steven', agentes: [{ nombre: 'zeus', rol: 'a' }, { nombre: 'zeus', rol: 'b' }] }] },
      /duplicate alias/u,
    ],
  ])('rejects a malformed document %#', (document, expected) => {
    expect(() => parseGroupsRoster(document)).toThrow(expected);
  });
});

describe('composeHumanBrief', () => {
  it('is one sentence naming tenant, group and role', () => {
    expect(composeHumanBrief({ tenantId: 'Steven', group: 'steven', rol: 'Zeus rol' }))
      .toBe('Agente de Steven (grupo steven); rol: Zeus rol');
  });
});

describe('inspectRoster', () => {
  it('reports whether the stored purpose already matches the target role, without writing', async () => {
    const repository = new FakeAgentProfileRepository();
    repository.seed('Steven', 'zeus', { purpose: 'stale role', role_summary: 'kept' }, 3);
    const roster = parseGroupsRoster(groupsFixture);

    const rows = await inspectRoster(repository, roster);

    expect(rows).toEqual([
      {
        tenant_id: 'Steven', group: 'steven', alias: 'zeus', exists: true, revision: 3,
        applied_revision: null, current_purpose: 'stale role',
        target_purpose: 'Encargado de la gestión de Cuce', already_seeded: false,
      },
      {
        tenant_id: 'Jhon', group: 'jhon', alias: 'tales', exists: false, revision: null,
        applied_revision: null, current_purpose: null,
        target_purpose: 'Desarrollador para lo que sea que necesite Jhon', already_seeded: false,
      },
    ]);
    expect(repository.replaceCalls).toHaveLength(0);
  });
});

describe('applyRoster', () => {
  it('writes purpose and human_brief while preserving every other field, using the CAS revision', async () => {
    const repository = new FakeAgentProfileRepository();
    repository.seed('Steven', 'zeus', {
      purpose: 'stale role', role_summary: 'kept role summary',
      responsibilities: ['kept responsibility'], tools: ['kept-tool'],
    }, 3);
    const roster = parseGroupsRoster(groupsFixture);

    const results = await applyRoster(repository, roster);

    expect(results[0]).toMatchObject({
      tenant_id: 'Steven', alias: 'zeus', status: 'written', previous_revision: 3, revision: 4,
    });
    expect(repository.replaceCalls[0]).toMatchObject({
      expectedRevision: 3,
      input: {
        purpose: 'Encargado de la gestión de Cuce',
        human_brief: 'Agente de Steven (grupo steven); rol: Encargado de la gestión de Cuce',
        role_summary: 'kept role summary',
        responsibilities: ['kept responsibility'],
        tools: ['kept-tool'],
      },
    });
    // No agent_profiles row for tales: skipped, never written.
    expect(results[1]).toEqual({ tenant_id: 'Jhon', alias: 'tales', status: 'skipped-no-profile-row' });
    expect(repository.replaceCalls).toHaveLength(1);
  });

  it('is idempotent: a purpose that already matches the target role is never re-written', async () => {
    const repository = new FakeAgentProfileRepository();
    repository.seed('Steven', 'zeus', { purpose: 'Encargado de la gestión de Cuce' }, 7);
    const roster = parseGroupsRoster(groupsFixture).filter((entry) => entry.alias === 'zeus');

    const results = await applyRoster(repository, roster);

    expect(results).toEqual([{ tenant_id: 'Steven', alias: 'zeus', status: 'skipped-already-seeded', revision: 7 }]);
    expect(repository.replaceCalls).toHaveLength(0);
  });

  it('records a conflict instead of throwing when the revision moved between read and write', async () => {
    const repository = new FakeAgentProfileRepository();
    repository.seed('Steven', 'zeus', { purpose: 'stale role' }, 3);
    repository.onRead = (tenantId, alias) => { repository.bumpRevision(tenantId, alias); };
    const roster = parseGroupsRoster(groupsFixture).filter((entry) => entry.alias === 'zeus');

    const results = await applyRoster(repository, roster);

    expect(results).toEqual([{
      tenant_id: 'Steven', alias: 'zeus', status: 'error',
      message: 'agent profile revision changed from 3',
    }]);
  });
});

describe('verifyRoster', () => {
  it('confirms purpose and human_brief landed, and reports a missing row as unmatched', async () => {
    const repository = new FakeAgentProfileRepository();
    repository.seed('Steven', 'zeus', {
      purpose: 'Encargado de la gestión de Cuce',
      human_brief: 'Agente de Steven (grupo steven); rol: Encargado de la gestión de Cuce',
    }, 4);
    const roster = parseGroupsRoster(groupsFixture);

    const rows = await verifyRoster(repository, roster);

    expect(rows).toEqual([
      { tenant_id: 'Steven', alias: 'zeus', exists: true, revision: 4, purpose_matches: true, human_brief_matches: true },
      { tenant_id: 'Jhon', alias: 'tales', exists: false, revision: null, purpose_matches: false, human_brief_matches: false },
    ]);
  });
});
