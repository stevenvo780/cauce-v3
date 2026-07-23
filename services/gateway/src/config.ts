export const DEFAULT_ACK_DEADLINE_MS = 30_000;

export function validateAckDeadlineMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('CAUCE_ACK_DEADLINE_MS must be a positive integer');
  }
  return value;
}

export function configuredAckDeadlineMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return validateAckDeadlineMs(Number(
    environment.CAUCE_ACK_DEADLINE_MS ?? DEFAULT_ACK_DEADLINE_MS,
  ));
}
