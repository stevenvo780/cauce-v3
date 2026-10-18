import { ApiError } from '../../api/client';
import { spanishWithReason } from '../../api/error-message';
import { configurationMutationSha256 } from '@cauce/protocol/configuration';
import type { ConfigMutation, ConfigurationChangeResult, ConfigurationSnapshot } from '../../api/types';
import type { RecargaResultado } from '../../api/use-resource';
import { dependencySummary } from './config-dependencies';
import { exactConfigurationReceipt } from './config-receipt';

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

interface ConfigurationChangeTransport {
  mutation: ConfigMutation;
  dryRun: boolean;
  expectedRevision?: number;
  change: (
    mutation: ConfigMutation,
    options: { dryRun: boolean; expectedRevision?: number },
  ) => Promise<ConfigurationChangeResult>;
  reload: () => Promise<RecargaResultado<ConfigurationSnapshot>>;
  describeError?: (error: unknown) => { message: string; conflict: boolean };
  fallback?: string;
  camino?: CaminoDeCambio;
}

/**
 * Sentence that is ADDED to the notice to describe the reload outcome. `undefined` (a dry-run,
 * which writes nothing) adds nothing: there was no reload to describe.
 */
export function textoRecarga(recarga: EstadoRecarga | undefined): string {
  if (!recarga) return '';
  return recarga.releido
    ? ` Releído del servidor: las tablas de abajo están en la revisión ${String(recarga.revision ?? 'desconocida')}.`
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

const CONFLICTOS: Record<string, string> = {
  'revision changed': 'otro operador cambió la configuración mientras tanto',
  'already exists': 'ya existe un registro con esa identidad',
  'durable dependencies': 'el recurso todavía tiene dependencias (miembros, entregas o historial)',
  'primary membership must be removed': 'primero hay que quitarle al agente su grupo principal',
  'membership has active deliveries': 'la membresía tiene entregas en curso',
  'require a verified fleet operation': 'ese cambio toca la ejecución del agente y se hace con una operación de flota (pestaña Operación)',
  'requires a verified fleet operation': 'la admisión del agente se habilita con una operación de flota (pestaña Operación)',
  'identity is permanent': 'el historial conserva esa identidad eliminada y no permite reutilizarla; elige una identidad nueva',
  'last hub or human control authority': 'no se puede quitar la última autoridad de control humano',
  'retirement state is incomplete': 'el retiro todavía no terminó',
  'violates a durable constraint': 'el cambio contradice una restricción guardada',
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
  const blockers = error instanceof ApiError && error.status === 409 ? dependencySummary(error.dependencies) : undefined;
  if (blockers) {
    return { conflict: false, message: `El servidor rechazó el cambio y no se aplicó nada: lo bloquean ${blockers}. `
      + 'Resuélvelas primero: las membresías se quitan en la pestaña Grupos o en «Espacios y salas»; las entregas o conexiones activas '
      + 'tienen que terminar; un agente con ejecución se elimina con «Eliminar», que lo retira y después lo purga con su historial conservado.' };
  }
  if (error instanceof ApiError && error.status === 409) {
    const known = Object.entries(CONFLICTOS).find(([english]) => error.message.toLowerCase().includes(english))?.[1];
    return { conflict: false, message: `El servidor rechazó el cambio y no se aplicó nada: ${known ?? `hay un conflicto con el estado guardado («${error.message}»)`}. `
      + 'Relee el inventario y vuelve a intentarlo sobre los datos actuales.' };
  }
  if (error instanceof ApiError && error.status === 400 && error.code === 'invalid_request') {
    return { conflict: false, message: spanishWithReason(
      'La solicitud de configuración no tiene el formato esperado. Revisa los campos y vuelve a guardar.',
      error.message,
    ) };
  }
  if (error instanceof ApiError && error.status === 403) {
    return { conflict: false, message: spanishWithReason(
      'Tu sesión no cumple las condiciones para este cambio. Revisa el permiso de control con un operador y vuelve a consultar antes de enviarlo.',
      error.message,
    ) };
  }
  if (error instanceof ApiError && error.status === 404 && error.code === 'not_found') {
    return { conflict: false, message: spanishWithReason(
      'No se encontró esa revisión de configuración. Actualiza el historial y selecciona una revisión disponible antes de revertir.',
      error.message,
    ) };
  }
  if (error instanceof ApiError && error.status === 422) {
    return { conflict: false, message: spanishWithReason(
      'El servidor no acepta la combinación de recursos o actor seleccionados. Relee el inventario, revisa las dependencias y corrige el cambio antes de volver a enviarlo.',
      error.message,
    ) };
  }
  if (error instanceof ApiError && error.status === 401) {
    return { conflict: false, message: spanishWithReason(
      'Tu sesión terminó. Vuelve a entrar y reintenta el cambio.',
      error.message,
    ) };
  }
  if (error instanceof ApiError && error.status === 400) {
    return { conflict: false, message: spanishWithReason(
      'El servidor rechazó los datos del cambio. Revisa los campos y vuelve a guardar.',
      error.message,
    ) };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { conflict: false, message: spanishWithReason(
      'El recurso ya no existe. Relee el inventario y vuelve a intentarlo sobre los datos actuales.',
      error.message,
    ) };
  }
  if (error instanceof ApiError && error.status === 429) {
    return { conflict: false, message: spanishWithReason(
      'Hay demasiadas solicitudes. Espera un momento y vuelve a intentarlo.',
      error.message,
    ) };
  }
  if (error instanceof ApiError && error.status >= 500) {
    return { conflict: false, message: 'El servidor no pudo completar el cambio. No se aplicó nada que la consola pueda acreditar: relee el inventario para comprobar el estado antes de reintentar.' };
  }
  if (error instanceof ApiError) {
    return { conflict: false, message: spanishWithReason(
      'El servidor rechazó el cambio y no se aplicó nada. Relee el inventario y vuelve a intentarlo.',
      error.message,
    ) };
  }
  return { conflict: false, message: error instanceof Error ? error.message : fallback };
}

export async function executeConfigurationChange(
  options: ConfigurationChangeTransport,
): Promise<ConfigChangeOutcome> {
  async function reload(): Promise<EstadoRecarga> {
    const result = await options.reload();
    if (result.error) return { releido: false, motivo: result.error.message };
    const revision = typeof result.data.revision === 'number' ? result.data.revision : undefined;
    return { releido: true, ...(revision === undefined ? {} : { revision }) };
  }

  try {
    const expectedMutationSha256 = await configurationMutationSha256(options.mutation);
    const result = await options.change(options.mutation, {
      dryRun: options.dryRun,
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
    });
    if (!exactConfigurationReceipt(result, options.dryRun, options.mutation, null, expectedMutationSha256)) {
      const recarga = options.dryRun ? undefined : await reload();
      return {
        ok: false,
        conflict: false,
        uncertain: !options.dryRun,
        message: options.dryRun
          ? 'El servidor devolvió un 2xx sin el recibo exacto del dry-run; no se habilitó aplicar.'
          : 'El servidor devolvió un 2xx sin el recibo durable exacto del cambio. La escritura puede haberse aplicado; verificá la relectura antes de repetirla.',
        ...(recarga === undefined ? {} : { recarga }),
      };
    }
    if (options.dryRun) return { ok: true, result };
    return { ok: true, result, recarga: await reload() };
  } catch (error) {
    const described = options.describeError?.(error)
      ?? describeConfigError(error, options.fallback ?? 'Cambio rechazado sin detalle del servidor', options.camino);
    return described.conflict
      ? { ok: false, ...described, recarga: await reload() }
      : { ok: false, ...described };
  }
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
