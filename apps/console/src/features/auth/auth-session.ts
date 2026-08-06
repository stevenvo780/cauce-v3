import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../api/context';
import type { ConsoleAuthState } from '../../api/types';

/**
 * Estado de la puerta, derivado SIEMPRE de lo que dijo el servidor:
 *  - `checking`  todavía no contestó `/v3/auth/session`.
 *  - `in`        hay sesión.
 *  - `out`       no hay sesión: se muestra el login y nada más.
 *  - `unmanaged` el gateway no expone el BFF (hoy: `CAUCE_AUTH_PROVIDER=mtls`).
 *  - `error`     no se pudo preguntar. NO es lo mismo que "no autorizado": se falla cerrado.
 */
export type GateStatus = 'checking' | 'in' | 'out' | 'unmanaged' | 'error';

export function statusOf(state: ConsoleAuthState | undefined, error: Error | undefined): GateStatus {
  if (error) return 'error';
  if (!state) return 'checking';
  if (state.authenticated === null) return 'unmanaged';
  return state.authenticated ? 'in' : 'out';
}

/** Cada cuánto se revalida la sesión contra el servidor, para que un vencimiento se note. */
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
    // Revalidación periódica y al volver a la pestaña: una sesión vencida tiene que notarse sin
    // esperar a que el operador toque algo que escriba.
    const timer = window.setInterval(() => { if (active) void check(); }, REVALIDATE_MS);
    const onFocus = () => { if (active) void check(); };
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [check]);

  /**
   * Login por contraseña. Igual que el logout: no se cree su propio optimismo — tras el POST
   * vuelve a preguntarle al servidor quién es. Un fallo de credenciales NO se guarda en `error`
   * (eso pintaría la pantalla de "no se pudo verificar la sesión", que es otra cosa): se
   * propaga a quien llamó para que lo muestre dentro del formulario.
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
      // No se asume el resultado del POST: se vuelve a preguntar al servidor quién soy.
      await check();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('No se pudo cerrar la sesión'));
    } finally {
      setBusy(false);
    }
  }, [api, check]);

  return { state, error, status: statusOf(state, error), busy, check, login, logout };
}
