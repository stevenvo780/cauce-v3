export interface BackoffSchedule {
  readonly baseSeconds: number;
  readonly capSeconds: number;
}

export function exponentialBackoff(attempt: number, options: BackoffSchedule): number {
  return Math.min(options.capSeconds, options.baseSeconds * 2 ** Math.max(0, attempt - 1));
}
