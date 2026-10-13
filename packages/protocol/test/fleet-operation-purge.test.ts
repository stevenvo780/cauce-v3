import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';

const legacy = { kind: 'purge', target: { resource: 'agent', tenant_id: 'A', alias: 'worker' },
  parameters: {}, expected_revision: 0, idempotency_key: 'purge-worker' };
const submission = (parameters: unknown) => protocol.FleetOperationSubmissionSchema.safeParse({ ...legacy, parameters }).success;

describe('agent purge confirmation contract', () => {
  it('requires the exact alias for new submissions without trimming or case folding', () => {
    expect(submission({ confirm_alias: 'worker' })).toBe(true);
    for (const parameters of [{}, { confirm_alias: null }, { confirm_alias: 1 }, { confirm_alias: '' },
      { confirm_alias: 'Worker' }, { confirm_alias: 'other' }, { confirm_alias: ' worker' }, { confirm_alias: 'worker ' }]) {
      expect(submission(parameters)).toBe(false);
    }
  });
  it('preserves the original request and hash when decoding legacy execution data', () => {
    const decoded = protocol.FleetOperationRequestSchema.parse(legacy);
    expect(decoded).toEqual(legacy);
    expect(protocol.sha256Hex(decoded)).toBe(protocol.sha256Hex(legacy));
    expect(submission({})).toBe(false);
  });
  it('keeps confirmation in the canonical request hash', () => {
    const confirmed = { ...legacy, parameters: { confirm_alias: 'worker' } };
    const decoded = protocol.FleetOperationRequestSchema.parse(confirmed);
    expect(decoded).toEqual(confirmed);
    expect(protocol.sha256Hex(decoded)).not.toBe(protocol.sha256Hex(legacy));
    expect(protocol.sha256Hex(decoded)).not.toBe(protocol.sha256Hex({ ...confirmed, parameters: { confirm_alias: 'other' } }));
  });
  it('does not require an agent alias for room or tenant purges', () => {
    for (const target of [{ resource: 'room', tenant_id: 'A', room_id: 'r' }, { resource: 'tenant', tenant_id: 'A' }]) {
      expect(protocol.FleetOperationSubmissionSchema.safeParse({ ...legacy, target }).success).toBe(true);
    }
  });
});
