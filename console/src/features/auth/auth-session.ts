import { useCallback, useEffect, useState } from 'react';
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
export const REVALIDATE_MS = 60_000;

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

  const check = useCallback(async () => {
    try {
      const next = await api.getAuthSession();
      setState(next);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('No se pudo verificar la sesión'));
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void check();
    // Periodic revalidation and on tab focus: an expired session must be noticed without
    // waiting for the operator to touch something that writes.
    const timer = window.setInterval(() => { if (active) void check(); }, REVALIDATE_MS);
    const onFocus = () => { if (active) void check(); };
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
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

  /**
   * Password login. Like logout, it does not assume its own optimism: after the POST it asks the
   * server again. A credential failure is propagated to the caller —to be shown inside the form—
   * instead of becoming `error`, which paints "could not verify the session".
   */
  const login = useCallback(async (email: string, password: string) => {
    setBusy(true);
    try {
      await api.login(email, password);
      await check();
    } finally {
      setBusy(false);
    }
  }, [api, check]);

  const logout = useCallback(async () => {
    setBusy(true);
    try {
      await api.logout();
      // The POST result is not assumed: the server is asked again who I am.
      await check();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('No se pudo cerrar la sesión'));
    } finally {
      setBusy(false);
    }
  }, [api, check]);

  return { state, error, status: statusOf(state, error), busy, check, login, logout };
}
