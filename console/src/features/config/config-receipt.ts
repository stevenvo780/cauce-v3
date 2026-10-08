import { ConfigMutationSchema, configurationReceiptMatches } from '@cauce/protocol/configuration';
import type { ConfigMutation, ConfigurationChangeResult } from '../../api/types';

function mutation(value: unknown): value is ConfigMutation {
  return ConfigMutationSchema.safeParse(value).success;
}

/** A 2xx is credited only when its receipt proves the requested mutation and rollback inverse. */
export function exactConfigurationReceipt(
  result: ConfigurationChangeResult,
  dryRun: boolean,
  expectedMutation?: ConfigMutation,
  expectedRolledBackRevisionId: number | null = null,
  expectedMutationSha256?: string,
): boolean {
  const minimumRevision = dryRun ? 0 : 1;
  return result.applied === !dryRun
    && result.dry_run === dryRun
    && Number.isSafeInteger(result.revision)
    && Number(result.revision) >= minimumRevision
    && result.rolled_back_revision_id === expectedRolledBackRevisionId
    && typeof result.summary === 'string'
    && result.summary.length >= 1
    && result.summary.length <= 2_000
    && mutation(result.mutation)
    && mutation(result.inverse_mutation)
    && configurationReceiptMatches(result.inverse_mutation, undefined, undefined)
    && configurationReceiptMatches(result.mutation, expectedMutation, result.mutation_sha256, expectedMutationSha256);
}
