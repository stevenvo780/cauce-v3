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

/**
 * 🔴 **Por qué no se puede usar la terminal. Añadido el 2026-08-22, y por una mentira medida.**
 *
 * Con una cuenta SIN permiso `control`, `GET /v3/console/terminal/capability` responde **403**:
 * la ruta exige `requireOperatorPermission(actor, 'control')` ANTES de mirar si el backend PTY
 * está configurado (`services/gateway/src/app.ts`). Es el MISMO gate que `/v3/console/config`.
 * Esta función leía cualquier error como ausencia y a Miguel le decía, palabra por palabra, «El
 * relay de terminales no está desplegado en este stack. (HTTP 403 al consultarlo.)» con el relay
 * desplegado y sano al otro lado. A `/config`, con el mismo 403, la consola ya le decía la verdad.
 *
 * Se distinguen sólo las dos causas que la respuesta permite distinguir:
 * - `sin-permiso`: 403. Es del RBAC, no de la topología.
 * - `no-desplegado`: 404/501 —ya normalizados a `available:false` por `getTerminalCapability`— y
 *   un `available:false` declarado por el servidor.
 *
 * ⚠️ Un 502/503 o un fallo de red **siguen** leyéndose como `no-desplegado`, que es lo que esta
 * función hacía desde `0a1d0e3`: esas respuestas no permiten saber si el relay existe. No se
 * inventa una tercera causa para taparlo.
 */
/**
 * 🔴 **`sin-comprobar` añadido el 2026-08-23, y por la MISMA clase de mentira.**
 *
 * Medido en producción: la vista mostraba «Canal PTY no disponible en este stack — El relay de
 * terminales no está desplegado en este stack. (HTTP 400 al consultarlo.)». Ninguna de las dos
 * frases se seguía de un 400: un 400 sólo prueba que la ruta EXISTE y que rechazó la petición.
 * Culpar al despliegue manda al operador a mirar contenedores mientras el fallo está en la
 * consola —que fue exactamente lo que pasó— así que cualquier respuesta que no signifique
 * ausencia se dice como lo que es: no se pudo comprobar.
 *
 * Qué sí significa cada cosa, y nada más que eso:
 * - `no-desplegado`: 404/501 —ya normalizados a `available:false` por `getTerminalCapability`—,
 *   un `available:false` declarado por el servidor, y 502/503/504 o un fallo de red, donde no
 *   hay upstream que conteste (es lo que este módulo hace desde `0a1d0e3`).
 * - `sin-permiso`: 403. Es del RBAC, no de la topología; el gate corre ANTES de mirar el backend.
 * - `sin-comprobar`: TODO lo demás (400, 401, 405, 409, 422, 429, 500…). La ruta contestó, así
 *   que no está ausente; y contestó algo que no permite afirmar nada sobre el relay.
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
 * Mismo reparto de palabras que `CONFIG_SIN_CONTROL_REASON` en `navigation.ts`, y a propósito:
 * es el mismo permiso, negado por el mismo gate. Dos redacciones distintas para la misma negativa
 * le harían creer al operador que son dos problemas.
 */
export const TERMINAL_RELAY_SIN_PERMISO_REASON =
  'Tu cuenta no tiene permiso de control sobre esta flota: la terminal de agentes es del dueño del bus. '
  + 'El relay puede estar perfectamente desplegado; lo que falta es el permiso.';

/** Estados que sí prueban ausencia de upstream: no hay nadie del otro lado que conteste. */
const SIN_UPSTREAM = [502, 503, 504];

export const TERMINAL_RELAY_SIN_COMPROBAR_TITULO = 'No se pudo comprobar el canal PTY';

export function terminalRelaySinComprobarReason(status: number, detalle?: string): string {
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
    // Una respuesta que NO es 404/501 ni un corte de upstream prueba que la ruta existe: decir
    // «no está desplegado» ahí es inventar una causa que la respuesta no sostiene.
    if (status !== undefined && status !== 404 && status !== 501 && !SIN_UPSTREAM.includes(status)) {
      return {
        status: 'unavailable',
        cause: 'sin-comprobar',
        reason: terminalRelaySinComprobarReason(status, detail),
      };
    }
    return {
      status: 'unavailable',
      cause: 'no-desplegado',
      reason: status
        ? `${TERMINAL_RELAY_NOT_DEPLOYED_REASON} (HTTP ${status} al consultarlo.)`
        : detail
          ? `${TERMINAL_RELAY_NOT_DEPLOYED_REASON} (${detail}.)`
          : TERMINAL_RELAY_NOT_DEPLOYED_REASON,
    };
  }
  if (!capability) return CHECKING_RELAY_STATE;
  if (capability.available !== true) {
    return {
      status: 'unavailable',
      cause: 'no-desplegado',
      reason: capability.reason?.trim() || TERMINAL_RELAY_NOT_DEPLOYED_REASON,
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
