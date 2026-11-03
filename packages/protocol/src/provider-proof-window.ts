/**
 * Windows of a provider proof that runs a real harness turn: the bootstrap probe of the verify step (bootstrap and normal
 * phase) and the host step whose hook runs the identity probe (authenticate) or the verify poll. Every harness keeps the
 * default window. Muse Wonder Full (muse-wonder-full-1.0) answered the one-step nonce turn in 5-46 s at high effort, 34 s
 * at max and once over 60 s (measured 2026-11-03): a 50 s claim and a 90 s round trip rejected valid logins, so a Muse
 * proof gets 240 s.
 *
 * Nested end to end: the adapter's harness turn < the bootstrap claim (its ack must land inside it) < the probe deadline,
 * and the executor's hook < the host step. ops/cli/fleet_provider_muse.py PROOF_TIMEOUTS mirrors the Muse values
 * (round trip 240 s, verify poll 250 s < container exec 270 s < executor hook 280 s < host step 300 s).
 */
export interface ProviderProofWindow {
  /** Upper bound of the adapter's verify harness turn. */
  readonly turnMs: number;
  /** How long a claimed bootstrap probe still accepts its acknowledgment. */
  readonly claimMs: number;
  /** Lifetime of a bootstrap probe from its creation. */
  readonly deadlineMs: number;
  /** Host step budget a step that runs a provider proof hook gets at least. */
  readonly hostStepMs: number;
}

export const DEFAULT_PROVIDER_PROOF_WINDOW: ProviderProofWindow = Object.freeze({
  turnMs: 100_000, claimMs: 50_000, deadlineMs: 120_000, hostStepMs: 150_000,
});
export const MUSE_PROVIDER_PROOF_WINDOW: ProviderProofWindow = Object.freeze({
  turnMs: 240_000, claimMs: 255_000, deadlineMs: 260_000, hostStepMs: 300_000,
});
/** The gateway refuses a host command budget above this. */
export const HOST_STEP_LIMIT_MS = 300_000;
/** Fleet steps whose host command runs a provider proof hook: profile may re-authenticate, admission runs the normal verify. */
export const PROVIDER_PROOF_STEPS: ReadonlySet<string> = new Set(['authenticate', 'profile', 'verify', 'admission']);

export function providerProofWindow(harnessId: string | null | undefined): ProviderProofWindow {
  return harnessId === 'muse' ? MUSE_PROVIDER_PROOF_WINDOW : DEFAULT_PROVIDER_PROOF_WINDOW;
}

/** The window of one bootstrap probe: only a verify probe runs the harness turn; a profile probe keeps the default. */
export function bootstrapProbeWindow(harnessId: string | null | undefined, action: string): ProviderProofWindow {
  return action === 'verify' ? providerProofWindow(harnessId) : DEFAULT_PROVIDER_PROOF_WINDOW;
}

/** The host command budget of one fleet step. Only a widened harness raises it, and never below what is configured. */
export function providerProofHostStepMs(harnessId: string | null | undefined, step: string, configuredMs: number): number {
  const window = providerProofWindow(harnessId);
  if (!PROVIDER_PROOF_STEPS.has(step) || window.hostStepMs <= DEFAULT_PROVIDER_PROOF_WINDOW.hostStepMs) return configuredMs;
  return Math.min(HOST_STEP_LIMIT_MS, Math.max(configuredMs, window.hostStepMs));
}
