/**
 * Runtime detection for the PTY relay (see commit `0a1d0e3`: the relay is opt-in per stack,
 * so its absence is an expected topology, not a bug). This module is the single source of
 * truth both the Terminal page and the app shell's nav entry should read, so they never
 * disagree about whether the interactive channel is actually reachable.
 *
 * Doctrine, same as the rest of this feature: anything short of an explicit `available: true`
 * — a declared-unavailable payload, a 404/501 (already normalised by `getTerminalCapability`),
 * a raw 502/503 from a gateway with no upstream, or a bare network failure — collapses to
 * `unavailable` with an operator-facing one-liner. Nothing here ever reports `available` on an
 * ambiguous answer, and a check in flight is `checking`, never silently `available`.
 */
import { useEffect, useState } from 'react';
import { ApiError, type CauceApi } from '../../api/client';
import { useApi } from '../../api/context';
import type { TerminalCapability } from '../../api/types';

export type TerminalRelayStatus = 'checking' | 'available' | 'unavailable';

export interface TerminalRelayState {
  status: TerminalRelayStatus;
  /** Operator-facing, one-line explanation. Always set once `status` leaves `checking`. */
  reason: string;
}

export const TERMINAL_RELAY_NOT_DEPLOYED_REASON = 'El relay de terminales no está desplegado en este stack.';

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
    return {
      status: 'unavailable',
      reason: status
        ? `${TERMINAL_RELAY_NOT_DEPLOYED_REASON} (HTTP ${status} al consultarlo.)`
        : detail
          ? `${TERMINAL_RELAY_NOT_DEPLOYED_REASON} (${detail}.)`
          : TERMINAL_RELAY_NOT_DEPLOYED_REASON,
    };
  }
  if (!capability) return CHECKING_RELAY_STATE;
  if (capability.available !== true) {
    return { status: 'unavailable', reason: capability.reason?.trim() || TERMINAL_RELAY_NOT_DEPLOYED_REASON };
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
