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
import { createContext, createElement, useContext, useEffect, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { useApi } from '../../api/context';
import type { TerminalCapability } from '../../api/types';
import { useResource, type Resource } from '../../api/use-resource';

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

const TerminalCapabilityContext = createContext<Resource<TerminalCapability> | undefined>(undefined);

/** Owns the sole capability read used by both navigation and the Terminal page. */
export function TerminalRelayProvider({ children, pollMs = 30_000 }: {
  children?: ReactNode;
  pollMs?: number;
}) {
  const api = useApi();
  const capability = useResource('terminal-relay-capability', () => api.getTerminalCapability());
  const capabilityLoading = capability.loading;
  const reloadCapability = capability.reload;

  useEffect(() => {
    if (capabilityLoading) return;
    const interval = window.setInterval(() => { void reloadCapability(); }, pollMs);
    return () => { window.clearInterval(interval); };
  }, [capabilityLoading, pollMs, reloadCapability]);

  return createElement(TerminalCapabilityContext.Provider, { value: capability }, children);
}

/** Adds a local owner only for isolated renders; the real app already has the provider at its shell. */
export function TerminalRelayBoundary({ children, pollMs }: { children: ReactNode; pollMs?: number }) {
  const shared = useContext(TerminalCapabilityContext);
  return shared
    ? children
    : createElement(TerminalRelayProvider, { pollMs }, children);
}

export function useTerminalCapability(): Resource<TerminalCapability> {
  const capability = useContext(TerminalCapabilityContext);
  if (!capability) {
    throw new Error('Terminal capability must be read inside TerminalRelayProvider.');
  }
  return capability;
}

export function useTerminalRelayStatus(): TerminalRelayState {
  const capability = useTerminalCapability();
  return deriveTerminalRelayState(capability.data, capability.error);
}
