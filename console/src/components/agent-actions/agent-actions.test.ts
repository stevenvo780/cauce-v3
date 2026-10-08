import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import {
  agentPreferencesClient, agentPreferencesResponse, appearanceDraftProblem, isAgentGlyph, isRevisionConflict,
} from '../../api/client/agent-preferences-client';
import type { RequestFn } from '../../api/client/system-client';
import {
  APPEARANCE_DENIED_REASON, APPEARANCE_GLYPHS, agentActions, agentPaths, isContextMenuKey, type AgentActionContext,
} from './agent-actions';

const argos = { tenantId: 'Steven', alias: 'argos' };
const ready: AgentActionContext = { favorite: false, appearance: 'allowed' };

describe('the agent actions model', () => {
  it('lists every action once, in menu order, with real links for the navigation ones', () => {
    const actions = agentActions(argos, ready);
    expect(actions.map((action) => action.id)).toEqual(['chat', 'tui', 'terminal', 'office', 'context', 'appearance', 'favorite', 'copy']);
    expect(Object.fromEntries(actions.filter((action) => action.href).map((action) => [action.id, action.href]))).toEqual({
      chat: '/messages/Steven/argos',
      tui: '/terminal/Steven/argos?modo=tui',
      terminal: '/terminal/Steven/argos?modo=terminal',
      office: `/live?agente=${encodeURIComponent('Steven/argos')}`,
      context: '/messages/Steven/argos?view=context',
    });
    expect(actions.every((action) => !action.disabled)).toBe(true);
  });

  it('encodes identities that need it and keeps them case-sensitive', () => {
    expect(agentPaths({ tenantId: 'Ana María', alias: 'K/9' }).chat).toBe('/messages/Ana%20Mar%C3%ADa/K%2F9');
  });

  it('flips the favorite label and disables it, with the reason, while favorites are unknown', () => {
    expect(agentActions(argos, { ...ready, favorite: true }).find((action) => action.id === 'favorite')?.label).toBe('Quitar de favoritos');
    const unknown = agentActions(argos, { ...ready, favorite: undefined, favoriteReason: 'sin lectura' }).find((action) => action.id === 'favorite');
    expect(unknown).toMatchObject({ disabled: true, reason: 'sin lectura', label: 'Agregar a favoritos' });
  });

  it('gates the icon on config.write and says why', () => {
    expect(agentActions(argos, { ...ready, appearance: 'denied' }).find((action) => action.id === 'appearance'))
      .toMatchObject({ disabled: true, reason: APPEARANCE_DENIED_REASON });
    expect(agentActions(argos, { ...ready, appearance: 'unknown' }).find((action) => action.id === 'appearance')?.disabled).toBe(false);
    expect(agentActions(argos, { ...ready, appearanceUnavailable: 'fuera' }).find((action) => action.id === 'appearance'))
      .toMatchObject({ disabled: true, reason: 'fuera' });
  });

  it('omits what the surface already is', () => {
    expect(agentActions(argos, { ...ready, omit: ['chat', 'tui'] }).map((action) => action.id)).not.toContain('chat');
  });

  it('treats Shift+F10 and the ContextMenu key as a right click', () => {
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
  });
});

describe('appearance validation', () => {
  it('accepts every curated glyph with the server validator', () => {
    for (const glyph of APPEARANCE_GLYPHS) expect(isAgentGlyph(glyph)).toBe(true);
  });

  it.each([
    [{ glyph: 'ab', hue: null, style: 'orb' }, /un solo emoji/],
    [{ glyph: ' ', hue: null, style: 'orb' }, /un solo emoji/],
    [{ glyph: '​', hue: null, style: 'orb' }, /un solo emoji/],
    [{ glyph: null, hue: 360, style: 'orb' }, /entre 0 y 359/],
    [{ glyph: null, hue: 12.5, style: 'orb' }, /entero/],
    [{ glyph: null, hue: null, style: 'neon' }, /no existe/],
  ] as const)('refuses %j before asking the server', (draft, problem) => {
    expect(appearanceDraftProblem(draft as never)).toMatch(problem);
  });

  it.each([
    { glyph: '🦉', hue: 200, style: 'aurora' }, { glyph: 'K', hue: 0, style: 'pixel' }, { glyph: '👩🏽‍🚀', hue: 359, style: 'pulse' },
    { glyph: null, hue: null, style: 'orb' },
  ] as const)('accepts %j', (draft) => {
    expect(appearanceDraftProblem(draft)).toBeUndefined();
  });
});

describe('the preferences client', () => {
  const saved = { tenant_id: 'Steven', alias: 'argos', glyph: '🦉', hue: 200, style: 'aurora', revision: 3, updated_at: '2026-10-06T00:00:00Z', updated_by: 'Steven:kant' };

  it('reads with no-store and writes exactly the contract fields', async () => {
    const request = vi.fn().mockResolvedValueOnce({ favorites: [], appearances: [] }).mockResolvedValue(saved) as unknown as RequestFn;
    const api = agentPreferencesClient(request);
    await api.getAgentPreferences();
    await api.addAgentFavorite('Steven', 'argos');
    await api.removeAgentFavorite('Steven', 'argos');
    await api.saveAgentAppearance('Steven', 'argos', { glyph: '🦉', hue: 200, style: 'aurora' }, 2);
    await api.resetAgentAppearance('Steven', 'argos', 3);
    expect(vi.mocked(request).mock.calls).toEqual([
      ['/v3/console/agent-preferences', { cache: 'no-store' }],
      ['/v3/console/favorites/Steven/argos', { method: 'PUT' }],
      ['/v3/console/favorites/Steven/argos', { method: 'DELETE' }],
      ['/v3/console/agents/Steven/argos/appearance', { method: 'PUT', body: JSON.stringify({ glyph: '🦉', hue: 200, style: 'aurora', expected_revision: 2 }) }],
      ['/v3/console/agents/Steven/argos/appearance?expected_revision=3', { method: 'DELETE' }],
    ]);
  });

  it('never sends an invalid draft or a reset without a revision', async () => {
    const request = vi.fn() as unknown as RequestFn;
    const api = agentPreferencesClient(request);
    await expect(api.saveAgentAppearance('Steven', 'argos', { glyph: 'dos', hue: null, style: 'orb' }, null)).rejects.toThrow(/un solo emoji/);
    await expect(api.resetAgentAppearance('Steven', 'argos', 0)).rejects.toThrow(/revisión/);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses an acknowledgement that does not confirm the agent it was written for', async () => {
    const request = vi.fn().mockResolvedValue({ ...saved, alias: 'kratos' }) as unknown as RequestFn;
    await expect(agentPreferencesClient(request).saveAgentAppearance('Steven', 'argos', { glyph: null, hue: null, style: 'orb' }, null))
      .rejects.toThrow(/no confirma/);
  });

  it.each([null, {}, { favorites: [], appearances: [{ ...saved, style: 'neon' }] }, { favorites: [{ alias: 'argos' }], appearances: [] }])(
    'rejects a malformed read %j', (value) => { expect(() => agentPreferencesResponse(value)).toThrow(/no confirma/); },
  );

  it('recognises only the revision conflict as a conflict', () => {
    expect(isRevisionConflict(new ApiError('x', 409, 'revision_conflict'))).toBe(true);
    expect(isRevisionConflict(new ApiError('x', 409, 'favorite_limit_reached'))).toBe(false);
    expect(isRevisionConflict(new Error('409'))).toBe(false);
  });
});
