import { HarnessConsumptionEvidenceSchema } from '@cauce/protocol';

export function withValidatedHarnessConsumption(
  result: Record<string, unknown> | undefined,
  harnessId: string | null,
  status: string,
): Record<string, unknown> | undefined {
  if (result === undefined || !Object.hasOwn(result, 'harness_consumption_v1')) return result;
  const parsed = HarnessConsumptionEvidenceSchema.safeParse(result.harness_consumption_v1);
  const normalized = { ...result };
  delete normalized.harness_consumption_v1;
  if (status === 'done' && parsed.success && parsed.data.harness_id === harnessId) {
    normalized.harness_consumption_v1 = parsed.data;
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}
