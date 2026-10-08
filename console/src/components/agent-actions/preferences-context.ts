import { createContext, useContext, useEffect, useState } from 'react';
import type { AgentAppearance, AppearanceDraft } from '../../api/client/agent-preferences-client';
import type { AgentRef } from './agent-actions';

export type ToastTone = 'ok' | 'danger';

export interface AgentPreferencesValue {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  /** Favorite keys (`tenant/alias`) of the human behind the session. */
  favorites: ReadonlySet<string>;
  /** Shared appearance per `tenant/alias`; an absent key means the default orb. */
  appearances: ReadonlyMap<string, AgentAppearance>;
  /** Favorite keys with a write in flight: a second toggle waits for the first. */
  pending: ReadonlySet<string>;
  toggleFavorite: (agent: AgentRef) => void;
  saveAppearance: (agent: AgentRef, draft: AppearanceDraft) => Promise<AgentAppearance>;
  resetAppearance: (agent: AgentRef) => Promise<void>;
  reload: () => Promise<void>;
  customize: (agent: AgentRef) => void;
  notify: (text: string, tone?: ToastTone) => void;
}

export const AgentPreferencesContext = createContext<AgentPreferencesValue | null>(null);

/** `null` outside the shell (isolated views and tests): every surface then falls back to defaults. */
export function useAgentPreferences(): AgentPreferencesValue | null {
  return useContext(AgentPreferencesContext);
}

export function useAgentAppearance(key: string): AgentAppearance | undefined {
  return useContext(AgentPreferencesContext)?.appearances.get(key);
}

/** True once favorites and appearances are known, or after `patienceMs`: lists wait instead of jumping, but a slow read never blanks them. */
export function usePreferencesSettled(patienceMs = 1_500): boolean {
  const status = useContext(AgentPreferencesContext)?.status;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (status !== 'loading') return undefined;
    const timer = window.setTimeout(() => { setWaited(true); }, patienceMs);
    return () => { window.clearTimeout(timer); };
  }, [status, patienceMs]);
  return status !== 'loading' || waited;
}
