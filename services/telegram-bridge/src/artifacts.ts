import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import {
  base64CharacterBudget, decodeCanonicalBase64, extensionForMediaType, imageSignature,
  isSafeBasename, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE,
} from '@cauce/protocol';
import { objectRecord } from './validation.js';

/**
 * Planning and preparation of egress attachments (`output.artifacts`).
 */

/** `sendPhoto` refuses more, so the protocol cap is clamped to what the transport can carry. */
const TELEGRAM_PHOTO_CEILING = 10_000_000;
export const MAX_EGRESS_ATTACHMENT_BYTES = Math.min(MAX_ATTACHMENT_BYTES, TELEGRAM_PHOTO_CEILING);

/**
 * How many files are uploaded per response.
 *
 * Each upload is one more Telegram message, with its durable row and its rate-limit budget. An
 * agent returning twenty artifacts cannot turn a response into twenty notifications on someone's
 * phone.
 */
export const MAX_UPLOADS_PER_RELAY = MAX_ATTACHMENTS_PER_MESSAGE;
const MAX_ARTIFACTS_CONSIDERED = 16;
const MAX_LISTED_LINES = 8;
/** Cap on the base64 string before decoding, to avoid materializing an absurd buffer. */
const MAX_DATA_URI_CHARACTERS = base64CharacterBudget(MAX_EGRESS_ATTACHMENT_BYTES, 64);

export interface PlannedUpload {
  /** `photo` is rendered inline in the chat; `document` is downloaded. */
  readonly kind: 'photo' | 'document';
  readonly name: string;
  readonly mime_type: string;
  readonly bytes: Buffer;
  /** Stable identity of the content: it feeds the durable effect hash. */
  readonly sha256: string;
}

export interface ArtifactPlan {
  readonly uploads: readonly PlannedUpload[];
  /** Block to append at the end of the text. Empty string when there is nothing to say. */
  readonly footer: string;
  /** Artifacts that could only be named: a link, or a path that lives in the agent. */
  readonly listed: number;
  /** Artifacts that could not be uploaded nor listed (counter for the metric). */
  readonly discarded: number;
}

export const EMPTY_ARTIFACT_PLAN: ArtifactPlan = { uploads: [], footer: '', listed: 0, discarded: 0 };

interface RawArtifact {
  readonly name: string;
  readonly uri: string;
  readonly media_type?: string;
}

function artifactList(payload: Record<string, unknown>): readonly RawArtifact[] {
  const result = objectRecord(payload.result);
  const output = objectRecord(result?.output);
  const candidate = output?.artifacts ?? result?.artifacts ?? payload.artifacts;
  if (!Array.isArray(candidate)) return [];
  const artifacts: RawArtifact[] = [];
  for (const entry of candidate.slice(0, MAX_ARTIFACTS_CONSIDERED)) {
    const row = objectRecord(entry);
    if (row === undefined || typeof row.uri !== 'string') continue;
    artifacts.push({
      name: typeof row.name === 'string' ? row.name : '',
      uri: row.uri,
      ...(typeof row.media_type === 'string' ? { media_type: row.media_type } : {})
    });
  }
  return artifacts;
}

/* --------------------------------------------------------------------------- *
 * Names
 * --------------------------------------------------------------------------- */

/**
 * File name suitable for the `filename` of a multipart.
 *
 * Quotes, line breaks and path separators are stripped: the value travels inside a
 * `Content-Disposition` header and must carry nothing that could close it.
 */
function safeFileName(value: string): boolean {
  return isSafeBasename(value, { maxLength: 200 }) &&
    !value.includes('"') && !value.includes("'");
}

function uploadName(declared: string, mime: string): string {
  const trimmed = declared.trim();
  if (safeFileName(trimmed) && extname(trimmed).length > 1) return trimmed;
  const extension = extensionForMediaType(mime) ?? '.bin';
  if (safeFileName(trimmed) && trimmed.length > 0) return `${trimmed}${extension}`;
  return `adjunto${extension}`;
}

/* --------------------------------------------------------------------------- *
 * Bytes
 * --------------------------------------------------------------------------- */

/** Inline-renderable by `sendPhoto`; a GIF is excluded because Telegram freezes it as a photo. */
const INLINE_PHOTO_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

function inlinePhotoType(bytes: Buffer): string | undefined {
  const signature = imageSignature(bytes);
  return signature !== undefined && INLINE_PHOTO_TYPES.has(signature) ? signature : undefined;
}

interface DecodedData {
  readonly bytes?: Buffer;
  readonly mime?: string;
  /** Reason in Spanish, ready for a human to read. Present only if it failed. */
  readonly error?: string;
}

/**
 * `data:[<mime>][;charset=…][;base64],<data>`.
 *
 * Only the base64 variant is accepted: a percent-encoded `data:` is fine for tiny texts, and
 * accepting it would add one more decoder for a case nobody uses.
 */
function decodeDataUri(uri: string): DecodedData {
  const comma = uri.indexOf(',');
  if (comma === -1) return { error: 'el data: URI no tiene datos' };
  const header = uri.slice(5, comma).toLowerCase();
  if (!header.split(';').includes('base64')) return { error: 'el data: URI no viene en base64' };
  const rawMime = header.split(';')[0];
  const mime = rawMime && rawMime.length > 0 ? rawMime : 'application/octet-stream';
  const raw = uri.slice(comma + 1).replace(/\s+/gu, '');
  if (raw.length === 0) return { error: 'el data: URI vino vacío' };
  if (raw.length > MAX_DATA_URI_CHARACTERS) return { error: 'supera los 10 MB' };
  const bytes = decodeCanonicalBase64(raw, MAX_EGRESS_ATTACHMENT_BYTES);
  if (bytes === undefined) return { error: 'el base64 del adjunto está mal formado' };
  return { bytes, mime };
}

/* --------------------------------------------------------------------------- *
 * Listing
 * --------------------------------------------------------------------------- */

/**
 * The footer text later goes through `markdownToTelegramHtml`. Characters that converter
 * interprets as markup are stripped so a name containing `*` or `_` does not leave the message
 * half in italics.
 */
function plainInline(value: string, limit: number): string {
  const cleaned = value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/[*_`~[\]]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(cleaned).slice(0, limit).join('');
}

function safeLink(uri: string): string | undefined {
  if (uri.length > 512 || /[\s<>"']/u.test(uri)) return undefined;
  return /^https?:\/\/[^/]+/iu.test(uri) ? uri : undefined;
}

function label(artifact: RawArtifact, fallback: string): string {
  const name = plainInline(artifact.name, 80);
  return name.length > 0 ? name : fallback;
}

/**
 * Builds the plan for a response: what gets uploaded, what gets listed and what gets dropped.
 *
 * It never throws. Any unexpected shape ends up in `discarded` or in a footer line.
 */
export function planArtifacts(payload: Record<string, unknown>): ArtifactPlan {
  const artifacts = artifactList(payload);
  if (artifacts.length === 0) return EMPTY_ARTIFACT_PLAN;

  const uploads: PlannedUpload[] = [];
  const lines: string[] = [];
  let discarded = 0;

  for (const artifact of artifacts) {
    const uri = artifact.uri.trim();
    if (uri.length === 0) {
      discarded += 1;
      continue;
    }
    if (/^data:/iu.test(uri)) {
      if (uploads.length >= MAX_UPLOADS_PER_RELAY) {
        lines.push(`• ${label(artifact, 'adjunto')}: no lo mandé, ya iban ${String(MAX_UPLOADS_PER_RELAY)} archivos en esta respuesta`);
        continue;
      }
      const decoded = decodeDataUri(uri);
      if (decoded.bytes === undefined) {
        lines.push(`• ${label(artifact, 'adjunto')}: no pude adjuntarlo (${decoded.error ?? 'contenido inválido'})`);
        continue;
      }
      const sniffed = inlinePhotoType(decoded.bytes);
      const mime = sniffed ?? (decoded.mime ?? 'application/octet-stream');
      uploads.push({
        // The photo decision is made from the BYTES, not from what the agent declares: a lied
        // `image/png` makes Telegram reject the whole sendPhoto, and that rejection is avoidable.
        kind: sniffed === undefined ? 'document' : 'photo',
        name: uploadName(artifact.name, mime),
        mime_type: mime,
        bytes: decoded.bytes,
        sha256: createHash('sha256').update(decoded.bytes).digest('hex')
      });
      continue;
    }
    const link = safeLink(uri);
    if (link !== undefined) {
      lines.push(`• ${label(artifact, 'enlace')}: ${link}`);
      continue;
    }
    // Path inside the agent container that is not reachable locally.
    lines.push(`• ${label(artifact, 'archivo')}: quedó en el espacio de trabajo del agente y no viajó al chat`);
  }

  const shown = lines.slice(0, MAX_LISTED_LINES);
  if (lines.length > shown.length) shown.push(`• …y ${String(lines.length - shown.length)} más`);
  const footer = shown.length === 0 ? '' : `\n\n📎 Adjuntos\n${shown.join('\n')}`;
  return { uploads, footer, listed: lines.length, discarded };
}
