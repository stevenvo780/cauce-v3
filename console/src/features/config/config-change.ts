import { ApiError } from '../../api/client';
import type { ConfigurationChangeResult } from '../../api/types';

/**
 * What happened with the RELOAD of the snapshot that follows a write. It exists because
 * "it reloaded" was a claim the screen did not verify: `config.reload()` was called without
 * awaiting it, and the banner appeared anyway even if the GET failed. A screen cannot assert
 * what it did not verify.
 */
export type EstadoRecarga =
  | { releido: true; revision?: number }
  | { releido: false; motivo: string };

export type ConfigChangeOutcome =
  | { ok: true; result: ConfigurationChangeResult; recarga?: EstadoRecarga }
  | { ok: false; message: string; conflict: boolean; uncertain?: boolean; recarga?: EstadoRecarga };

/**
 * Sentence that is ADDED to the notice to describe the reload outcome. `undefined` (a dry-run,
 * which writes nothing) adds nothing: there was no reload to describe.
 */
export function textoRecarga(recarga: EstadoRecarga | undefined): string {
  if (!recarga) return '';
  return recarga.releido
    ? ` Releído del servidor: las tablas de abajo están en la revisión ${String(recarga.revision ?? 'UNKNOWN')}.`
    : ` PERO la relectura del snapshot NO llegó (${recarga.motivo}): las tablas de abajo pueden estar`
      + ' vencidas, usá «Actualizar» antes de seguir tocando.';
}

const REVISION_MISMATCH = /revision changed: expected (\d+), current (\d+)/i;

/**
 * The gateway maps every configuration conflict to 409 — duplicate row, tenant with active
 * deliveries, stale revision — so the status alone does not identify the optimistic clash:
 * only the store message carries the expected/current pair.
 */
function revisionMismatch(error: unknown): { expected: string; current: string } | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const match = REVISION_MISMATCH.exec(error.message);
  return match ? { expected: match[1], current: match[2] } : undefined;
}

/**
 * Which path the clashing write came from. It exists because the 409 message told EVERYONE
 * alike to "go back to preview", including the one-click buttons on the tables and the audit
 * trail rollback, which have no dry-run: the operator read an instruction impossible to follow
 * and did not know what was expected of them. Text that does not serve the path it is used on
 * is as useless as saying nothing.
 */
export type CaminoDeCambio = 'previsualizado' | 'directo' | 'rollback';

/** What to do after the clash, depending on the path that triggered it. */
const QUE_HACER: Record<CaminoDeCambio, string> = {
  previsualizado: 'revisá los datos efectivos, volvé a previsualizar y recién ahí aplicá.',
  directo: 'revisá los datos efectivos y volvé a pedir el cambio sobre la revisión nueva.',
  rollback: 'revisá los datos efectivos y volvé a elegir en el audit trail la revisión a deshacer '
    + 'sobre el estado nuevo.',
};

/** How the stale revision was reached, per path. */
const COMO_LLEGO: Record<CaminoDeCambio, string> = {
  previsualizado: 'previsualizaste sobre la revisión',
  directo: 'pediste el cambio sobre la revisión',
  rollback: 'pediste el rollback sobre la revisión',
};

export function describeConfigError(
  error: unknown,
  fallback: string,
  camino: CaminoDeCambio = 'previsualizado',
): { message: string; conflict: boolean } {
  const mismatch = revisionMismatch(error);
  if (mismatch) {
    return {
      conflict: true,
      // The text does NOT say "the snapshot was reloaded": the caller is the only one who knows
      // whether the reload arrived, and appends it via `textoRecarga` AFTER awaiting it.
      message: `Conflicto de revisión: ${COMO_LLEGO[camino]} ${mismatch.expected} y el servidor ya va por la ${mismatch.current}. `
        + `Otro operador cambió la configuración y no se aplicó nada: ${QUE_HACER[camino]}`,
    };
  }
  return { conflict: false, message: error instanceof Error ? error.message : fallback };
}

/**
 * **A 403 when READING the configuration is a permission failure, not the control plane going down.**
 *
 * `GET /v3/console/config` requires `read` — NOT `control`, which only the mutations demand: the
 * caller must name the READ permission, or the operator comes back with the wrong one and still no
 * view. Reaching `/config` by bookmark used to land on the generic `ErrorState` ("Could not read
 * Cauce V3 / Forbidden / Retry"), which is three lies: Cauce reads fine, "Forbidden" explains
 * nothing, and retrying cannot change a permission.
 */
export function esNegativaDePermiso(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 403;
}
