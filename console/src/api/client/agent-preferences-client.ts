import {
  AGENT_APPEARANCE_STYLES, AgentAppearanceSchema, AgentPreferencesSchema, isAgentGlyph,
  type AgentAppearance, type AgentAppearanceStyle, type AgentPreferences,
} from '@cauce/protocol/agent-preferences';
import { ApiError } from './core';
import type { RequestFn } from './system-client';

export type { AgentAppearance, AgentAppearanceStyle, AgentFavorite, AgentPreferences } from '@cauce/protocol/agent-preferences';
export { AGENT_APPEARANCE_STYLES, isAgentGlyph };

/** What the operator edits: the server owns `revision`, `updated_at` and `updated_by`. */
export interface AppearanceDraft {
  glyph: string | null;
  hue: number | null;
  style: AgentAppearanceStyle;
}

export interface AgentPreferencesClient {
  getAgentPreferences(): Promise<AgentPreferences>;
  addAgentFavorite(tenantId: string, alias: string): Promise<void>;
  removeAgentFavorite(tenantId: string, alias: string): Promise<void>;
  saveAgentAppearance(tenantId: string, alias: string, draft: AppearanceDraft, expectedRevision: number | null): Promise<AgentAppearance>;
  resetAgentAppearance(tenantId: string, alias: string, expectedRevision: number): Promise<void>;
}

export class AgentPreferencesResponseError extends Error {
  constructor() { super('La respuesta del servidor no confirma las preferencias de los agentes. Recargá la consola.'); }
}

/** Someone else saved this agent's appearance after it was read: the draft must be rebased, never forced. */
export function isRevisionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'revision_conflict';
}

/** Why a draft cannot be sent, in the operator's words; `undefined` when the server would accept it. */
export function appearanceDraftProblem(draft: AppearanceDraft): string | undefined {
  if (draft.glyph !== null && !isAgentGlyph(draft.glyph)) {
    return 'El icono tiene que ser un solo emoji, letra o número, sin espacios ni caracteres invisibles.';
  }
  if (draft.hue !== null && (!Number.isInteger(draft.hue) || draft.hue < 0 || draft.hue > 359)) {
    return 'El tono tiene que ser un número entero entre 0 y 359.';
  }
  if (!(AGENT_APPEARANCE_STYLES as readonly string[]).includes(draft.style)) return 'Ese estilo no existe.';
  return undefined;
}

function agentPath(prefix: string, tenantId: string, alias: string, suffix = ''): string {
  if (!tenantId || !alias) throw new Error('Falta el tenant o el alias del agente.');
  return `${prefix}/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}${suffix}`;
}

export function agentPreferencesResponse(value: unknown): AgentPreferences {
  const parsed = AgentPreferencesSchema.safeParse(value);
  if (!parsed.success) throw new AgentPreferencesResponseError();
  return parsed.data;
}

function appearanceResponse(value: unknown): AgentAppearance {
  const parsed = AgentAppearanceSchema.safeParse(value);
  if (!parsed.success) throw new AgentPreferencesResponseError();
  return parsed.data;
}

export function agentPreferencesClient(request: RequestFn): AgentPreferencesClient {
  return {
    getAgentPreferences: () => request<unknown>('/v3/console/agent-preferences', { cache: 'no-store' }).then(agentPreferencesResponse),
    addAgentFavorite: async (tenantId, alias) => {
      await request<undefined>(agentPath('/v3/console/favorites', tenantId, alias), { method: 'PUT' });
    },
    removeAgentFavorite: async (tenantId, alias) => {
      await request<undefined>(agentPath('/v3/console/favorites', tenantId, alias), { method: 'DELETE' });
    },
    saveAgentAppearance: async (tenantId, alias, draft, expectedRevision) => {
      const problem = appearanceDraftProblem(draft);
      if (problem) throw new Error(problem);
      const body = { glyph: draft.glyph, hue: draft.hue, style: draft.style, expected_revision: expectedRevision };
      const saved = appearanceResponse(await request<unknown>(agentPath('/v3/console/agents', tenantId, alias, '/appearance'), {
        method: 'PUT', body: JSON.stringify(body),
      }));
      if (saved.tenant_id !== tenantId || saved.alias !== alias) throw new AgentPreferencesResponseError();
      return saved;
    },
    resetAgentAppearance: async (tenantId, alias, expectedRevision) => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Falta la revisión que se quiere restablecer.');
      const suffix = `/appearance?expected_revision=${String(expectedRevision)}`;
      await request<undefined>(agentPath('/v3/console/agents', tenantId, alias, suffix), { method: 'DELETE' });
    },
  };
}
