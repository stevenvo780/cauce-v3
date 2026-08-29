import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SharedSessionDegradation } from "./types.js";

/**
 * Persistent log of shared-session degradation events.
 */

export const DEGRADATION_LOG_NAME = "shared-session.log";

/** Default number of entries returned on read. */
const DEFAULT_TAIL = 5;

/** Read cap so that a grown log is not loaded whole into memory. */
const MAX_READ_BYTES = 256 * 1024;

export interface DegradationRecord extends SharedSessionDegradation {
  readonly alias: string;
  readonly harness: string;
}

export function degradationLogPath(stateDirectory: string): string {
  return join(stateDirectory, DEGRADATION_LOG_NAME);
}

/**
 * Never propagates a write failure.
 *
 * A turn that has already been answered cannot be lost because the disk did not accept a line of
 * telemetry. The notice already travelled by two other paths (the panel and the "reply" itself).
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
    // See the comment above.
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
      // A line truncated by a disk cut does not invalidate the rest.
    }
  }
  return records.slice(-tail);
}
