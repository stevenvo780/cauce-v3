import { applyLegacyFleetAdoption, previewLegacyFleetAdoption,
  type DatabasePool, type LegacyAdoptionActor, type LegacyAdoptionProbe } from '@cauce/store';

export function createLegacyFleetAdoptionService(pool: DatabasePool, probe: LegacyAdoptionProbe) {
  return {
    preview: (actor: LegacyAdoptionActor, targets: unknown) => previewLegacyFleetAdoption(pool, actor, targets, probe),
    apply: (actor: LegacyAdoptionActor, preview: unknown) => applyLegacyFleetAdoption(pool, actor, preview, probe),
  };
}
export type LegacyFleetAdoptionService = ReturnType<typeof createLegacyFleetAdoptionService>;
