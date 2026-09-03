import { isDeliverableArtifactUri, MAX_ARTIFACTS_CONSIDERED, objectRecord } from '@cauce/protocol';
import { artifactRefs, type ArtifactRef } from './agents/delegated-attachments.js';

/* Artifacts of an agent result: which count as an answer, and which bytes stay out of the durable
   copies nobody serves. Deliverability is not re-decided here -- `isDeliverableArtifactUri` is the
   one predicate, shared with the SDK and never stricter than the egress decoder -- so a `file:`,
   an `http:` (plaintext fetch on the agent's word, the shape an SSRF borrows) and an undecodable
   `data:` never close a delivery as `done`; the fan-in branch of `ackDelivery` asks it again for
   ACKs outside the SDK. Pruning keeps the identity and drops the bytes, leaving a result with
   nothing inline untouched; its descriptor comes from `artifactRefs`, the return hop's reader, so
   size and digest are computed once. A name that reader refuses costs the name alone -- never the
   size, the digest or the media type, and never by persisting the unsafe name: the pruned copy is
   the only durable record of a file the egress does hand over. */
const INLINE_SCHEME = 'data:';
const INLINE_OMITTED_URI = 'cauce:inline-omitted';
/** Stands in for a name `artifactRefs` refuses, so the rest of the descriptor survives it. */
const PLACEHOLDER_NAME = 'adjunto';
const DESCRIPTOR_FIELDS = ['media_type', 'sha256', 'declared_sha256', 'size'] as const;

function artifactEntries(result: Record<string, unknown> | undefined): readonly unknown[] {
  const entries = objectRecord(result?.output)?.artifacts;
  return Array.isArray(entries) ? entries as readonly unknown[] : [];
}

/* Judged over the same prefix the egress renders: deciding `done` over a longer list would close a
   delivery whose only file the renderer never reaches, and a `done` with nothing to render is a
   dead letter -- for the person, worse than the notice that no final reply arrived. Pruning still
   walks the WHOLE list: bytes past the prefix are stored by nobody's decision but the agent's. */
export function hasDeliverableArtifact(result: Record<string, unknown> | undefined): boolean {
  return artifactEntries(result).slice(0, MAX_ARTIFACTS_CONSIDERED).some((entry) => {
    const uri = objectRecord(entry)?.uri;
    return typeof uri === 'string' && isDeliverableArtifactUri(uri.trim());
  });
}

/** Trimmed here and read trimmed below: both halves of one file describe the same bytes. */
function inlineArtifactUri(entry: unknown): string | undefined {
  const uri = objectRecord(entry)?.uri;
  if (typeof uri !== 'string') return undefined;
  const trimmed = uri.trim();
  return trimmed.toLowerCase().startsWith(INLINE_SCHEME) ? trimmed : undefined;
}

function reference(
  entry: Record<string, unknown>, uri: string, name?: string
): ArtifactRef | undefined {
  return artifactRefs([{ ...entry, uri, ...(name === undefined ? {} : { name }) }])[0];
}

/* Nothing is normalized on the way in: `artifactRefs` reads the URI with the tree's one `data:`
   parser and falls back to the default media type, so every shape the egress uploads -- wrapped
   base64, a missing or unusable type, a parameter before `base64`, `BASE64` in caps -- keeps its
   type, size and digest here, on the only durable record of a file the person did receive. A
   descriptor stripped to `{uri}` alone is therefore unreachable for anything deliverable. */
function artifactDescriptor(entry: unknown, uri: string): Record<string, unknown> {
  const record = objectRecord(entry) ?? {};
  const named = reference(record, uri);
  if (named !== undefined) return { ...named, uri: INLINE_OMITTED_URI };
  const anonymous = reference(record, uri, PLACEHOLDER_NAME);
  const descriptor: Record<string, unknown> = { uri: INLINE_OMITTED_URI };
  for (const field of DESCRIPTOR_FIELDS) {
    const value = anonymous?.[field];
    if (value !== undefined) descriptor[field] = value;
  }
  return descriptor;
}

export function withoutInlineArtifactBytes(
  result: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const output = objectRecord(result?.output);
  const entries = artifactEntries(result);
  if (result === undefined || output === undefined || entries.length === 0) return result;
  let omitted = 0;
  const artifacts = entries.map((entry) => {
    const uri = inlineArtifactUri(entry);
    if (uri === undefined) return entry;
    omitted += 1;
    return artifactDescriptor(entry, uri);
  });
  if (omitted === 0) return result;
  return { ...result, output: { ...output, artifacts, inline_artifacts_omitted: omitted } };
}
