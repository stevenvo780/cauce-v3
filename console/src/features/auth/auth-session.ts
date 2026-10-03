import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { ConsoleAuthState } from '../../api/types';

/**
 * Gate state, ALWAYS derived from what the server said:
 *  - `checking`  has not answered `/v3/auth/session` yet.
 *  - `in`        there is a session.
 *  - `out`       there is no session: the login is shown and nothing else.
 *  - `unmanaged` the gateway does not expose the BFF (today: `CAUCE_AUTH_PROVIDER=mtls`).
 *  - `error`     could not ask. NOT the same as "not authorized": it fails closed.
 */
export type GateStatus = 'checking' | 'in' | 'out' | 'unmanaged' | 'error';

export function statusOf(state: ConsoleAuthState | undefined, error: Error | undefined): GateStatus {
  // Fail-closed solo en la comprobación INICIAL: una sesión establecida no se cae por un error
  // transitorio de la revalidación de fondo (eso desmontaba la consola). El vencimiento real llega
  // como authenticated:false (200) y ese sí va al login.
  if (!state) return error ? 'error' : 'checking';
  if (state.authenticated === null) return 'unmanaged';
  return state.authenticated ? 'in' : 'out';
}

/** How often the session is revalidated against the server, so an expiration is noticed. */
const REVALIDATE_MS = 60_000;

export interface AuthGateState {
  state?: ConsoleAuthState;
  error?: Error;
  status: GateStatus;
  busy: boolean;
  check: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export function useAuthGate(): AuthGateState {
  const api = useApi();
  const [state, setState] = useState<ConsoleAuthState>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);

  const mounted = useRef(false);
  const generation = useRef(0);
  const mutating = useRef(false);

  const refresh = useCallback(async (expectedAuthenticated?: boolean) => {
    const current = ++generation.current;
    try {
      const next = await api.getAuthSession();
      if (expectedAuthenticated !== undefined && next.authenticated !== expectedAuthenticated) {
        throw new Error(expectedAuthenticated
          ? 'El servidor no confirmó el inicio de sesión.'
          : 'El servidor no confirmó el cierre de sesión.');
      }
      if (mounted.current && current === generation.current) {
        setState(next);
        setError(undefined);
      }
    } catch (cause) {
      if (mounted.current && current === generation.current) {
        setError(cause instanceof Error ? cause : new Error('No se pudo verificar la sesión'));
      }
    }
  }, [api]);

  const check = useCallback(async () => {
    if (!mutating.current) await refresh();
  }, [refresh]);

  useEffect(() => api.onAuthSession((next) => {
    if (!mounted.current || mutating.current) return;
    generation.current += 1;
    setState(next);
    setError(undefined);
  }), [api]);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    void check();
    // Periodic revalidation and on tab focus: an expired session must be noticed without
    // waiting for the operator to touch something that writes.
    const timer = window.setInterval(() => { if (active) void check(); }, REVALIDATE_MS);
    const onFocus = () => { if (active) void check(); };
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      mounted.current = false;
      generation.current += 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [check]);

  /* A 401 on any data call asks the SERVER again at once instead of waiting for the 60 s poll,
     which left the console in limbo. Overlapping 401s share one answer. */
  useEffect(() => {
    let revalidando = false;
    return api.onUnauthorized(() => {
      if (revalidando) return;
      revalidando = true;
      void check().finally(() => { revalidando = false; });
    });
  }, [api, check]);

  const login = useCallback(async (email: string, password: string) => {
    if (mutating.current) return;
    mutating.current = true;
    generation.current += 1;
    setBusy(true);
    setError(undefined);
    try {
      await api.login(email, password);
      if (!mounted.current) return;
      setState(undefined);
      await refresh(true);
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [api, refresh]);

  const logout = useCallback(async () => {
    if (mutating.current) return;
    mutating.current = true;
    generation.current += 1;
    setBusy(true);
    setError(undefined);
    try {
      await api.logout();
      if (!mounted.current) return;
      setState(undefined);
      await refresh(false);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause : new Error('No se pudo cerrar la sesión'));
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [api, refresh]);

  return { state, error, status: statusOf(state, error), busy, check, login, logout };
}
