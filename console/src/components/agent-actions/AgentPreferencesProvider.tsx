import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApi } from '../../api/context';
import { isRevisionConflict, type AgentAppearance, type AgentFavorite } from '../../api/client/agent-preferences-client';
import { cn } from '../../cn';
import { agentKey, type AgentRef } from './agent-actions';
import { AppearanceDialog } from './AppearanceDialog';
import { AgentPreferencesContext, type AgentPreferencesValue, type ToastTone } from './preferences-context';

interface Toast { id: number; text: string; tone: ToastTone }

const TOAST_MS = 4_500;

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'el servidor no contestó';
}

/**
 * One read of the favorites and appearances for the whole shell. Favorites move at once and roll
 * back if the server refuses; appearances are only replaced by what the server confirms.
 */
export function AgentPreferencesProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [status, setStatus] = useState<AgentPreferencesValue['status']>('loading');
  const [error, setError] = useState<string>();
  const [favorites, setFavorites] = useState<ReadonlyMap<string, AgentFavorite>>(new Map());
  const [appearances, setAppearances] = useState<ReadonlyMap<string, AgentAppearance>>(new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [customizing, setCustomizing] = useState<AgentRef | null>(null);
  const pendingRef = useRef(new Set<string>());
  const appearancesRef = useRef(appearances);
  appearancesRef.current = appearances;
  const toastId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const notify = useCallback((text: string, tone: ToastTone = 'ok') => {
    const id = ++toastId.current;
    setToasts((current) => [...current.slice(-2), { id, text, tone }]);
    window.setTimeout(() => { setToasts((current) => current.filter((toast) => toast.id !== id)); }, TOAST_MS);
  }, []);

  const reload = useCallback(async () => {
    try {
      const data = await api.getAgentPreferences();
      if (!mounted.current) return;
      setFavorites(new Map(data.favorites.map((favorite) => [agentKey({ tenantId: favorite.tenant_id, alias: favorite.alias }), favorite])));
      setAppearances(new Map(data.appearances.map((look) => [agentKey({ tenantId: look.tenant_id, alias: look.alias }), look])));
      setStatus('ready');
      setError(undefined);
    } catch (cause) {
      if (!mounted.current) return;
      setStatus((current) => (current === 'ready' ? current : 'error'));
      setError(message(cause));
    }
  }, [api]);

  useEffect(() => { void reload(); }, [reload]);

  const setFavorite = useCallback((agent: AgentRef, on: boolean) => {
    const key = agentKey(agent);
    setFavorites((current) => {
      if (current.has(key) === on) return current;
      const next = new Map(current);
      if (on) next.set(key, { tenant_id: agent.tenantId, alias: agent.alias, created_at: new Date().toISOString() });
      else next.delete(key);
      return next;
    });
  }, []);

  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;

  const toggleFavorite = useCallback((agent: AgentRef) => {
    const key = agentKey(agent);
    if (pendingRef.current.has(key)) return;
    const was = favoritesRef.current.has(key);
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    setFavorite(agent, !was);
    const write = was ? api.removeAgentFavorite(agent.tenantId, agent.alias) : api.addAgentFavorite(agent.tenantId, agent.alias);
    write.catch((cause: unknown) => {
      if (!mounted.current) return;
      setFavorite(agent, was);
      notify(`No se pudo ${was ? 'quitar' : 'agregar'} a ${agent.alias} ${was ? 'de' : 'a'} favoritos: ${message(cause)}`, 'danger');
    }).finally(() => {
      pendingRef.current.delete(key);
      if (mounted.current) setPending(new Set(pendingRef.current));
    });
  }, [api, notify, setFavorite]);

  const saveAppearance = useCallback<AgentPreferencesValue['saveAppearance']>(async (agent, draft) => {
    const key = agentKey(agent);
    const revision = appearancesRef.current.get(key)?.revision ?? null;
    try {
      const saved = await api.saveAgentAppearance(agent.tenantId, agent.alias, draft, revision);
      if (mounted.current) setAppearances((current) => new Map(current).set(key, saved));
      return saved;
    } catch (cause) {
      if (isRevisionConflict(cause)) await reload();
      throw cause;
    }
  }, [api, reload]);

  const resetAppearance = useCallback<AgentPreferencesValue['resetAppearance']>(async (agent) => {
    const key = agentKey(agent);
    const revision = appearancesRef.current.get(key)?.revision;
    if (revision === undefined) return;
    try {
      await api.resetAgentAppearance(agent.tenantId, agent.alias, revision);
      if (!mounted.current) return;
      setAppearances((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    } catch (cause) {
      if (isRevisionConflict(cause)) await reload();
      throw cause;
    }
  }, [api, reload]);

  const value = useMemo<AgentPreferencesValue>(() => ({
    status, error, favorites: new Set(favorites.keys()), appearances, pending,
    toggleFavorite, saveAppearance, resetAppearance, reload, notify, customize: setCustomizing,
  }), [status, error, favorites, appearances, pending, toggleFavorite, saveAppearance, resetAppearance, reload, notify]);

  return (
    <AgentPreferencesContext.Provider value={value}>
      {children}
      <AppearanceDialog agent={customizing} onClose={() => { setCustomizing(null); }} />
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(68px+env(safe-area-inset-bottom))] z-[70] flex flex-col items-center gap-2 px-4 min-[761px]:bottom-6"
        aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={cn('toast-in pointer-events-auto flex max-w-md items-start gap-2 rounded-lg border px-3 py-2 text-[13px] shadow-pop',
            toast.tone === 'danger' ? 'border-danger/30 bg-danger-soft text-danger-ink' : 'border-line bg-surface text-fg')}>
            {toast.tone === 'danger'
              ? <CircleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
              : <CircleCheck size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-ok" />}
            <span className="min-w-0 flex-1">{toast.text}</span>
            <button type="button" aria-label="Descartar aviso" onClick={() => { setToasts((current) => current.filter((item) => item.id !== toast.id)); }}
              className="-mr-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded border-0 bg-transparent text-current opacity-70 hover:opacity-100">
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </AgentPreferencesContext.Provider>
  );
}
