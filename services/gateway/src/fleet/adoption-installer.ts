import { z } from 'zod';
import { LegacyAdoptionError, LegacyAdoptionPreviewSchema, LegacyAdoptionTargetsSchema,
  type LegacyAdoptionActor } from '../../../../packages/store/src/fleet-adoption-contracts.js';
import type { LegacyFleetAdoptionService } from './adoption.js';

export const LegacyAdoptionInstallerCommandSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('preview'), targets: LegacyAdoptionTargetsSchema }).strict(),
  z.object({ mode: z.literal('apply'), preview: LegacyAdoptionPreviewSchema }).strict(),
]);
export async function runLegacyAdoptionInstaller(service: LegacyFleetAdoptionService, actor: LegacyAdoptionActor, input: unknown) {
  if (actor.subject !== 'system:legacy-fleet-installer') throw new LegacyAdoptionError('forbidden');
  const parsed = LegacyAdoptionInstallerCommandSchema.safeParse(input);
  if (!parsed.success) throw new LegacyAdoptionError('invalid_input');
  return parsed.data.mode === 'preview' ? service.preview(actor, parsed.data.targets) : service.apply(actor, parsed.data.preview);
}
