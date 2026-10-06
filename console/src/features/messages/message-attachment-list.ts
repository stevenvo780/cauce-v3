export interface AttachmentSummary { name: string; image: boolean; size?: number }

export function messageAttachmentList(value: unknown): AttachmentSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const file = entry as Record<string, unknown>;
    return [{
      name: typeof file.name === 'string' && file.name.trim() ? file.name : 'Archivo',
      image: typeof file.mime_type === 'string' && file.mime_type.toLowerCase().startsWith('image/'),
      size: typeof file.file_size === 'number' && Number.isSafeInteger(file.file_size) && file.file_size > 0
        ? file.file_size : undefined,
    }];
  });
}
