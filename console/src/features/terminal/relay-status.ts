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

type TerminalRelayStatus = 'checking' | 'available' | 'unavailable';

/**
 * Identified cause of the terminals relay being unavailable.
 */
type TerminalRelayCause = 'no-desplegado' | 'sin-permiso' | 'sin-comprobar';

export interface TerminalRelayState {
  status: TerminalRelayStatus;
  /** Operator-facing, one-line explanation. Always set once `status` leaves `checking`. */
  reason: string;
  /** Always present when `status` is `unavailable`; never in the other two. */
  cause?: TerminalRelayCause;
}

export const TERMINAL_RELAY_NOT_DEPLOYED_REASON = 'El relay de terminales no está desplegado en este stack.';

/**
 * Same wording split as `CONFIG_SIN_CONTROL_REASON` in `router.ts`, on purpose:
 * it is the same permission, denied by the same gate. Two different rewordings of the same denial
 * would make the operator think they are two problems.
 */
export const TERMINAL_RELAY_SIN_PERMISO_REASON =
  'Tu cuenta no tiene permiso de control sobre esta flota: la terminal de agentes es del dueño del bus. '
  + 'El relay puede estar perfectamente desplegado; lo que falta es el permiso.';

/** The gateway replied, but could not reach its PTY upstream. */
const UPSTREAM_INALCANZABLE = [502, 503, 504];

export const TERMINAL_RELAY_SIN_COMPROBAR_TITULO = 'No se pudo comprobar el canal PTY';

function terminalRelaySinComprobarReason(status?: number, detalle?: string): string {
  if (status === undefined) {
    return 'No se pudo consultar o alcanzar el relay de terminales'
      + `${detalle ? `: ${detalle}` : ''}. Reintentá; este fallo de transporte no permite saber `
      + 'si el canal PTY está disponible.';
  }
  if (UPSTREAM_INALCANZABLE.includes(status)) {
    return `No se pudo alcanzar el relay de terminales a través del gateway (HTTP ${String(status)})`
      + `${detalle ? `: ${detalle}` : ''}. Reintentá; el upstream no contestó y eso no permite `
      + 'afirmar el estado del despliegue.';
  }
  return `El servidor respondió HTTP ${String(status)} al preguntar por el relay de terminales`
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
    // A 403 is RBAC and says NOTHING about whether the relay is deployed: the gate runs first.
    if (status === 403) {
      return { status: 'unavailable', cause: 'sin-permiso', reason: TERMINAL_RELAY_SIN_PERMISO_REASON };
    }
    // Only 404/501 certify absence. A 502/503/504 or an error without status only say the
    // probe did not reach the relay; labeling them as deployment absent would be inventing topology.
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
      reason: `${TERMINAL_RELAY_NOT_DEPLOYED_REASON} (HTTP ${String(status)} al consultarlo.)`,
    };
  }
  if (!capability) return CHECKING_RELAY_STATE;
  const rawAvailable = (capability as { available?: unknown }).available;
  if (typeof rawAvailable !== 'boolean') {
    return {
      status: 'unavailable',
      cause: 'sin-comprobar',
      reason: terminalRelaySinComprobarReason(
        undefined,
        'la respuesta no declaró si el relay estaba disponible',
      ),
    };
  }
  if (!capability.available) {
    const trimmed = capability.reason?.trim();
    return {
      status: 'unavailable',
      cause: 'no-desplegado',
      reason: trimmed ?? TERMINAL_RELAY_NOT_DEPLOYED_REASON,
    };
  }
  const trimmedReason = capability.reason?.trim();
  return { status: 'available', reason: trimmedReason ?? 'Relay de terminales disponible.' };
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
