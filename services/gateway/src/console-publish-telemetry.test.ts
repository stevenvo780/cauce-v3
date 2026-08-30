import { describe, expect, it } from 'vitest';
import { renderConsolePublishMetrics } from './health.js';
import {
  ConsolePublishTelemetry, consolePublishTelemetryVocabulary,
} from './console-publish-telemetry.js';

describe('identity-free console publish telemetry', () => {
  it('renders every fixed operation/result and counts bounded outcomes', () => {
    const telemetry = new ConsolePublishTelemetry();
    telemetry.record({ operation: 'prepare', result: 'rate_limited' });
    telemetry.record({ operation: 'publish', result: 'expired' });
    telemetry.record({ operation: 'confirm', result: 'confirmed' });
    const metrics = renderConsolePublishMetrics(telemetry);
    for (const event of consolePublishTelemetryVocabulary) {
      expect(metrics).toContain(
        `operation="${event.operation}",result="${event.result}"`,
      );
    }
    expect(metrics).toContain('operation="prepare",result="rate_limited"} 1');
    expect(metrics).toContain('operation="publish",result="expired"} 1');
    expect(metrics).toContain('operation="confirm",result="confirmed"} 1');
    expect(metrics).not.toMatch(/tenant|alias|operator|nonce|message_id|idempotency/u);
  });

  it('fails closed on an invented event or malformed snapshot', () => {
    expect(() => { telemetryWithInventedOutcome(); }).toThrow(/unknown console publish telemetry outcome/u);
    expect(() => renderConsolePublishMetrics({
      snapshot: () => ({ 'prepare:prepared': -1 }),
    })).toThrow(/unknown counter|invalid console publish/u);
  });
});

function telemetryWithInventedOutcome(): void {
  const telemetry = new ConsolePublishTelemetry();
  telemetry.record({ operation: 'prepare', result: 'invented' } as never);
}
