import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_PROOF_WINDOW, HOST_STEP_LIMIT_MS, MUSE_PROVIDER_PROOF_WINDOW,
  bootstrapProbeWindow, providerProofHostStepMs, providerProofWindow,
} from '../src/index.js';

describe('provider proof windows', () => {
  it('keeps every harness but Muse on the values it ran with', () => {
    expect(DEFAULT_PROVIDER_PROOF_WINDOW).toEqual({ turnMs: 100_000, claimMs: 50_000, deadlineMs: 120_000, hostStepMs: 150_000 });
    for (const harness of ['codex', 'claude', 'grok', 'openclaw', 'hermes', 'opencode', 'fake', null, undefined]) {
      expect(providerProofWindow(harness)).toBe(DEFAULT_PROVIDER_PROOF_WINDOW);
      expect(bootstrapProbeWindow(harness, 'verify')).toBe(DEFAULT_PROVIDER_PROOF_WINDOW);
      for (const step of ['authenticate', 'profile', 'verify', 'admission', 'stop']) {
        expect(providerProofHostStepMs(harness, step, 150_000)).toBe(150_000);
        expect(providerProofHostStepMs(harness, step, 25)).toBe(25);
      }
    }
  });

  it('gives a Muse verify turn 240 s, nested turn < claim < deadline and inside the host step limit', () => {
    const muse = providerProofWindow('muse');
    expect(muse).toBe(MUSE_PROVIDER_PROOF_WINDOW);
    expect(muse.turnMs).toBe(240_000);
    expect(muse.turnMs).toBeLessThan(muse.claimMs);
    expect(muse.claimMs).toBeLessThan(muse.deadlineMs);
    expect(muse.hostStepMs).toBeLessThanOrEqual(HOST_STEP_LIMIT_MS);
    expect(bootstrapProbeWindow('muse', 'verify')).toBe(MUSE_PROVIDER_PROOF_WINDOW);
    expect(bootstrapProbeWindow('muse', 'profile')).toBe(DEFAULT_PROVIDER_PROOF_WINDOW);
  });

  it('raises only the host steps that run a Muse provider proof hook, never above the limit', () => {
    for (const step of ['authenticate', 'profile', 'verify', 'admission']) {
      expect(providerProofHostStepMs('muse', step, 150_000)).toBe(300_000);
      expect(providerProofHostStepMs('muse', step, 25)).toBe(300_000);
      expect(providerProofHostStepMs('muse', step, HOST_STEP_LIMIT_MS)).toBe(HOST_STEP_LIMIT_MS);
    }
    for (const step of ['prepare', 'artifacts', 'credentials', 'runtime', 'stop', 'revoke', 'purge', 'fence', 'compensate', 'login-stop']) {
      expect(providerProofHostStepMs('muse', step, 150_000)).toBe(150_000);
    }
  });
});
