import { describe, expect, it } from 'vitest';
import { safeAuditSummary } from '../src/audit-summary.js';

describe('safeAuditSummary', () => {
  it('keeps bounded operational facts and converts identity arrays to counts', () => {
    expect(JSON.parse(safeAuditSummary('message.publish', {
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }, { tenant_id: 'Miguel', alias: 'kratos' }],
      ack: 'started', epoch: 29, lease_renewed: true,
    }) ?? 'null')).toEqual({ ack: 'started', epoch: 29, lease_renewed: true, recipient_count: 2 });
  });

  it('never projects session, credential locator, mutation, body or arbitrary unknown fields', () => {
    const summary = safeAuditSummary('config.change', {
      summary: 'create provider account codex-steven',
      authenticated_session_id: 'private-session',
      operator_id: 'private-subject',
      credential_ref: 'vault:private/path',
      mutation: { value: { credential_ref: 'vault:private/path' } },
      body: { text: 'private message' },
      future_secret: 'must-not-leak',
    });
    expect(summary).toBe('{"summary":"create provider account codex-steven"}');
    expect(summary).not.toMatch(/session|subject|vault|message|secret/u);
  });

  it('does not trust a free-text summary on actions whose producer did not declare it safe', () => {
    expect(safeAuditSummary('message.publish', { summary: 'private text', recipients: [] }))
      .toBe('{"recipient_count":0}');
  });

  it('rejects free-form values even under otherwise safe scalar keys', () => {
    expect(safeAuditSummary('delivery.cancel', {
      state: '<img src=x onerror=alert(1)>',
      target_alias: 'alias with spaces',
      attempt: 2,
    })).toBe('{"attempt":2}');
  });

  it('bounds generated config prose and strips control characters', () => {
    const parsed = JSON.parse(safeAuditSummary('config.change', {
      summary: `alta\n${'x'.repeat(500)}`,
    }) ?? 'null') as { summary: string };
    expect(parsed.summary).toMatch(/^alta x+…$/u);
    expect(parsed.summary.length).toBeLessThanOrEqual(180);
  });

  it('quita los controles que el colapso de espacios NO cubre: ESC, BEL y NUL', () => {
    const parsed = JSON.parse(safeAuditSummary('config.change', {
      summary: 'alta\u001b[31mrojo\u0007fin\u0000',
    }) ?? 'null') as { summary: string };
    const controles = Array.from(parsed.summary)
      .filter((character) => (character.codePointAt(0) ?? 0) <= 31
        || character.codePointAt(0) === 127);
    expect(controles).toEqual([]);
    expect(parsed.summary).toContain('rojo');
  });

  it('corta en 10 campos aunque el origen traiga mas escalares permitidos', () => {
    const parsed = JSON.parse(safeAuditSummary('x', {
      ack: 'ok', state: 'a', status: 'b', outcome: 'c', phase: 'd', epoch: 1,
      attempt: 2, mode: 'e', kind: 'f', source: 'g', adapter: 'h', schema: 'i',
    }) ?? 'null') as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(10);
  });

  it('returns null for absent, scalar, array or wholly private metadata', () => {
    expect(safeAuditSummary('x', null)).toBeNull();
    expect(safeAuditSummary('x', ['ack'])).toBeNull();
    expect(safeAuditSummary('x', { ticket: 'opaque' })).toBeNull();
  });
});
