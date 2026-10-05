import { z } from 'zod';

const nativeId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/u);

export const HarnessConsumptionEvidenceSchema = z.object({
  version: z.literal(1),
  harness_id: z.enum(['claude', 'codex', 'muse']),
  native_session_id: nativeId,
  native_turn_id: nativeId,
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  evidence_kind: z.literal('canonical_final_response'),
}).strict();

export type HarnessConsumptionEvidence = z.infer<typeof HarnessConsumptionEvidenceSchema>;
