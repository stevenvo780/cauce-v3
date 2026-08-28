/**
 * Runtime detection for the PTY relay (see commit `0a1d0e3`: the relay is opt-in per stack,
 * so its absence is an expected topology, not a bug). This module is the single source of
 * truth both the Terminal page and the app shell's nav entry should read, so they never
 * disagree about whether the interactive channel is actually reachable.
 *
 * Doctrine, same as the rest of this feature: nothing ambiguous reports `available`. But
 * topology absence is narrower: only explicit `available:false` and HTTP 404/501 mean
 * `no-desplegado`; upstream failures and transport errors mean `sin-comprobar` because they do
 * not reveal whether the relay exists. A check in flight remains `checking`.
 */
import { useEffect, useState } from 'react';
import { ApiError, type CauceApi } from '../../api/client';
import { useApi } from '../../api/context';
import type { TerminalCapability } from '../../api/types';

export type TerminalRelayStatus = 'checking' | 'available' | 'unavailable';

/**
 * Causa identificada de no disponibilidad del relay de terminales.
 */
export type TerminalRelayCause = 'no-desplegado' | 'sin-permiso' | 'sin-comprobar';

export interface TerminalRelayState {
  status: TerminalRelayStatus;
  /** Operator-facing, one-line explanation. Always set once `status` leaves `checking`. */
  reason: string;
  /** Siempre presente cuando `status` es `unavailable`; nunca en los otros dos. */
  cause?: TerminalRelayCause;
}

export const TERMINAL_RELAY_NOT_DEPLOYED_REASON = 'El relay de terminales no está desplegado en este stack.';

/**
 * Mismo reparto de palabras que `CONFIG_SIN_CONTROL_REASON` en `router.ts`, y a propósito:
 * es el mismo permiso, negado por el mismo gate. Dos redacciones distintas para la misma negativa
 * le harían creer al operador que son dos problemas.
 */
export const TERMINAL_RELAY_SIN_PERMISO_REASON =
  'Tu cuenta no tiene permiso de control sobre esta flota: la terminal de agentes es del dueño del bus. '
  + 'El relay puede estar perfectamente desplegado; lo que falta es el permiso.';

/** El gateway contestó, pero no consiguió alcanzar su upstream PTY. */
const UPSTREAM_INALCANZABLE = [502, 503, 504];

export const TERMINAL_RELAY_SIN_COMPROBAR_TITULO = 'No se pudo comprobar el canal PTY';

export function terminalRelaySinComprobarReason(status?: number, detalle?: string): string {
  if (status === undefined) {
    return 'No se pudo consultar o alcanzar el relay de terminales'
      + `${detalle ? `: ${detalle}` : ''}. Reintentá; este fallo de transporte no permite saber `
      + 'si el canal PTY está disponible.';
  }
  if (UPSTREAM_INALCANZABLE.includes(status)) {
    return `No se pudo alcanzar el relay de terminales a través del gateway (HTTP ${status})`
      + `${detalle ? `: ${detalle}` : ''}. Reintentá; el upstream no contestó y eso no permite `
      + 'afirmar el estado del despliegue.';
  }
  return `El servidor respondió HTTP ${status} al preguntar por el relay de terminales`
    + `${detalle ? `: ${detalle}` : ''}. Eso no dice que el relay falte —la ruta contestó—, `
    + 'sólo que esa consulta no se pudo completar. Reintentá; si sigue igual, es de la consola o '
    + 'del gateway, no de tu permiso.';
}

export const CHECKING_RELAY_STATE: TerminalRelayState = {
  status: 'checking',
  reason: 'Verificando el relay de terminales…',
};

/**
 * Pure classifier: turns one `getTerminalCapability()` outcome (success or thrown error) into
 * the state the UI renders. Kept separate from the hook below so both the page (which already
 * polls this endpoint via `useResource`) and any standalone poller can share one answer without
 * duplicating the "what counts as unavailable" logic.
 */
export function deriveTerminalRelayState(
  capability: TerminalCapability | undefined,
  error: unknown,
): TerminalRelayState {
  if (error) {
    const status = error instanceof ApiError ? error.status : undefined;
    const detail = error instanceof Error && error.message ? error.message : undefined;
    // El 403 es del RBAC y NO dice nada sobre si el relay está desplegado: el gate corre antes.
    if (status === 403) {
      return { status: 'unavailable', cause: 'sin-permiso', reason: TERMINAL_RELAY_SIN_PERMISO_REASON };
    }
    // Sólo 404/501 acreditan ausencia. Un 502/503/504 o un error sin status apenas dicen que la
    // medición no llegó al relay; rotularlos como despliegue ausente sería inventar topología.
    if (status !== 404 && status !== 501) {
      return {
        status: 'unavailable',
        cause: 'sin-comprobar',
        reason: terminalRelaySinComprobarReason(status, detail),
      };
    }
    return {
      status: 'unavailable',
      cause: 'no-desplegado',
      reason: `${TERMINAL_RELAY_NOT_DEPLOYED_REASON} (HTTP ${status} al consultarlo.)`,
    };
  }
  if (!capability) return CHECKING_RELAY_STATE;
  if (capability.available === false) {
    return {
      status: 'unavailable',
      cause: 'no-desplegado',
      reason: capability.reason?.trim() || TERMINAL_RELAY_NOT_DEPLOYED_REASON,
    };
  }
  if (capability.available !== true) {
    return {
      status: 'unavailable',
      cause: 'sin-comprobar',
      reason: terminalRelaySinComprobarReason(
        undefined,
        'la respuesta no declaró si el relay estaba disponible',
      ),
    };
  }
  return { status: 'available', reason: capability.reason?.trim() || 'Relay de terminales disponible.' };
}

/**
 * Standalone poll of `getTerminalCapability()`. Meant for callers that need to know relay
 * availability without mounting the Terminal page itself — e.g. the sidebar entry, which has
 * to reflect this *before* the operator ever navigates in. `TerminalPage` does not use this: it
 * already polls the same endpoint via `useResource` and feeds that result through
 * `deriveTerminalRelayState` instead, so the two never issue duplicate requests.
 */
export function useTerminalRelayStatus(pollMs = 60_000): TerminalRelayState {
  const api = useApi();
  return usePolledRelayState(api, pollMs);
}

function usePolledRelayState(api: CauceApi, pollMs: number): TerminalRelayState {
  const [state, setState] = useState<TerminalRelayState>(CHECKING_RELAY_STATE);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const capability = await api.getTerminalCapability();
        if (!cancelled) setState(deriveTerminalRelayState(capability, undefined));
      } catch (error) {
        if (!cancelled) setState(deriveTerminalRelayState(undefined, error));
      }
    }

    void probe();
    const interval = window.setInterval(() => void probe(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [api, pollMs]);

  return state;
}
