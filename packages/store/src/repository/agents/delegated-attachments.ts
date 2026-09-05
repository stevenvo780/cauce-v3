import { createHash } from 'node:crypto';
import {
  AttachmentsV1Schema, base64CharacterBudget, dataUriByteLength, decodeCanonicalBase64,
  isDeliverableArtifactUri, isSafeBasename, isValidMediaType, MAX_ARTIFACT_LOCATOR_CHARACTERS,
  MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MEDIA_TYPE_LENGTH, MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_TOTAL_BYTES, MAX_BLOB_BYTES, objectRecord, parseBlobArtifactUri, parseDataUri,
  redactAttachmentName, redactSecrets, redactSecretsDeep
} from '@cauce/protocol';

/* Files on the agent-to-agent delegation edge. `output.artifacts` arrives already inlined as `data:`
   URIs by the adapter SDK, where the O_NOFOLLOW / absolute-path / no-`..` rules live; nothing here
   reopens a path. The outbound hop carries inline bytes as `attachments_v1`; the return hop and the
   fan-in carry REFERENCES only, or a branch that answered with 10 MB would multiply itself up the
   chain and the fan-in budget would drop branches silently. An `https:` locator is deliverable too
   (`isDeliverableArtifactUri`, the predicate the SDK shares), so it travels as a reference WITH its
   uri instead of vanishing; only what no reader could use is DROPPED, counted BY CAUSE, and
   explained -- "exceeded the message quota" was false for four of the five causes and hid the one
   that matters, a rejected filename, which also gets its own audit field (a count, never the name).
   No capability column on `agents` is invented, and every cap comes from @cauce/protocol. */

const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const DATA_SCHEME = 'data:';
const DATA_PATTERN = /^data:/iu;
const BASE64_MARKER = ';base64,';

/* Two ceilings for an inline blob, because the quota and the transport measure different strings.
   The QUOTA is the STRIPPED payload -- what `parseDataUri` hands over, what the egress caps and
   what `isDeliverableArtifactUri` decodes -- with the same allowance the bridge spends on it. The
   RAW length only bounds the COPY that stripping takes: a line break is payload nobody counts, so
   a file wrapped at 76 columns (what `base64` emits by default) measures more characters than its
   bytes ever will, and one ceiling for both refused a 10 MB attachment the bridge had already
   uploaded -- leaving the person's file with a descriptor that had lost its digest and its size.
   Twice the payload covers a break after every character. A LOCATOR is another thing again and
   gets another ceiling -- what a link may measure -- because spending a payload budget on a URL
   let a 4 M-character `https:` string ride a return hop and a fan-in that had just truncated the
   text beside it to 4 KiB; its aggregate is the count cap times the locator cap, never the byte
   budget. MAX_TURN_ARTIFACT_CHARACTERS bounds what ONE ack declares, in the stored base64 form. */
const WRAPPED_LINE_ALLOWANCE = 2;
export const MAX_ARTIFACT_PAYLOAD_CHARACTERS = base64CharacterBudget(MAX_ATTACHMENT_BYTES, 64);
export const MAX_ARTIFACT_URI_CHARACTERS = DATA_SCHEME.length + MAX_ATTACHMENT_MEDIA_TYPE_LENGTH
  + BASE64_MARKER.length + WRAPPED_LINE_ALLOWANCE * MAX_ARTIFACT_PAYLOAD_CHARACTERS;
const MAX_LOCATOR_AGGREGATE_CHARACTERS =
  MAX_ATTACHMENTS_PER_MESSAGE * MAX_ARTIFACT_LOCATOR_CHARACTERS;
export const MAX_TURN_ARTIFACT_CHARACTERS = base64CharacterBudget(MAX_ATTACHMENTS_TOTAL_BYTES);

/* What an artifact too big for the turn becomes before it reaches this file: the name survives, the
   string does not, and the recipient is still told a file did not travel. Dropping it silently at
   the contract boundary would trade one honest note for an invisible loss. */
export const NOT_SENT_URI = 'cauce:not-sent';

export interface DelegatedAttachment {
  readonly kind: 'image' | 'document';
  readonly name: string;
  readonly mime_type: string;
  readonly file_size: number;
  readonly sha256: string;
  readonly content_base64: string;
}

/* `sha256` is present ONLY when this store hashed the bytes itself; otherwise the agent's claim
   travels as `declared_sha256`, so a coordinator never reads a verified-looking digest nobody
   checked. A ref rebuilt from an earlier ref therefore loses the label: with the bytes gone, a
   digest the store computed is indistinguishable from one an agent wrote next to a name. */
export interface ArtifactRef {
  readonly name: string;
  readonly uri?: string;
  readonly media_type?: string;
  readonly sha256?: string;
  readonly declared_sha256?: string;
  readonly size?: number;
}

export type ArtifactDropCause =
  | 'count' | 'bytes' | 'broadcast' | 'undecodable' | 'scheme' | 'name';

export interface DelegatedArtifacts {
  readonly attachments: readonly DelegatedAttachment[];
  readonly refs: readonly ArtifactRef[];
  readonly dropped: number;
  /** Artifacts refused for their name alone: the only drop cause worth its own audit field. */
  readonly rejectedNames: number;
  readonly note?: string;
}

const DROP_REASONS: Readonly<Record<ArtifactDropCause, string>> = {
  count: 'superan el máximo de adjuntos por mensaje',
  bytes: 'exceden el cupo del mensaje',
  broadcast: 'no caben en la difusión a toda la flota',
  undecodable: 'no se pudieron descodificar',
  scheme: 'no llegan por un origen entregable',
  name: 'llevan un nombre no admitido'
};

const DROP_ORDER: readonly ArtifactDropCause[] = [
  'count', 'bytes', 'broadcast', 'undecodable', 'scheme', 'name'
];

interface InlinePayload {
  readonly mediaType: string;
  readonly base64: string;
}

/** What an unusable type slot becomes, matching the parser's own default for a missing one. */
const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

/* One trim and one case-insensitive scheme for BOTH halves of this file: the pruning pass upstream
   recognizes ` DATA:` after trimming and lowercasing, so reading the raw string here would file the
   same artifact under the other shape -- and an inline blob would travel as if it were a link. */
function normalizedUri(uri: unknown): string | undefined {
  return typeof uri === 'string' ? uri.trim() : undefined;
}

/* The tree's ONE `data:` reader, so this edge accepts exactly what the egress uploads. Looking for
   a literal `;base64,` instead demanded the flag LAST and no parameters at all, which dropped five
   shapes the bridge delivers -- wrapped base64, a missing type, a parameter before the flag, the
   flag in caps, the flag in the middle -- and told the delegated agent they could not be decoded.
   The SIZE axis was the same trap read on the other string: the quota is charged to
   `parsed.payload`, the stripped text the egress caps, so 76-column wrapping no longer turns a
   legal 10 MB file into a name without bytes; the raw guard above only keeps the copy bounded.
   A type slot the protocol refuses (`foo`, one padded with spaces, one with parentheses) becomes
   the default rather than costing the file: unusable is the SLOT, never the bytes. This is the one
   place both readers below take a type from, so neither can disagree with the other. */
function inlinePayload(uri: unknown): InlinePayload | undefined {
  const value = normalizedUri(uri);
  if (value === undefined || value.length > MAX_ARTIFACT_URI_CHARACTERS) return undefined;
  const parsed = parseDataUri(value);
  if (parsed?.base64 !== true || parsed.payload.length > MAX_ARTIFACT_PAYLOAD_CHARACTERS) {
    return undefined;
  }
  return {
    mediaType: isValidMediaType(parsed.mediaType) ? parsed.mediaType : DEFAULT_MEDIA_TYPE,
    base64: parsed.payload
  };
}

/** A locator the recipient could still fetch: deliverable, not the inline shape decoded here. */
function referenceUri(uri: unknown): string | undefined {
  const value = normalizedUri(uri);
  if (value === undefined || value.length > MAX_ARTIFACT_LOCATOR_CHARACTERS) return undefined;
  return !DATA_PATTERN.test(value) && isDeliverableArtifactUri(value) ? value : undefined;
}

/* The byte quota is blamed for what the quota measures: `dataUriByteLength` weighs the stripped
   payload in place, without the copy, so a file split into lines is never told it exceeded a
   budget it fits in -- the note is the only thing the delegated agent gets to read. */
function artifactDropCause(uri: unknown): ArtifactDropCause {
  const value = normalizedUri(uri);
  if (value === undefined) return 'scheme';
  if (value === NOT_SENT_URI) return 'bytes';
  if (DATA_PATTERN.test(value)) {
    return dataUriByteLength(value) > MAX_ATTACHMENT_BYTES ? 'bytes' : 'undecodable';
  }
  return value.length > MAX_ARTIFACT_LOCATOR_CHARACTERS ? 'bytes' : 'scheme';
}

/* A name is scanned like any other text, and BEFORE the batch is validated: redaction can grow a
   string past the protocol cap and the recipient's adapter refuses such a body whole. A name that
   does not survive its own redaction is dropped like an unsafe one. */
function redactedBasename(value: unknown): string | undefined {
  if (!isSafeBasename(value)) return undefined;
  const redacted = redactAttachmentName(value, { enabled: true });
  return isSafeBasename(redacted) ? redacted : undefined;
}

function declaredMediaType(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_ATTACHMENT_MEDIA_TYPE_LENGTH
    && isValidMediaType(value)
    ? value.toLowerCase()
    : undefined;
}

function declaredDigest(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_SHA256.test(value) ? value : undefined;
}

/* A blob reference may weigh far more than an inline attachment: its ceiling is the blob one. */
function declaredSize(value: unknown, ceiling = MAX_ATTACHMENT_BYTES): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value > 0 && value <= ceiling
    ? value
    : undefined;
}

function sizeCeiling(uri: string | undefined): number {
  return uri !== undefined && parseBlobArtifactUri(uri) !== undefined ? MAX_BLOB_BYTES : MAX_ATTACHMENT_BYTES;
}

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function droppedNote(drops: ReadonlyMap<ArtifactDropCause, number>): string | undefined {
  const parts = DROP_ORDER
    .map((cause) => ({ cause, count: drops.get(cause) ?? 0 }))
    .filter((part) => part.count > 0);
  const [first] = parts;
  if (first === undefined) return undefined;
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  const detail = parts.length === 1
    ? DROP_REASONS[first.cause]
    : parts.map((part) => `${String(part.count)} ${DROP_REASONS[part.cause]}`).join('; ');
  return `${String(total)} adjunto(s) no viajaron: ${detail}`;
}

/* `withheld` are artifacts a caller already decided cannot travel -- today, the ones an `@all` would
   multiply past the expansion budget. They arrive as a count so the recipient gets the same note as
   any other cause, instead of the broadcast dying whole over one attachment. */
export function attachmentsFromArtifacts(
  artifacts: unknown, withheld = 0
): DelegatedArtifacts {
  const drops = new Map<ArtifactDropCause, number>();
  const drop = (cause: ArtifactDropCause): void => {
    drops.set(cause, (drops.get(cause) ?? 0) + 1);
  };
  if (withheld > 0) drops.set('broadcast', withheld);
  const attachments: DelegatedAttachment[] = [];
  const refs: ArtifactRef[] = [];
  let aggregate = 0;
  let locators = 0;
  for (const value of Array.isArray(artifacts) ? artifacts : []) {
    const entry = objectRecord(value);
    if (entry === undefined) {
      drop('undecodable');
      continue;
    }
    const name = redactedBasename(entry.name);
    if (name === undefined) {
      drop('name');
      continue;
    }
    if (attachments.length + refs.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      drop('count');
      continue;
    }
    const inline = inlinePayload(entry.uri);
    if (inline === undefined) {
      const uri = referenceUri(entry.uri);
      if (uri === undefined) {
        drop(artifactDropCause(entry.uri));
      } else if (locators + uri.length > MAX_LOCATOR_AGGREGATE_CHARACTERS) {
        drop('bytes');
      } else {
        locators += uri.length;
        const mediaType = declaredMediaType(entry.media_type);
        const declared = declaredDigest(entry.sha256) ?? declaredDigest(entry.declared_sha256)
          ?? parseBlobArtifactUri(uri);
        const size = declaredSize(entry.size, sizeCeiling(uri));
        refs.push({
          name,
          uri,
          ...(mediaType === undefined ? {} : { media_type: mediaType }),
          ...(declared === undefined ? {} : { declared_sha256: declared }),
          ...(size === undefined ? {} : { size })
        });
      }
      continue;
    }
    const bytes = decodeCanonicalBase64(inline.base64, MAX_ATTACHMENT_BYTES);
    if (bytes === undefined || bytes.length === 0) {
      drop('undecodable');
      continue;
    }
    if (aggregate + bytes.length > MAX_ATTACHMENTS_TOTAL_BYTES) {
      drop('bytes');
      continue;
    }
    aggregate += bytes.length;
    attachments.push({
      // The implication AttachmentContentSchema enforces: `image` needs an `image/*` type.
      kind: inline.mediaType.startsWith('image/') ? 'image' : 'document',
      name,
      mime_type: inline.mediaType,
      file_size: bytes.length,
      // The identity of what travels is the digest of what travels: a false sha256 is overwritten.
      sha256: digestOf(bytes),
      content_base64: inline.base64
    });
  }
  // A batch built wrong degrades to text: the adapter would reject the whole body otherwise.
  const admitted = attachments.length === 0 || AttachmentsV1Schema.safeParse(attachments).success;
  if (!admitted) drops.set('undecodable', (drops.get('undecodable') ?? 0) + attachments.length);
  const carried = admitted ? attachments : [];
  const note = droppedNote(drops);
  return {
    attachments: carried,
    refs,
    dropped: [...drops.values()].reduce((total, count) => total + count, 0),
    rejectedNames: drops.get('name') ?? 0,
    ...(note === undefined ? {} : { note })
  };
}

/* References for a return hop. Tolerates every shape an artifact can have by then: a full `data:`
   URI, an `https:` locator, and the stripped reference left after `deliveries.result` was pruned.
   With the bytes present the digest is RECOMPUTED; without them the declared one is labelled. */
export function artifactRefs(artifacts: unknown): ArtifactRef[] {
  if (!Array.isArray(artifacts)) return [];
  const refs: ArtifactRef[] = [];
  let locators = 0;
  for (const value of artifacts) {
    if (refs.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
    const entry = objectRecord(value);
    const name = redactedBasename(entry?.name);
    if (entry === undefined || name === undefined) continue;
    const inline = inlinePayload(entry.uri);
    const bytes = inline === undefined
      ? undefined
      : decodeCanonicalBase64(inline.base64, MAX_ATTACHMENT_BYTES);
    const mediaType = declaredMediaType(entry.media_type) ?? inline?.mediaType;
    const uri = referenceUri(entry.uri);
    const declared = declaredDigest(entry.sha256) ?? declaredDigest(entry.declared_sha256)
      ?? (uri === undefined ? undefined : parseBlobArtifactUri(uri));
    if (uri !== undefined && locators + uri.length > MAX_LOCATOR_AGGREGATE_CHARACTERS) continue;
    locators += uri?.length ?? 0;
    /* Only a measurement is called a size: an inline payload nobody could decode declares none,
       and its entry's own claim is not promoted, because on the durable record of a file an
       arithmetic guess over `@@@@` or `QUJD====` reads exactly like a weigh-in. */
    const size = bytes?.length ?? (inline === undefined ? declaredSize(entry.size, sizeCeiling(uri)) : undefined);
    refs.push({
      name,
      ...(uri === undefined ? {} : { uri }),
      ...(mediaType === undefined ? {} : { media_type: mediaType }),
      ...(bytes === undefined
        ? (declared === undefined ? {} : { declared_sha256: declared })
        : { sha256: digestOf(bytes) }),
      ...(size === undefined ? {} : { size })
    });
  }
  return refs;
}

export interface DeclaredArtifacts {
  readonly bytes: number;
  /** Artifacts that WOULD have travelled: what a withheld count may honestly claim. */
  readonly deliverable: number;
}

/* What one delegated message would carry. A `@all` repeats the artifacts once per online alias, so
   uncounted they leave the expanded-size cap bounding the text and nothing else. The count is of the
   STORED form -- `base64.length`, not the decoded size, which admitted 4/3 of the declared budget --
   it stops at the per-message count cap, since nothing past it can travel, and it never decodes nor
   hashes: it runs BEFORE the broadcast is authorized. */
export function declaredArtifactBudget(artifacts: unknown): DeclaredArtifacts {
  if (!Array.isArray(artifacts)) return { bytes: 0, deliverable: 0 };
  let bytes = 0;
  let deliverable = 0;
  for (const value of artifacts) {
    const entry = objectRecord(value);
    if (entry === undefined || redactedBasename(entry.name) === undefined) continue;
    const inline = inlinePayload(entry.uri);
    const size = inline === undefined ? referenceUri(entry.uri)?.length ?? 0 : inline.base64.length;
    if (size === 0) continue;
    bytes += size;
    deliverable += 1;
    if (deliverable === MAX_ATTACHMENTS_PER_MESSAGE) break;
  }
  return { bytes, deliverable };
}

/* The text a delegation STORES is the redacted one, so everything derived from it -- the `body_hash`
   answering "was this the same delegation?", the `@human` question written to a durable gate row,
   the `chain_gated` notice a sibling reads -- is derived from that same string. Hashing the
   pre-redaction text digested a body that was never written. */
export function redactedOutputText(value: unknown): unknown {
  return typeof value === 'string' ? redactSecrets(value, { enabled: true }).value : value;
}

/* The delegated child body. Redaction runs HERE because this body is a publish path the gateway
   choke point never sees: an agent's own output lands in `messages.body` straight from SQL, and an
   agent output is never a legitimate secret carrier -- a secret travels on the sealed plane.
   `content_base64` is skipped by the redactor, so a file costs nothing; and a sanitizer that cannot
   name its own blind spot is not one, so an unscanned remainder is logged, never passed over. */
export function delegatedMessageBody(
  base: Record<string, unknown>, carried: DelegatedArtifacts
): Record<string, unknown> {
  const scanned = redactSecretsDeep<Record<string, unknown>>({
    ...base,
    ...(carried.attachments.length > 0 ? { attachments_v1: carried.attachments } : {}),
    ...(carried.refs.length > 0 ? { artifacts_v1: carried.refs } : {}),
    ...(carried.note === undefined ? {} : { attachments_note: carried.note })
  }, { enabled: true });
  if (scanned.unscanned !== undefined) {
    console.error(JSON.stringify({
      event: 'delegated_body_unscanned',
      reason: scanned.unscanned.reason,
      count: scanned.unscanned.count,
      reasons: scanned.unscanned.reasons
    }));
  }
  return scanned.value;
}

/* `body_hash` answers "was this the same delegation?". Two identical texts carrying different files
   are not, so the digests of what travelled fold in. With no file the hash is unchanged. */
export function carriedBodyHash(bodyHash: string, carried: DelegatedArtifacts): string {
  const digests = [
    ...carried.attachments.map(
      (attachment) => `${attachment.sha256}:${String(attachment.file_size)}`
    ),
    ...carried.refs.map((ref) => `${ref.uri ?? ''}:${ref.declared_sha256 ?? ''}`)
  ];
  if (digests.length === 0) return bodyHash;
  return createHash('sha256').update([bodyHash, ...digests].join('\n')).digest('hex');
}
