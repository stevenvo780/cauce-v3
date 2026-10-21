import { describe, expect, it } from 'vitest';
import { probeFailureMessage } from './provider-probe-messages';
import type { ProviderAuthProbeReason, ProviderAuthReason } from '../../api/client/provider-auth-client';

const reasons: ProviderAuthProbeReason[] = ['PROBE_TIMEOUT', 'PROBE_EXIT', 'PROBE_BAD_JSON', 'PROBE_NONCE_MISMATCH', 'PROBE_OUTPUT_LIMIT',
  'PROBE_UNAVAILABLE', 'PROBE_IDENTITY_MISMATCH', 'PROBE_IDENTITY_UNAVAILABLE', 'PROBE_PROFILE_UNUSABLE', 'PROBE_VERSION_MISMATCH',
  'PROBE_CONFIG_SCOPE', 'PROBE_CONTAINER_EXEC_FAILED'];

describe('identity probe messages', () => {
  it('gives every probe reason its own Spanish sentence', () => {
    const messages = reasons.map(probeFailureMessage);
    for (const message of messages) expect(message).toMatch(/^[A-ZÁÉÍÓÚ].+\.$/u);
    expect(new Set(messages).size).toBe(reasons.length);
    expect(probeFailureMessage('PROBE_TIMEOUT')).toContain('tardó más de lo permitido');
    expect(probeFailureMessage('PROBE_IDENTITY_MISMATCH')).toContain('La cuenta conectada no es la esperada');
  });
  it('leaves drift, missing and unknown reasons to the caller', () => {
    expect(probeFailureMessage(undefined)).toBeUndefined();
    expect(probeFailureMessage('CONTAINER_ISOLATION_DRIFT')).toBeUndefined();
    expect(probeFailureMessage('toString' as ProviderAuthReason)).toBeUndefined();
  });
});
