import { ApiError } from '../../api/client';
import type { ConfigurationChangeResult } from '../../api/types';

/**
 * Qué pasó con la RELECTURA del snapshot que sigue a una escritura. Existe porque «se recargó» era
 * una afirmación que la pantalla no comprobaba: `config.reload()` se llamaba sin esperarla y el
 * cartel salía igual aunque el GET fallara. Una pantalla no puede afirmar lo que no comprobó.
 */
export type EstadoRecarga =
  | { releido: true; revision?: number }
  | { releido: false; motivo: string };

export type ConfigChangeOutcome =
  | { ok: true; result: ConfigurationChangeResult; recarga?: EstadoRecarga }
  | { ok: false; message: string; conflict: boolean; uncertain?: boolean; recarga?: EstadoRecarga };

/**
 * Frase que se le AGREGA al aviso para contar el desenlace de la relectura. `undefined` (un
 * dry-run, que no escribe nada) no agrega nada: no hubo relectura que contar.
 */
export function textoRecarga(recarga: EstadoRecarga | undefined): string {
  if (!recarga) return '';
  return recarga.releido
    ? ` Releído del servidor: las tablas de abajo están en la revisión ${recarga.revision ?? 'UNKNOWN'}.`
    : ` PERO la relectura del snapshot NO llegó (${recarga.motivo}): las tablas de abajo pueden estar`
      + ' vencidas, usá «Actualizar» antes de seguir tocando.';
}

const REVISION_MISMATCH = /revision changed: expected (\d+), current (\d+)/i;

/**
 * El gateway mapea a 409 cualquier conflicto de configuración —fila duplicada, tenant con
 * deliveries activas, revisión vencida—, así que el status por sí solo no identifica el choque
 * optimista: sólo el mensaje del store trae el par expected/current.
 */
function revisionMismatch(error: unknown): { expected: string; current: string } | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const match = REVISION_MISMATCH.exec(error.message);
  return match ? { expected: match[1], current: match[2] } : undefined;
}

/**
 * Por qué camino se pidió la escritura que chocó. Existe porque el mensaje del 409 mandaba a
 * «volver a previsualizar» a TODOS por igual, incluidos los botones de un clic de las tablas y el
 * rollback del audit trail, que no tienen dry-run: el operador leía una instrucción imposible de
 * seguir y no sabía qué se esperaba de él. Un texto que no sirve para el camino que lo usa es tan
 * inútil como no decir nada.
 */
export type CaminoDeCambio = 'previsualizado' | 'directo' | 'rollback';

/** Qué hacer después del choque, según el camino que lo disparó. */
const QUE_HACER: Record<CaminoDeCambio, string> = {
  previsualizado: 'revisá los datos efectivos, volvé a previsualizar y recién ahí aplicá.',
  directo: 'revisá los datos efectivos y volvé a pedir el cambio sobre la revisión nueva.',
  rollback: 'revisá los datos efectivos y volvé a elegir en el audit trail la revisión a deshacer '
    + 'sobre el estado nuevo.',
};

/** Cómo se llegó a la revisión vencida, según el camino. */
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
      // El texto NO dice «se recargó el snapshot»: quien llama es el único que sabe si la
      // relectura llegó, y lo agrega con `textoRecarga` DESPUÉS de esperarla.
      message: `Conflicto de revisión: ${COMO_LLEGO[camino]} ${mismatch.expected} y el servidor ya va por la ${mismatch.current}. `
        + `Otro operador cambió la configuración y no se aplicó nada: ${QUE_HACER[camino]}`,
    };
  }
  return { conflict: false, message: error instanceof Error ? error.message : fallback };
}

/**
 * **Un 403 al LEER la configuración es una falta de permiso, no una caída del control plane.**
 *
 * `GET /v3/console/config` exige `requireOperatorPermission(actor,'control')`. La barra lateral ya
 * lo sabía desde el 2026-08-22 y dejaba la entrada inerte con el motivo escrito
 * (`configNavAvailability`), pero quien llegaba a `/config` por un marcador o pegando la URL se
 * saltaba el menú entero y aterrizaba en el `ErrorState` genérico: «No se pudo leer Cauce V3 /
 * Forbidden / Reintentar». Tres mentiras en una línea —Cauce se lee perfectamente, «Forbidden» no
 * explica nada, y reintentar no puede cambiar un permiso— para el mismo hecho que la barra contaba
 * bien tres centímetros a la izquierda.
 */
export function esNegativaDeControl(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 403;
}
