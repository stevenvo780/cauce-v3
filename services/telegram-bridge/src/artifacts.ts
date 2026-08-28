import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

/**
 * Planning and preparation of egress attachments (`output.artifacts`).
 */

/** Symmetric to the ingest cap (`MAX_TELEGRAM_ATTACHMENT_BYTES`). */
export const MAX_EGRESS_ATTACHMENT_BYTES = 10_000_000;

/**
 * How many files are uploaded per response.
 *
 * Each upload is one more Telegram message, with its durable row and its rate-limit budget. An
 * agent returning twenty artifacts cannot turn a response into twenty notifications on someone's
 * phone.
 */
export const MAX_UPLOADS_PER_RELAY = 4;
const MAX_ARTIFACTS_CONSIDERED = 16;
const MAX_LISTED_LINES = 8;
/** Cap on the base64 string before decoding, to avoid materializing an absurd buffer. */
const MAX_DATA_URI_CHARACTERS = Math.ceil(MAX_EGRESS_ATTACHMENT_BYTES / 3) * 4 + 64;

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

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function artifactList(payload: Record<string, unknown>): readonly RawArtifact[] {
  const result = object(payload.result);
  const output = object(result?.output);
  const candidate = output?.artifacts ?? result?.artifacts ?? payload.artifacts;
  if (!Array.isArray(candidate)) return [];
  const artifacts: RawArtifact[] = [];
  for (const entry of candidate.slice(0, MAX_ARTIFACTS_CONSIDERED)) {
    const row = object(entry);
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

function hasUnsafeCodePoint(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x61c ||
      (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * File name suitable for the `filename` of a multipart.
 *
 * Quotes, line breaks and path separators are stripped: the value travels inside a
 * `Content-Disposition` header and must carry nothing that could close it.
 */
function safeFileName(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && basename(value) === value &&
    value !== '.' && value !== '..' &&
    !value.includes('/') && !value.includes('\\') && !value.includes('"') && !value.includes("'") &&
    !hasUnsafeCodePoint(value);
}

const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif'],
  ['application/pdf', '.pdf'], ['text/plain', '.txt'], ['text/markdown', '.md'],
  ['text/csv', '.csv'], ['text/html', '.html'], ['application/json', '.json'],
  ['application/zip', '.zip'], ['application/gzip', '.gz'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['video/mp4', '.mp4'], ['audio/mpeg', '.mp3'], ['audio/ogg', '.ogg']
]);

function uploadName(declared: string, mime: string): string {
  const trimmed = declared.trim();
  if (safeFileName(trimmed) && extname(trimmed).length > 1) return trimmed;
  const extension = EXTENSIONS.get(mime) ?? '.bin';
  if (safeFileName(trimmed) && trimmed.length > 0) return `${trimmed}${extension}`;
  return `adjunto${extension}`;
}

/* --------------------------------------------------------------------------- *
 * Bytes
 * --------------------------------------------------------------------------- */

/** Magic numbers Telegram knows how to render as an inline photo in the chat. */
function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
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
  // Buffer.from silently ignores non-base64 content: without this check, a corrupt attachment
  // would upload truncated and the human would open a broken file without knowing why.
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(raw) || raw.length % 4 !== 0) {
    return { error: 'el base64 del adjunto está mal formado' };
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 0) return { error: 'el adjunto quedó vacío al decodificar' };
  if (bytes.length > MAX_EGRESS_ATTACHMENT_BYTES) return { error: 'supera los 10 MB' };
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
      const sniffed = sniffImage(decoded.bytes);
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
