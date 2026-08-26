import { describe, expect, it } from 'vitest';
import { readableAuditSummary } from './audit-summary';

describe('readableAuditSummary', () => {
  it('turns server metadata into bounded operator-facing fields instead of raw JSON', () => {
    expect(readableAuditSummary('{"ack":"started","epoch":29,"retryable":false}'))
      .toBe('ack: started · epoch: 29 · retryable: No');
  });

  it('handles nested values and arrays without dumping the object topology', () => {
    expect(readableAuditSummary(JSON.stringify({
      target: { tenant_id: 'Steven', alias: 'kant' },
      states: ['accepted', 'started', 'done', 'ignored'],
    }))).toBe('target · tenant id: Steven · target · alias: kant · states: accepted, started, done (+1)');
  });

  it('does not echo malformed structured metadata as if it were a readable summary', () => {
    expect(readableAuditSummary('{"ack":"started"')).toBe('Resumen estructurado incompleto o no legible');
  });

  it('preserves ordinary prose, normalises control whitespace and bounds output', () => {
    expect(readableAuditSummary('  Entrega\naceptada\tpor kant  ')).toBe('Entrega aceptada por kant');
    expect(readableAuditSummary('x'.repeat(900))).toMatch(/^x{319}…$/u);
  });

  it('keeps absence distinct from an empty structured value', () => {
    expect(readableAuditSummary(null)).toBeUndefined();
    expect(readableAuditSummary('{}')).toBe('Sin campos');
    expect(readableAuditSummary('[]')).toBe('sin elementos');
  });

  it('returns plain text for HTML-looking values; React remains responsible for escaping it', () => {
    expect(readableAuditSummary('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});
