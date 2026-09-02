/**
 * Media type authority: syntax, raster signatures and the extension table.
 *
 * Nothing here accepts or rejects an attachment. A media type only decides how a file is labelled
 * and how it is routed (inline image or plain file); the platform carries any format.
 */

/** `type/subtype` restricted to the characters RFC 2045 allows in a token: no parameters, no space. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/iu;

export function isValidMediaType(value: string): boolean {
  return MEDIA_TYPE.test(value);
}

/** Drops parameters (`; charset=…`) and case from a declared type; `undefined` when nothing valid is left. */
export function normalizeMediaType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const bare = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return isValidMediaType(bare) ? bare : undefined;
}

export type RasterImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function matches(payload: Uint8Array, offset: number, signature: readonly number[]): boolean {
  return payload.length >= offset + signature.length &&
    signature.every((byte, index) => payload[offset + index] === byte);
}

/**
 * The raster formats a viewer can be trusted to decode, identified by their bytes.
 *
 * A file that fails every signature is never turned away: the answer only says whether it may be
 * routed as an image, and `image/*` is wider than what is decodable (`image/svg+xml` is markup).
 */
export function imageSignature(payload: Uint8Array): RasterImageMediaType | undefined {
  if (matches(payload, 0, JPEG)) return 'image/jpeg';
  if (matches(payload, 0, PNG)) return 'image/png';
  if (matches(payload, 0, GIF87A) || matches(payload, 0, GIF89A)) return 'image/gif';
  if (matches(payload, 0, RIFF) && matches(payload, 8, WEBP)) return 'image/webp';
  return undefined;
}

/**
 * Extension ↔ media type. The first entry for a media type is its canonical extension.
 *
 * A fallback for naming a file that arrived without a usable type, never a list of what is allowed:
 * an extension absent from here still travels, as `application/octet-stream`.
 */
const PAIRS: readonly (readonly [string, string])[] = [
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.svg', 'image/svg+xml'], ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon'],
  ['.tif', 'image/tiff'], ['.tiff', 'image/tiff'], ['.heic', 'image/heic'], ['.avif', 'image/avif'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'], ['.log', 'text/plain'], ['.yaml', 'text/plain'], ['.yml', 'text/plain'],
  ['.toml', 'text/plain'], ['.ini', 'text/plain'],
  ['.md', 'text/markdown'], ['.csv', 'text/csv'], ['.html', 'text/html'], ['.htm', 'text/html'],
  ['.json', 'application/json'], ['.xml', 'application/xml'], ['.sql', 'application/sql'],
  ['.sh', 'application/x-sh'], ['.py', 'text/x-python'],
  ['.zip', 'application/zip'], ['.gz', 'application/gzip'], ['.tar', 'application/x-tar'],
  ['.7z', 'application/x-7z-compressed'], ['.rar', 'application/vnd.rar'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.odt', 'application/vnd.oasis.opendocument.text'],
  ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['.epub', 'application/epub+zip'], ['.apk', 'application/vnd.android.package-archive'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'], ['.avi', 'video/x-msvideo'],
  ['.mp3', 'audio/mpeg'], ['.ogg', 'audio/ogg'], ['.wav', 'audio/wav'], ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'], ['.opus', 'audio/opus'],
  ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf']
];

const BY_EXTENSION: ReadonlyMap<string, string> = new Map(PAIRS);

const BY_MEDIA_TYPE: ReadonlyMap<string, string> = new Map(
  [...PAIRS].reverse().map(([extension, mediaType]) => [mediaType, extension])
);

export function mediaTypeForExtension(extension: string): string | undefined {
  return BY_EXTENSION.get(extension.toLowerCase());
}

export function extensionForMediaType(mediaType: string): string | undefined {
  return BY_MEDIA_TYPE.get(mediaType.toLowerCase());
}
