import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SharedSessionDegradation } from "./types.js";

/**
 * Registro persistente de eventos de degradación de la sesión compartida.
 */

export const DEGRADATION_LOG_NAME = "shared-session.log";

/** Cantidad por defecto de entradas devueltas en la lectura. */
const DEFAULT_TAIL = 5;

/** Techo de lectura para que un log crecido no se cargue entero en memoria. */
const MAX_READ_BYTES = 256 * 1024;

export interface DegradationRecord extends SharedSessionDegradation {
  readonly alias: string;
  readonly harness: string;
}

export function degradationLogPath(stateDirectory: string): string {
  return join(stateDirectory, DEGRADATION_LOG_NAME);
}

/**
 * Nunca propaga un fallo de escritura.
 *
 * Un turno que ya se respondió no se puede perder porque el disco no aceptó una línea de
 * telemetría. El aviso ya viajó por otras dos vías (el panel y el propio "reply").
 */
export async function recordDegradation(
  stateDirectory: string,
  record: DegradationRecord,
): Promise<void> {
  try {
    await appendFile(degradationLogPath(stateDirectory), `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Ver el comentario de arriba.
  }
}

export async function readDegradations(
  stateDirectory: string,
  tail: number = DEFAULT_TAIL,
): Promise<readonly DegradationRecord[]> {
  let raw: string;
  try {
    raw = await readFile(degradationLogPath(stateDirectory), "utf8");
  } catch {
    return [];
  }
  const bounded = raw.length > MAX_READ_BYTES ? raw.slice(raw.length - MAX_READ_BYTES) : raw;
  const records: DegradationRecord[] = [];
  for (const line of bounded.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        records.push(value as DegradationRecord);
      }
    } catch {
      // Una línea truncada por un corte de disco no invalida las demás.
    }
  }
  return records.slice(-tail);
}
