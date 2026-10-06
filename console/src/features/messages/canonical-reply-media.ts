import type { MessageAttachment, MessageDetailDelivery } from '../../api/types';
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BYTES } from './chat-attachments';

export interface CanonicalReplyMedia {
  replyAttachments?: MessageAttachment[];
  replyAttachmentDeliveryId?: string;
  replyAttachmentAttempt?: number;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function attachmentMetadata(value: unknown): MessageAttachment {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('El servidor devolvió un archivo de respuesta inválido.');
  }
  const file = value as Record<string, unknown>;
  if (typeof file.name !== 'string' || !file.name.trim()
    || typeof file.mime_type !== 'string' || !file.mime_type.trim()
    || typeof file.file_size !== 'number' || !Number.isSafeInteger(file.file_size) || file.file_size <= 0
    || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
    throw new Error('El servidor devolvió metadatos de respuesta inválidos.');
  }
  return { name: file.name, mime_type: file.mime_type, file_size: file.file_size, sha256: file.sha256 };
}

export function canonicalReplyMedia(delivery: MessageDetailDelivery): CanonicalReplyMedia {
  const raw: unknown = delivery.reply_attachments;
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error('El servidor devolvió archivos de respuesta inválidos.');
  }
  if (!raw.length) return {};
  const files = raw.map(attachmentMetadata);
  const deliveryId = delivery.reply_attachment_delivery_id;
  const attempt = delivery.reply_attachment_attempt;
  if (files.reduce((total, file) => total + file.file_size, 0) > MAX_ATTACHMENTS_TOTAL_BYTES
    || typeof deliveryId !== 'string' || !UUID.test(deliveryId)
    || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 2_147_483_647) {
    throw new Error('El servidor devolvió una referencia de respuesta inválida.');
  }
  return { replyAttachments: files, replyAttachmentDeliveryId: deliveryId, replyAttachmentAttempt: attempt };
}
