export type MessageMediaKind = 'image' | 'audio' | 'video' | 'document';

export interface AttachmentSummary {
  attachmentIndex: number;
  name: string;
  mimeType?: string;
  mediaKind: MessageMediaKind;
  image: boolean;
  size?: number;
}

const RASTER_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function messageMediaKind(mimeType: unknown): MessageMediaKind {
  if (typeof mimeType !== 'string') return 'document';
  const normalized = mimeType.replace(/;.*$/u, '').trim().toLowerCase();
  if (normalized && RASTER_IMAGE_TYPES.has(normalized)) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  return 'document';
}

export function safeAttachmentName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'Archivo';
  const safe = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return character === '/' || character === '\\' || code < 32 || code === 127 ? '_' : character;
  }).join('');
  return safe.trim().slice(0, 180) || 'Archivo';
}

export function messageAttachmentList(value: unknown): AttachmentSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown, attachmentIndex: number) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const file = entry as Record<string, unknown>;
    const mimeType = typeof file.mime_type === 'string' && file.mime_type.trim()
      ? file.mime_type.trim().toLowerCase() : undefined;
    const mediaKind = mimeType
      ? messageMediaKind(mimeType)
      : file.kind === 'image' ? 'image' : 'document';
    return [{
      attachmentIndex,
      name: safeAttachmentName(file.name),
      ...(mimeType ? { mimeType } : {}),
      mediaKind,
      image: mediaKind === 'image',
      size: typeof file.file_size === 'number' && Number.isSafeInteger(file.file_size) && file.file_size > 0
        ? file.file_size : undefined,
    }];
  });
}
