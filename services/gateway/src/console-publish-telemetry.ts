export type ConsolePublishTelemetryEvent =
  | Readonly<{ operation: 'prepare'; result: 'prepared' | 'committed' | 'reconciliation_required' | 'rate_limited' | 'error' }>
  | Readonly<{ operation: 'publish'; result: 'committed' | 'expired' | 'error' }>
  | Readonly<{ operation: 'confirm'; result: 'confirmed' | 'error' }>;

export const consolePublishTelemetryVocabulary = [
  { operation: 'prepare', result: 'prepared' },
  { operation: 'prepare', result: 'committed' },
  { operation: 'prepare', result: 'reconciliation_required' },
  { operation: 'prepare', result: 'rate_limited' },
  { operation: 'prepare', result: 'error' },
  { operation: 'publish', result: 'committed' },
  { operation: 'publish', result: 'expired' },
  { operation: 'publish', result: 'error' },
  { operation: 'confirm', result: 'confirmed' },
  { operation: 'confirm', result: 'error' },
] as const satisfies readonly ConsolePublishTelemetryEvent[];

function eventKey(event: ConsolePublishTelemetryEvent): string {
  return `${event.operation}:${event.result}`;
}

/**
 * Process-local request outcomes for the durable console journal. The vocabulary is fixed and has
 * no tenant, alias, operator, nonce, message, key or session labels, so it is safe to scrape.
 */
export class ConsolePublishTelemetry {
  private readonly counters = new Map(
    consolePublishTelemetryVocabulary.map((event) => [eventKey(event), 0]),
  );

  record(event: ConsolePublishTelemetryEvent): void {
    const key = eventKey(event);
    const current = this.counters.get(key);
    if (current === undefined) throw new Error('unknown console publish telemetry outcome');
    this.counters.set(key, current + 1);
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.counters);
  }
}
