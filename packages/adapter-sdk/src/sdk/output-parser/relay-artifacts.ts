import {
  base64CharacterBudget,
  dataUriByteLength,
  isDeliverableArtifactUri,
  isSafeBasename,
  isValidMediaType,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MEDIA_TYPE_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_RELAY_ARTIFACTS_TOTAL,
  parseDataUri,
} from "@cauce/protocol";
import type { OutputArtifact, StructuredOutput } from "../types.js";

/**
 * Files on the delegation edge. Every cap is DERIVED from `@cauce/protocol`: a number written by
 * hand would be a second cap that falls behind and accepts what the bridge rejects. A malformed
 * attachment is DROPPED, never thrown, and its bytes stay OUTSIDE the `body` accounting.
 */

export const MAX_RELAY_ARTIFACTS_PER_MESSAGE = MAX_ATTACHMENTS_PER_MESSAGE;
export { MAX_RELAY_ARTIFACTS_TOTAL };
export const MAX_RELAY_ARTIFACT_TOTAL_BYTES = MAX_ATTACHMENTS_TOTAL_BYTES;
export const MAX_RELAY_ARTIFACT_URI_CHARACTERS = base64CharacterBudget(MAX_ATTACHMENT_BYTES, 128) + 256;

export const FILE_ONLY_REPLY = "Te dejo el/los fichero(s); no escribí texto adicional.";
export const FILE_ONLY_UNDELIVERED_REPLY =
  "Queria dejarte un fichero y no viajo: no entraba en el limite de tamano del turno o no se pudo "
  + "leer, y no escribi texto aparte. Pedimelo otra vez y te lo mando partido o te cuento que dice.";
export const NO_REPLY_WRITTEN_REPLY =
  "Cerre el turno sin escribir respuesta, asi que no tengo nada que contarte todavia. No es que no "
  + "haya nada que decir: es que no llegue a redactarlo. Volve a preguntarme.\n\n[Cauce] El turno "
  + "termino en \"done\" con 'reply' vacio y sin delegaciones, que es exactamente el sintoma de un "
  + "harness que corto antes de responder.";

/** Case is not part of a digest: both spellings are the same 64 hex, and the parsers lower them once so every later comparison is over one form. */
export const HEX_SHA256 = /^[0-9a-f]{64}$/iu;

export interface RelayArtifactBudget {
  count: number;
  bytes: number;
  readonly dropped: number[];
}

export function newRelayArtifactBudget(): RelayArtifactBudget {
  return { count: 0, bytes: 0, dropped: [] };
}

const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const FREE_HEADER_BYTES = MAX_ATTACHMENT_MEDIA_TYPE_LENGTH + 32;

/** An attachment that did NOT travel: it has a scheme, so it is never dereferenced as a path. */
export const NOT_SENT = "cauce:not-sent";

/** What the FRAME spends on an already-made `data:`, read with the protocol's parser so the budget and the egress agree on where `;base64` sits.
 *  The ¾ discount holds only over bytes that ARE payload: blanks and header padding are charged verbatim, and a CLAIM of base64 weighs its UTF-8 bytes. */
export function dataUriPayloadBytes(uri: string): number {
  const frame = Buffer.byteLength(uri, "utf8");
  const trimmed = uri.trim();
  const parsed = parseDataUri(trimmed);
  if (parsed === undefined) return frame;
  if (frame - Buffer.byteLength(parsed.payload, "utf8") > FREE_HEADER_BYTES) return frame;
  const canonical = parsed.payload.length % 4 === 0 && CANONICAL_BASE64.test(parsed.payload);
  if (parsed.base64 && !canonical) return Buffer.byteLength(parsed.payload, "utf8");
  return dataUriByteLength(trimmed);
}

function parseOne(entry: unknown): OutputArtifact | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const candidate = entry as Record<string, unknown>;
  if (!isSafeBasename(candidate.name)) return undefined;
  const uri = candidate.uri;
  if (typeof uri !== "string" || uri.trim().length === 0) return undefined;
  if (uri.length > MAX_RELAY_ARTIFACT_URI_CHARACTERS) return undefined;
  const mediaType = candidate.media_type;
  if (mediaType !== undefined && (typeof mediaType !== "string" || !isValidMediaType(mediaType))) {
    return undefined;
  }
  const sha256 = candidate.sha256;
  if (sha256 !== undefined && (typeof sha256 !== "string" || !HEX_SHA256.test(sha256))) {
    return undefined;
  }
  const digest = sha256?.toLowerCase();
  return {
    name: candidate.name,
    uri,
    ...(mediaType === undefined ? {} : { media_type: mediaType }),
    ...(digest === undefined ? {} : { sha256: digest }),
  };
}

export function parseRelayArtifacts(
  value: unknown,
  messageIndex: number,
  budget: RelayArtifactBudget,
): readonly OutputArtifact[] {
  if (value === undefined || value === null) return [];
  const drop = (): void => {
    if (!budget.dropped.includes(messageIndex)) budget.dropped.push(messageIndex);
  };
  if (!Array.isArray(value)) {
    drop();
    return [];
  }
  const artifacts: OutputArtifact[] = [];
  for (const entry of value) {
    const artifact = parseOne(entry);
    const bytes = artifact === undefined ? 0 : dataUriPayloadBytes(artifact.uri);
    if (artifact === undefined
      || artifacts.length >= MAX_RELAY_ARTIFACTS_PER_MESSAGE
      || budget.count >= MAX_RELAY_ARTIFACTS_TOTAL
      || budget.bytes + bytes > MAX_RELAY_ARTIFACT_TOTAL_BYTES) {
      drop();
      continue;
    }
    budget.count += 1;
    budget.bytes += bytes;
    artifacts.push(artifact);
  }
  return artifacts;
}

/**
 * Is there at least one file the recipient can actually OPEN? The answer is the protocol's, not a
 * scheme test: `data:x` and `https:not-a-url` carry a deliverable scheme and no file at all, and
 * a mute turn was buying itself a `done` with them.
 */
export function hasDeliverableArtifact(artifacts: readonly OutputArtifact[] | undefined): boolean {
  return artifacts?.some((artifact) => isDeliverableArtifactUri(artifact.uri.trim())) ?? false;
}

/**
 * Second half of the file-only decision, run once the inliner knows what actually travels. The
 * contract judges the artifacts BEFORE the budget is spent and before a local path becomes a real
 * `data:`, so BOTH directions are reconciled: a file demoted to `cauce:not-sent` must not close a
 * turn promising a file (a live delegation keeps the `done`), and one that DID materialize must not
 * travel under a text saying nothing was written -- unless the failure is RETRYABLE, whose retry
 * carries the file and keeps the second chance the harness earned.
 */
export function reviseFileOnlyOutcome(output: StructuredOutput): StructuredOutput {
  if (output.status === "failed" && !output.retryable && output.reply === NO_REPLY_WRITTEN_REPLY
    && output.messages.length === 0 && hasDeliverableArtifact(output.artifacts)) {
    return { ...output, status: "done", retryable: false, reply: FILE_ONLY_REPLY };
  }
  if (output.status !== "done" || output.reply !== FILE_ONLY_REPLY) return output;
  if (hasDeliverableArtifact(output.artifacts)) return output;
  if (output.messages.length > 0) return { ...output, reply: FILE_ONLY_UNDELIVERED_REPLY };
  return { ...output, status: "failed", retryable: false, reply: FILE_ONLY_UNDELIVERED_REPLY };
}
