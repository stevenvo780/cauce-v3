export const DEFAULT_ACK_DEADLINE_MS = 30_000;
export const DEFAULT_ACK_TIMEOUT_MS = 30_000;

export interface DispatcherConfig {
  pollMs: number;
  ackDeadlineMs: number;
  ackTimeoutMs: number;
  interactiveBurst: number;
  jobLeaseMs: number;
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(environment[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function configuredDispatcher(environment: NodeJS.ProcessEnv = process.env): DispatcherConfig {
  const ackDeadlineMs = positiveInteger(
    environment,
    'CAUCE_ACK_DEADLINE_MS',
    DEFAULT_ACK_DEADLINE_MS,
  );
  const ackTimeoutMs = positiveInteger(environment, 'ACK_TIMEOUT_MS', DEFAULT_ACK_TIMEOUT_MS);
  if (ackTimeoutMs < ackDeadlineMs) {
    throw new Error('ACK_TIMEOUT_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS');
  }
  return {
    pollMs: positiveInteger(environment, 'DISPATCHER_POLL_MS', 250),
    ackDeadlineMs,
    ackTimeoutMs,
    interactiveBurst: positiveInteger(environment, 'INTERACTIVE_BURST', 3),
    jobLeaseMs: positiveInteger(environment, 'JOB_LEASE_MS', 30_000),
  };
}
