import { ApiError } from '../../api/client';
import type { ConfigurationChangeResult } from '../../api/types';

export type ConfigChangeOutcome =
  | { ok: true; result: ConfigurationChangeResult }
  | { ok: false; message: string; conflict: boolean };

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

export function describeConfigError(error: unknown, fallback: string): { message: string; conflict: boolean } {
  const mismatch = revisionMismatch(error);
  if (mismatch) {
    return {
      conflict: true,
      message: `Conflicto de revisión: previsualizaste sobre la revisión ${mismatch.expected} y el servidor ya va por la ${mismatch.current}. `
        + 'Otro operador cambió la configuración y no se aplicó nada. Se recargó el snapshot: revisá los datos efectivos, '
        + 'volvé a previsualizar y recién ahí aplicá.',
    };
  }
  return { conflict: false, message: error instanceof Error ? error.message : fallback };
}
