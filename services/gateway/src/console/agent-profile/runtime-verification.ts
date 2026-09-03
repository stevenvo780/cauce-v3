import type {
  ProfileRuntimeAck, ProfileRuntimeVerification,
} from '../agent-profile.routes.js';

export function appliedRuntimeVerification(
  verification: ProfileRuntimeVerification,
  acknowledgements: readonly ProfileRuntimeAck[],
  options: { readonly requireExactBytes: boolean },
): ProfileRuntimeVerification {
  const ackByName = new Map(acknowledgements.map((ack) => [ack.name, ack]));
  return {
    ...verification,
    state: 'current',
    observed_at: new Date().toISOString(),
    documents: verification.documents.map((document) => {
      const acknowledgement = ackByName.get(document.name);
      return {
        ...document,
        observed_sha: acknowledgement?.sha ?? null,
        observed_bytes: acknowledgement?.bytes ?? null,
        current: acknowledgement?.sha === document.expected_sha
          && (!options.requireExactBytes || acknowledgement.bytes === document.expected_bytes),
      };
    }),
  };
}
