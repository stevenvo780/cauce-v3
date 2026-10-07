import { delay, http, HttpResponse } from 'msw';
import type { AgentAppearance, AgentFavorite } from '../api/client/agent-preferences-client';

interface PreferenceSeed {
  favorites: [string, string][];
  appearances: Omit<AgentAppearance, 'revision' | 'updated_at' | 'updated_by'>[];
}

const EMPTY: PreferenceSeed = { favorites: [], appearances: [] };

/** The browser demo starts with a lived-in fleet; the shared test handlers start empty. */
export const DEMO_PREFERENCES: PreferenceSeed = {
  favorites: [['Steven', 'argos'], ['Miguel', 'kratos']],
  appearances: [
    { tenant_id: 'Miguel', alias: 'kratos', glyph: '🦉', hue: 200, style: 'aurora' },
    { tenant_id: 'Steven', alias: 'zeus', glyph: '⚡', hue: 55, style: 'pulse' },
    { tenant_id: 'Pablo', alias: 'dedalo', glyph: null, hue: 140, style: 'pixel' },
  ],
};

const key = (tenant: string, alias: string) => `${tenant}/${alias}`;

interface Snapshot { favorites: AgentFavorite[]; appearances: AgentAppearance[] }

/**
 * An in-memory copy of the server contract: idempotent favorites and revisioned appearances (409 on a stale revision).
 * With `persistAt`, the browser demo mirrors its state to the dev server so a reload keeps it.
 */
export function agentPreferencesHandlers(seed: PreferenceSeed = EMPTY, persistAt?: string) {
  const now = () => new Date().toISOString();
  const favorites = new Map<string, AgentFavorite>(seed.favorites.map(([tenant_id, alias]) => [key(tenant_id, alias), { tenant_id, alias, created_at: now() }]));
  const appearances = new Map<string, AgentAppearance>(seed.appearances.map((look) => [
    key(look.tenant_id, look.alias), { ...look, revision: 1, updated_at: now(), updated_by: 'Steven:kant' },
  ]));
  let hydrated: Promise<void> | undefined;
  const hydrate = () => {
    hydrated ??= persistAt === undefined ? Promise.resolve() : fetch(persistAt, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const stored = await response.json() as Snapshot;
        favorites.clear();
        appearances.clear();
        for (const favorite of stored.favorites) favorites.set(key(favorite.tenant_id, favorite.alias), favorite);
        for (const look of stored.appearances) appearances.set(key(look.tenant_id, look.alias), look);
      })
      .catch(() => undefined);
    return hydrated;
  };
  const persist = () => {
    if (persistAt === undefined) return;
    const snapshot: Snapshot = { favorites: [...favorites.values()], appearances: [...appearances.values()] };
    void fetch(persistAt, { method: 'PUT', body: JSON.stringify(snapshot) }).catch(() => undefined);
  };
  const conflict = (current: number | null) => HttpResponse.json(
    { error: 'revision_conflict', message: 'the appearance changed since it was read', current_revision: current }, { status: 409 },
  );

  return [
    http.get('*/v3/console/agent-preferences', async () => {
      await Promise.all([delay(80), hydrate()]);
      return HttpResponse.json({ favorites: [...favorites.values()], appearances: [...appearances.values()] });
    }),
    http.put('*/v3/console/favorites/:tenant/:alias', async ({ params }) => {
      await hydrate();
      const id = key(String(params.tenant), String(params.alias));
      if (!favorites.has(id)) favorites.set(id, { tenant_id: String(params.tenant), alias: String(params.alias), created_at: now() });
      persist();
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete('*/v3/console/favorites/:tenant/:alias', async ({ params }) => {
      await hydrate();
      favorites.delete(key(String(params.tenant), String(params.alias)));
      persist();
      return new HttpResponse(null, { status: 204 });
    }),
    http.put('*/v3/console/agents/:tenant/:alias/appearance', async ({ params, request }) => {
      await hydrate();
      const body = await request.json() as { glyph: string | null; hue: number | null; style: AgentAppearance['style']; expected_revision: number | null };
      const id = key(String(params.tenant), String(params.alias));
      const current = appearances.get(id);
      if ((current?.revision ?? null) !== body.expected_revision) return conflict(current?.revision ?? null);
      const saved: AgentAppearance = {
        tenant_id: String(params.tenant), alias: String(params.alias), glyph: body.glyph, hue: body.hue, style: body.style,
        revision: (current?.revision ?? 0) + 1, updated_at: now(), updated_by: 'Steven:kant',
      };
      appearances.set(id, saved);
      persist();
      return HttpResponse.json(saved);
    }),
    http.delete('*/v3/console/agents/:tenant/:alias/appearance', async ({ params, request }) => {
      await hydrate();
      const id = key(String(params.tenant), String(params.alias));
      const expected = Number(new URL(request.url).searchParams.get('expected_revision'));
      const current = appearances.get(id);
      if (current?.revision !== expected) return conflict(current?.revision ?? null);
      appearances.delete(id);
      persist();
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}
