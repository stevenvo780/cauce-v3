import type pg from 'pg';

export const legacyConsoleOutboxReason: string;

export interface LegacyConsoleInspection {
  thresholdSeconds: number;
  baselineAt: string | null;
  reason: string;
  counts: {
    candidates: number;
    staleProcessing: number;
    inconsistentDeadLetters: number;
    deadTotal: number;
    deadBeforeBaseline: number;
    deadAfterBaseline: number;
    deadLast24h: number;
    reconciliationAudits: number;
  };
  oldestCandidateSeconds: number | null;
}

export function inspectLegacyConsoleOutbox(
  pool: pg.Pool,
  options?: { thresholdSeconds?: number; baselineAt?: string | null },
): Promise<LegacyConsoleInspection>;

export function applyLegacyConsoleOutboxReconciliation(
  pool: pg.Pool,
  options?: { thresholdSeconds?: number; expectedCandidates?: number },
): Promise<{ appliedCount: number; alreadyApplied: boolean; rowDigests: string[] }>;
