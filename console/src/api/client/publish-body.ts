import type { PublishMessageInput } from '../types';

export function publishBody(body: PublishMessageInput['body']): PublishMessageInput['body'] {
  return {
    text: body.text,
    ...(body.attachments_v1?.length ? {
      attachments_v1: body.attachments_v1.map((file) => ({
        kind: file.kind, name: file.name, mime_type: file.mime_type,
        file_size: file.file_size, sha256: file.sha256, content_base64: file.content_base64,
      })),
    } : {}),
  };
}
