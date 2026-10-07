import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_AGENT_FAVORITES_PER_HUMAN, type AgentAppearance, type AgentFavorite,
} from '@cauce/protocol';
import {
  AgentAppearanceRevisionError, AgentFavoriteLimitError,
  type AgentAppearanceActor, type AgentAppearanceDenialRecord, type AgentAppearanceWrite,
  type AgentPreferencesRepository, type AgentTargetPermission, type AuthorizedAgentTarget,
} from '@cauce/store';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import type { ConsoleUser } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { MemoryConsoleUserStore } from '../../services/gateway/src/test-support/console-users.js';
import { buildTestGateway, fakePool, fakeRepository } from '../../services/gateway/src/test-support/gateway-doubles.js';
import { loginAs } from './gateway-human-accounts-fixtures.js';

const PASSWORD = 'synthetic-account-contract-password';
const ORIGIN = 'http://localhost';

class MemoryAgentPreferences implements AgentPreferencesRepository {
  readonly favorites = new Map<string, AgentFavorite[]>();
  readonly appearances = new Map<string, AgentAppearance>();
  readonly actors: AgentAppearanceActor[] = [];
  readonly denials: AgentAppearanceDenialRecord[] = [];
  readonly favoriteViewers: string[] = [];

  async listFavorites(humanId: string): Promise<AgentFavorite[]> {
    return [...(this.favorites.get(humanId) ?? [])];
  }

  async listAppearances(): Promise<AgentAppearance[]> {
    return [...this.appearances.values()];
  }

  async addFavorite(humanId: string, viewerTenant: string, tenantId: string, alias: string): Promise<void> {
    this.favoriteViewers.push(viewerTenant);
    const own = this.favorites.get(humanId) ?? [];
    if (own.some((item) => item.tenant_id === tenantId && item.alias === alias)) return;
    if (own.length >= MAX_AGENT_FAVORITES_PER_HUMAN) throw new AgentFavoriteLimitError(MAX_AGENT_FAVORITES_PER_HUMAN);
    this.favorites.set(humanId, [...own, { tenant_id: tenantId, alias, created_at: new Date(0).toISOString() }]);
  }

  async removeFavorite(humanId: string, tenantId: string, alias: string): Promise<void> {
    const own = this.favorites.get(humanId) ?? [];
    this.favorites.set(humanId, own.filter((item) => item.tenant_id !== tenantId || item.alias !== alias));
  }

  async setAppearance(input: AgentAppearanceWrite, actor: AgentAppearanceActor): Promise<AgentAppearance> {
    const key = `${input.tenant_id}:${input.alias}`;
    const current = this.appearances.get(key)?.revision ?? null;
    if (current !== input.expected_revision) throw new AgentAppearanceRevisionError(current);
    this.actors.push(actor);
    const saved: AgentAppearance = {
      tenant_id: input.tenant_id, alias: input.alias, glyph: input.glyph, hue: input.hue, style: input.style,
      revision: (current ?? 0) + 1, updated_at: new Date(0).toISOString(), updated_by: actor.display,
    };
    this.appearances.set(key, saved);
    return saved;
  }

  async resetAppearance(tenantId: string, alias: string, expectedRevision: number, actor: AgentAppearanceActor): Promise<void> {
    const key = `${tenantId}:${alias}`;
    const current = this.appearances.get(key)?.revision ?? null;
    if (current !== expectedRevision) throw new AgentAppearanceRevisionError(current);
    this.actors.push(actor);
    this.appearances.delete(key);
  }

  async recordAppearanceDenial(_actor: AgentAppearanceActor, denial: AgentAppearanceDenialRecord): Promise<void> {
    this.denials.push(denial);
  }
}

/** ACL edges seen from the operator tenant `Steven`; a missing tenant has no edge at all. */
type Reach = Readonly<Record<string, { read: boolean; control: boolean }>>;

function aclRepository(reach: Reach, disabled: ReadonlySet<string> = new Set()) {
  return fakeRepository({
    authorizeAgentTarget: vi.fn(async (
      actorTenant: string, _actorAlias: string, targetTenant: string, targetAlias: string,
      permission: AgentTargetPermission,
    ): Promise<AuthorizedAgentTarget | undefined> => {
      const enabled = !disabled.has(`${targetTenant}/${targetAlias}`);
      const edge = targetTenant === actorTenant ? { read: true, control: true } : reach[targetTenant];
      if (edge?.[permission === 'read' ? 'read' : 'control'] !== true) return undefined;
      if (permission === 'control' && !enabled) return undefined;
      return { tenant_id: targetTenant, alias: targetAlias, harness_id: null, home_directory: null, enabled };
    }),
  });
}

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function preferenceGateway(second: Partial<ConsoleUser> = {}, repository = aclRepository({})) {
  const first: ConsoleUser = {
    id: '11111111-1111-4111-8111-111111111111', email: 'alba@example.test', display_name: 'Alba',
    role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true, password_changed_at: 0,
    password_hash: await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 }),
  };
  const other: ConsoleUser = {
    ...first, id: '22222222-2222-4222-8222-222222222222', email: 'bruno@example.test', display_name: 'Bruno', ...second,
  };
  const users = new MemoryConsoleUserStore([first, other]);
  const provider = new PasswordAuthProvider({
    users, signingKey: Buffer.alloc(32, 19), fallback: DevOnlyAuthProvider.forTests(),
  });
  const preferences = new MemoryAgentPreferences();
  const app = await buildTestGateway({
    pool: fakePool({ ssl: true }), authProvider: provider, agentPreferences: preferences, repository,
  });
  apps.push(app);
  return { app, first, other, preferences };
}

describe('console favorites belong to the authenticated person', () => {
  it('adds and removes idempotently and isolates people sharing one technical alias', async () => {
    const test = await preferenceGateway();
    const alba = await loginAs(test.app, test.first);
    const bruno = await loginAs(test.app, test.other);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const added = await test.app.inject({ method: 'PUT', url: '/v3/console/favorites/Steven/argos', headers: alba.headers });
      expect(added.statusCode).toBe(204);
    }
    const mine = await test.app.inject({ method: 'GET', url: '/v3/console/agent-preferences', headers: alba.headers });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['cache-control']).toBe('no-store');
    expect(mine.json()).toEqual({
      favorites: [{ tenant_id: 'Steven', alias: 'argos', created_at: new Date(0).toISOString() }], appearances: [],
    });
    const theirs = await test.app.inject({ method: 'GET', url: '/v3/console/agent-preferences', headers: bruno.headers });
    expect(theirs.json()).toEqual({ favorites: [], appearances: [] });
    expect([...test.preferences.favorites.keys()]).toEqual([test.first.id]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const removed = await test.app.inject({ method: 'DELETE', url: '/v3/console/favorites/Steven/argos', headers: alba.headers });
      expect(removed.statusCode).toBe(204);
    }
    expect(test.preferences.favorites.get(test.first.id)).toEqual([]);
  });

  it('lets readers keep favorites without granting appearance writes', async () => {
    const test = await preferenceGateway({ role: 'reader' });
    const reader = await loginAs(test.app, test.other);
    const added = await test.app.inject({ method: 'PUT', url: '/v3/console/favorites/Steven/argos', headers: reader.headers });
    expect(added.statusCode).toBe(204);
    const look = await test.app.inject({
      method: 'PUT', url: '/v3/console/agents/Steven/argos/appearance', headers: reader.headers,
      payload: { glyph: 'A', hue: 10, style: 'orb', expected_revision: null },
    });
    expect(look.statusCode).toBe(403);
    expect(test.preferences.appearances.size).toBe(0);
  });

  it('rejects technical identities with the human-session status and reads no favorites for them', async () => {
    const test = await preferenceGateway();
    const machine = { origin: ORIGIN, 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant' };
    for (const method of ['PUT', 'DELETE'] as const) {
      const response = await test.app.inject({ method, url: '/v3/console/favorites/Steven/argos', headers: machine });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized', message: 'Hace falta una sesión de persona con contraseña.' });
    }
    const read = await test.app.inject({ method: 'GET', url: '/v3/console/agent-preferences', headers: machine });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ favorites: [], appearances: [] });
    expect(test.preferences.favorites.size).toBe(0);
  });

  it('requires the session CSRF token and the same-origin guard', async () => {
    const test = await preferenceGateway();
    const session = await loginAs(test.app, test.first);
    for (const [headers, status] of [
      [{ origin: ORIGIN }, 401],
      [{ cookie: session.cookie, origin: ORIGIN }, 403],
      [{ ...session.headers, origin: 'https://other.example.test' }, 403],
      [{ cookie: session.cookie, 'x-csrf-token': session.state.csrf_token }, 403],
    ] as const) {
      for (const [method, url, payload] of [
        ['PUT', '/v3/console/favorites/Steven/argos', undefined],
        ['DELETE', '/v3/console/favorites/Steven/argos', undefined],
        ['PUT', '/v3/console/agents/Steven/argos/appearance', { glyph: 'A', hue: 1, style: 'orb', expected_revision: null }],
        ['DELETE', '/v3/console/agents/Steven/argos/appearance?expected_revision=1', undefined],
      ] as const) {
        const response = await test.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
        expect(response.statusCode).toBe(status);
      }
    }
    expect(test.preferences.favorites.size).toBe(0);
    expect(test.preferences.appearances.size).toBe(0);
    expect(test.preferences.actors).toEqual([]);
  });

  it('validates identities, hides foreign agents and reports the cap', async () => {
    const test = await preferenceGateway();
    const session = await loginAs(test.app, test.first);
    const invalid = await test.app.inject({ method: 'PUT', url: '/v3/console/favorites/Steven/Bad%20Alias', headers: session.headers });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'invalid_input' });
    const hidden = await test.app.inject({ method: 'PUT', url: '/v3/console/favorites/Isa/argos', headers: session.headers });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'not_found', message: 'agent not found or not visible' });
    test.preferences.favorites.set(test.first.id, Array.from({ length: MAX_AGENT_FAVORITES_PER_HUMAN }, (_, index) => ({
      tenant_id: 'Steven', alias: `agent${String(index)}`, created_at: new Date(0).toISOString(),
    })));
    const full = await test.app.inject({ method: 'PUT', url: '/v3/console/favorites/Steven/argos', headers: session.headers });
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ error: 'favorite_limit_reached', limit: MAX_AGENT_FAVORITES_PER_HUMAN });
    const again = await test.app.inject({ method: 'PUT', url: '/v3/console/favorites/Steven/agent7', headers: session.headers });
    expect(again.statusCode).toBe(204);
  });
});

describe('agent appearance is shared configuration', () => {
  it('creates, updates with optimistic concurrency and resets, visible to every person', async () => {
    const test = await preferenceGateway();
    const alba = await loginAs(test.app, test.first);
    const bruno = await loginAs(test.app, test.other);
    const url = '/v3/console/agents/Steven/argos/appearance';
    const created = await test.app.inject({
      method: 'PUT', url, headers: alba.headers,
      payload: { glyph: '\u{1F989}', hue: 210, style: 'aurora', expected_revision: null },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({
      tenant_id: 'Steven', alias: 'argos', glyph: '\u{1F989}', hue: 210, style: 'aurora', revision: 1,
      updated_at: new Date(0).toISOString(), updated_by: 'Alba',
    });
    expect(test.preferences.actors[0]).toMatchObject({ tenant_id: 'Steven', alias: 'kant', display: 'Alba' });
    expect(test.preferences.actors[0]?.human_subject).toMatch(/^human:[a-f0-9]{64}$/u);
    const duplicate = await test.app.inject({
      method: 'PUT', url, headers: bruno.headers, payload: { glyph: null, hue: null, style: 'orb', expected_revision: null },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: 'revision_conflict', current_revision: 1 });
    const updated = await test.app.inject({
      method: 'PUT', url, headers: bruno.headers, payload: { glyph: null, hue: null, style: 'pixel', expected_revision: 1 },
    });
    expect(updated.json()).toMatchObject({ revision: 2, style: 'pixel', glyph: null, updated_by: 'Bruno' });
    const stale = await test.app.inject({
      method: 'PUT', url, headers: alba.headers, payload: { glyph: 'A', hue: 1, style: 'orb', expected_revision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'revision_conflict', current_revision: 2 });
    const shared = await test.app.inject({ method: 'GET', url: '/v3/console/agent-preferences', headers: alba.headers });
    expect(shared.json<{ appearances: unknown[] }>().appearances).toEqual([updated.json()]);
    for (const query of ['', '?expected_revision=0', '?expected_revision=abc', '?expected_revision=1.5']) {
      const rejected = await test.app.inject({ method: 'DELETE', url: `${url}${query}`, headers: alba.headers });
      expect(rejected.statusCode).toBe(400);
    }
    const wrong = await test.app.inject({ method: 'DELETE', url: `${url}?expected_revision=1`, headers: alba.headers });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ error: 'revision_conflict', current_revision: 2 });
    const reset = await test.app.inject({ method: 'DELETE', url: `${url}?expected_revision=2`, headers: alba.headers });
    expect(reset.statusCode).toBe(204);
    const after = await test.app.inject({ method: 'GET', url: '/v3/console/agent-preferences', headers: bruno.headers });
    expect(after.json()).toEqual({ favorites: [], appearances: [] });
  });

  it('rejects malformed bodies and hidden agents before touching the store', async () => {
    const test = await preferenceGateway();
    const session = await loginAs(test.app, test.first);
    const setAppearance = vi.spyOn(test.preferences, 'setAppearance');
    for (const payload of [
      { glyph: 'AB', hue: 1, style: 'orb', expected_revision: null },
      { glyph: '\u202eA', hue: 1, style: 'orb', expected_revision: null },
      { glyph: 'A', hue: 360, style: 'orb', expected_revision: null },
      { glyph: 'A', hue: 1, style: 'neon', expected_revision: null },
      { glyph: 'A', hue: 1, style: 'orb' },
      { glyph: 'A', hue: 1, style: 'orb', expected_revision: null, revision: 3 },
    ]) {
      const response = await test.app.inject({
        method: 'PUT', url: '/v3/console/agents/Steven/argos/appearance', headers: session.headers, payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'invalid_input' });
    }
    const hidden = await test.app.inject({
      method: 'PUT', url: '/v3/console/agents/Isa/argos/appearance', headers: session.headers,
      payload: { glyph: 'A', hue: 1, style: 'orb', expected_revision: null },
    });
    expect(hidden.statusCode).toBe(404);
    expect(setAppearance).not.toHaveBeenCalled();
  });
});

describe('appearance writes need control over the target agent', () => {
  const look = { glyph: 'A', hue: 1, style: 'orb', expected_revision: null };

  it('answers 403 when an edge grants read but not control, 404 when hidden, and audits both', async () => {
    const test = await preferenceGateway({}, aclRepository({ Isa: { read: true, control: false } }));
    const session = await loginAs(test.app, test.first);
    const readOnly = await test.app.inject({
      method: 'PUT', url: '/v3/console/agents/Isa/salva/appearance', headers: session.headers, payload: look,
    });
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json()).toMatchObject({ error: 'forbidden' });
    const reset = await test.app.inject({
      method: 'DELETE', url: '/v3/console/agents/Isa/salva/appearance?expected_revision=1', headers: session.headers,
    });
    expect(reset.statusCode).toBe(403);
    const hidden = await test.app.inject({
      method: 'PUT', url: '/v3/console/agents/Pablo/midas/appearance', headers: session.headers, payload: look,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'not_found', message: 'agent not found or not visible' });
    expect(test.preferences.appearances.size).toBe(0);
    expect(test.preferences.actors).toEqual([]);
    expect(test.preferences.denials).toEqual([
      { target_tenant: 'Isa', target_alias: 'salva', operation: 'set', reason: 'forbidden' },
      { target_tenant: 'Isa', target_alias: 'salva', operation: 'reset', reason: 'forbidden' },
      { target_tenant: 'Pablo', target_alias: 'midas', operation: 'set', reason: 'not_found' },
    ]);
    const favorite = await test.app.inject({ method: 'PUT', url: '/v3/console/favorites/Isa/salva', headers: session.headers });
    expect(favorite.statusCode).toBe(204);
    expect(test.preferences.favoriteViewers).toEqual(['Steven']);
  });

  it('writes across tenants once the edge grants control, also for a disabled agent', async () => {
    const test = await preferenceGateway({}, aclRepository(
      { Isa: { read: true, control: true } }, new Set(['Isa/dormant']),
    ));
    const session = await loginAs(test.app, test.first);
    const saved = await test.app.inject({
      method: 'PUT', url: '/v3/console/agents/Isa/salva/appearance', headers: session.headers, payload: look,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ tenant_id: 'Isa', alias: 'salva', revision: 1 });
    const dormant = await test.app.inject({
      method: 'PUT', url: '/v3/console/agents/Isa/dormant/appearance', headers: session.headers, payload: look,
    });
    expect(dormant.statusCode).toBe(200);
    expect(test.preferences.denials).toEqual([]);
  });

  it('audits revision conflicts with the expected and current revisions', async () => {
    const test = await preferenceGateway();
    const session = await loginAs(test.app, test.first);
    const url = '/v3/console/agents/Steven/argos/appearance';
    expect((await test.app.inject({ method: 'PUT', url, headers: session.headers, payload: look })).statusCode).toBe(200);
    const stale = await test.app.inject({
      method: 'PUT', url, headers: session.headers, payload: { ...look, expected_revision: 4 },
    });
    expect(stale.statusCode).toBe(409);
    const missing = await test.app.inject({
      method: 'DELETE', url: '/v3/console/agents/Steven/iris/appearance?expected_revision=2', headers: session.headers,
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ error: 'revision_conflict', current_revision: null });
    expect(test.preferences.denials).toEqual([
      {
        target_tenant: 'Steven', target_alias: 'argos', operation: 'set', reason: 'revision_conflict',
        expected_revision: 4, current_revision: 1,
      },
      {
        target_tenant: 'Steven', target_alias: 'iris', operation: 'reset', reason: 'revision_conflict',
        expected_revision: 2, current_revision: null,
      },
    ]);
  });
});
