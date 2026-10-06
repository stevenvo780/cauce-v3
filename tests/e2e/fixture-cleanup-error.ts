const CLEANUP_STEPS = [
  'browser context',
  'owned browser runtime',
  'CDP browser',
  'owned browser container',
  'owned browser network',
  'owned browser image',
  'Vite server',
  'terminal relay',
  'port reservations',
  'inspect agent container',
  'owned agent container',
  'verify agent container removal',
  'agent exec process',
  'gateway',
  'database pool',
  'owned PostgreSQL container',
  'owned Python image',
  'build context',
  'private TLS directory',
] as const;

export type CleanupStep = typeof CLEANUP_STEPS[number];

export function cleanupLabelsForFailure(step: CleanupStep, error: unknown): CleanupStep[] {
  const labels: CleanupStep[] = [step];
  if (step !== 'owned browser runtime' || !(error instanceof AggregateError)) return labels;

  const browserLabels = new Map<string, CleanupStep>([
    ['cleanup failed for CDP browser', 'CDP browser'],
    ['cleanup failed for owned browser container', 'owned browser container'],
    ['cleanup failed for owned browser network', 'owned browser network'],
    ['cleanup failed for owned browser image', 'owned browser image'],
  ]);
  for (const nested of error.errors) {
    if (nested instanceof Error) {
      const label = browserLabels.get(nested.message);
      if (label) labels.push(label);
    }
  }
  return labels;
}

export function createCleanupAggregate(errors: readonly Error[], labels: readonly CleanupStep[]): AggregateError {
  const safeLabels = [...new Set(labels.filter((label) => CLEANUP_STEPS.includes(label)))];
  const details = safeLabels.length > 0 ? `; failed steps: ${safeLabels.join(', ')}` : '';
  return new AggregateError([...errors], `real PTY fixture cleanup incomplete${details}`);
}
