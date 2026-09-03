export function runtimeErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function runtimeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function runtimeErrorStatus(error: unknown): number {
  const code = runtimeErrorCode(error);
  if (code === 'conflict' || code === 'truncated' || code === 'invalid_path') return 409;
  if (code === 'unavailable' || code === 'timeout') return 503;
  if (code === 'too_large') return 413;
  return 502;
}
