import { createHash } from "node:crypto";
import type { HarnessConsumptionWitness, HarnessId } from "../sdk/types.js";

export function inputDigest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function consumptionWitness(
  harness: HarnessId,
  sessionId: string | undefined,
  turnId: string,
  input: string,
): HarnessConsumptionWitness | undefined {
  if (!["claude", "codex", "muse"].includes(harness) || sessionId === undefined
    || !validIdentifier(sessionId) || !validIdentifier(turnId)) return undefined;
  return { version: 1, harness_id: harness as HarnessConsumptionWitness["harness_id"],
    native_session_id: sessionId, native_turn_id: turnId, input_sha256: inputDigest(input),
    evidence_kind: "canonical_final_response" };
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/u.test(value);
}

export function matchingConsumptionWitness(
  witness: unknown,
  harness: HarnessId,
  input: string,
  nativeSessionId: string | undefined,
  expectedSessionId?: string,
): HarnessConsumptionWitness | undefined {
  if (typeof witness !== "object" || witness === null || Array.isArray(witness)) return undefined;
  const candidate = witness as Partial<HarnessConsumptionWitness>;
  if (candidate.version !== 1 || candidate.harness_id !== harness
    || candidate.evidence_kind !== "canonical_final_response"
    || !validIdentifier(candidate.native_session_id) || !validIdentifier(candidate.native_turn_id)
    || candidate.input_sha256 !== inputDigest(input)
    || nativeSessionId !== candidate.native_session_id
    || (expectedSessionId !== undefined && expectedSessionId !== candidate.native_session_id)) return undefined;
  return consumptionWitness(harness, candidate.native_session_id, candidate.native_turn_id, input);
}
