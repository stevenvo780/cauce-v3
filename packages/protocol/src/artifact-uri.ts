import {
  decodeCanonicalBase64, MAX_ARTIFACT_LOCATOR_CHARACTERS, MAX_ATTACHMENT_BYTES
} from './attachment-limits.js';
import { hasUnsafeTextCodePoint } from './content-safety.js';

/* Which artifact URI the delegation edge can actually hand over. Only two shapes qualify: an
   inline `data:` blob it can decode itself, and an `https:` URL. `file:` would read the sender's
   disk through the recipient, plain `http:` would carry the bytes in clear, and everything else
   is a scheme nobody on this edge knows how to fetch.

   The predicate judges SHAPE, never destination: an `https:` host may be private, link-local or a
   metadata service, and whoever wires a fetch owns that decision. And it must never be stricter
   than the egress decoder (`decodeDataUri` of the telegram bridge), or the store vetoes a file the
   bridge does deliver: scheme is case-insensitive, the media type is optional, whitespace inside
   the base64 is stripped before the canonical check, and only an empty payload is rejected. */

const DATA_PATTERN = /^data:/iu;
const HTTPS_PATTERN = /^https:\/\//iu;
const BASE64_PARAMETER = 'base64';
const DEFAULT_MEDIA_TYPE = 'application/octet-stream';
const PERCENT_ESCAPE = /%[0-9a-f]{2}/giu;
const WHITESPACE = /\s+/gu;
const SINGLE_WHITESPACE = /\s/u;
const MAX_BASE64_PADDING = 2;

export interface ParsedDataUri {
  /** Lowercased; `application/octet-stream` when the header omits it, as the egress defaults. */
  readonly mediaType: string;
  readonly base64: boolean;
  /** Every `;`-separated field of the lowercased header, the media type slot included. */
  readonly params: readonly string[];
  /** Whitespace-stripped when base64; verbatim otherwise, where a space is a byte of payload. */
  readonly payload: string;
  /** The bytes a recipient gets. Never throws: a malformed payload decodes to what it can. */
  bytes: () => Buffer;
}

interface DataUriHeader {
  readonly comma: number;
  readonly params: readonly string[];
  readonly base64: boolean;
}

function readHeader(uri: string): DataUriHeader | undefined {
  if (!DATA_PATTERN.test(uri)) return undefined;
  const comma = uri.indexOf(',');
  if (comma === -1) return undefined;
  const params = uri.slice('data:'.length, comma).toLowerCase().split(';');
  return { comma, params, base64: params.includes(BASE64_PARAMETER) };
}

/* ONE `data:` parser for the whole tree. Four used to exist -- the secret guard, the relay byte
   budget, the telegram egress and the store's delegation reader -- and three demanded `;base64` as
   the LAST parameter while the egress accepted it anywhere. `data:text/plain;base64;charset=utf-8,
   <b64>` was therefore weighed and hashed as text by the guard and uploaded as a file by the
   bridge, which is how a sealed secret reached a human's chat; and the store, reading by the same
   rule, dropped files the bridge had already delivered. The egress rule wins: ANY parameter. */
export function parseDataUri(uri: string): ParsedDataUri | undefined {
  const header = readHeader(uri);
  if (header === undefined) return undefined;
  const { comma, params, base64 } = header;
  const raw = uri.slice(comma + 1);
  const payload = base64 ? raw.replace(WHITESPACE, '') : raw;
  const declared = params[0];
  return {
    mediaType: declared === undefined || declared.length === 0 ? DEFAULT_MEDIA_TYPE : declared,
    base64,
    params,
    payload,
    bytes: () => (base64 ? decodeBase64Payload(payload) : percentDecodeBytes(payload)),
  };
}

/* The canonical decoder first so the bytes are the ones the egress would upload; Node's lenient
   decode is the fallback, because a caller hashing a payload to withhold it must still get bytes
   out of a payload nobody would deliver. Returning nothing there would fail OPEN. */
function decodeBase64Payload(payload: string): Buffer {
  return decodeCanonicalBase64(payload, MAX_ATTACHMENT_BYTES) ?? Buffer.from(payload, 'base64');
}

/* Byte-wise on purpose. `decodeURIComponent` throws on a lone `%` and folds `%ff%fe` into U+FFFD,
   so a binary payload comes back as bytes no recipient will ever see: each `%XX` is ONE byte, and
   anything else contributes its own UTF-8 bytes. The buffer is sized by the payload's UTF-8
   weight, which every rule above can only shrink. */
function percentDecodeBytes(payload: string): Buffer {
  const out = Buffer.allocUnsafe(Buffer.byteLength(payload, 'utf8'));
  let length = 0;
  let index = 0;
  for (const escape of payload.matchAll(PERCENT_ESCAPE)) {
    if (escape.index > index) length += out.write(payload.slice(index, escape.index), length, 'utf8');
    out[length] = Number.parseInt(escape[0].slice(1), 16);
    length += 1;
    index = escape.index + escape[0].length;
  }
  if (index < payload.length) length += out.write(payload.slice(index), length, 'utf8');
  return out.subarray(0, length);
}

/* What the payload weighs, for a budget that must not double the turn's memory per attachment:
   base64 is counted over the stripped text, never decoded. The percent form travels AS text, so
   its text is what the budget charges; `bytes().length` is the decoded figure. Anything that is
   not a parseable `data:` weighs its whole string, so a malformed one never rides for free.
   Whitespace is free by construction, so a payload padded with it weighs almost nothing here: what
   bounds THAT shape is the caller's character cap, never this byte budget. */
export function dataUriByteLength(uri: string): number {
  const header = readHeader(uri);
  if (header === undefined) return Buffer.byteLength(uri, 'utf8');
  const start = header.comma + 1;
  if (!header.base64) {
    return Buffer.byteLength(uri, 'utf8') - Buffer.byteLength(uri.slice(0, start), 'utf8');
  }
  return Math.max(0, Math.floor(strippedLength(uri, start) / 4) * 3 - trailingPadding(uri, start));
}

/* Both counters read the URI in place: slicing the payload out to strip its whitespace would copy
   exactly the megabytes this weigh-in exists not to spend. The whitespace CLASS is the one the
   parser strips with, so the count and `parseDataUri(...).payload.length` cannot drift -- but the
   INSTANCE is this scan's own: a `g` regex carries `lastIndex`, and one shared with the parser's
   `replace` would be a single early `return` away from moving the other reading. */
function strippedLength(uri: string, start: number): number {
  const scanner = new RegExp(WHITESPACE.source, WHITESPACE.flags);
  let whitespace = 0;
  scanner.lastIndex = start;
  for (let match = scanner.exec(uri); match !== null; match = scanner.exec(uri)) {
    whitespace += match[0].length;
  }
  return uri.length - start - whitespace;
}

function trailingPadding(uri: string, start: number): number {
  let padding = 0;
  for (let index = uri.length - 1; index >= start && padding < MAX_BASE64_PADDING; index -= 1) {
    const character = uri.charAt(index);
    if (SINGLE_WHITESPACE.test(character)) continue;
    if (character !== '=') break;
    padding += 1;
  }
  return padding;
}

function isInlineDataUri(uri: string): boolean {
  const parsed = parseDataUri(uri);
  if (parsed === undefined || !parsed.base64 || parsed.payload.length === 0) return false;
  return decodeCanonicalBase64(parsed.payload, MAX_ATTACHMENT_BYTES) !== undefined;
}

/* The literal prefix is checked before parsing on purpose: WHATWG resolves `https:not-a-url`
   into `https://not-a-url/`, so a parse alone would promote a typo into a fetchable host. */
function isFetchableHttpsUri(uri: string): boolean {
  if (uri.length > MAX_ARTIFACT_LOCATOR_CHARACTERS) return false;
  if (!HTTPS_PATTERN.test(uri) || /\s/u.test(uri) || hasUnsafeTextCodePoint(uri)) return false;
  try {
    return new URL(uri).host.length > 0;
  } catch {
    return false;
  }
}

export function isDeliverableArtifactUri(uri: string): boolean {
  if (DATA_PATTERN.test(uri)) return isInlineDataUri(uri);
  return isFetchableHttpsUri(uri);
}
