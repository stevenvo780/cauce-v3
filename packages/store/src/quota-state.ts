export const QUOTA_STALE_AFTER_SECONDS = 900;
export type QuotaObservationStatus = 'unknown' | 'error' | 'stale' | 'ok';

export function quotaObservationStatus(input: {
  receivedAt: Date | null; capturedAt?: Date | null; resetAt: Date | null; status: string | null;
  providerOk: boolean | null; hasValue: boolean; now: Date;
}): QuotaObservationStatus {
  if (input.receivedAt === null) return 'unknown';
  const capturedAt = input.capturedAt === undefined ? input.receivedAt : input.capturedAt;
  if (capturedAt === null || !Number.isFinite(capturedAt.getTime()) || capturedAt.getTime()>input.now.getTime()+60_000) return 'unknown';
  if (input.status === 'stale' || input.now.getTime() - input.receivedAt.getTime() > QUOTA_STALE_AFTER_SECONDS * 1000
    || input.now.getTime() - capturedAt.getTime() > QUOTA_STALE_AFTER_SECONDS * 1000) return 'stale';
  if (input.providerOk === false || input.status === 'error') return 'error';
  if (input.status === 'unknown' || !input.hasValue
      || (input.resetAt !== null && input.resetAt.getTime() <= input.now.getTime())) return 'unknown';
  return 'ok';
}

export function quotaRemaining(remaining: number | null, used: number | null): number | null {
  return remaining ?? (used === null ? null : Math.max(0, Math.min(100, 100 - used)));
}
