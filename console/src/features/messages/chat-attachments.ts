import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BYTES } from '../../../../packages/protocol/src/attachment-limits.js';
import { isSafeBasename } from '../../../../packages/protocol/src/content-safety.js';
import { isValidMediaType } from '../../../../packages/protocol/src/schemas/media-types.js';
import type { ChatAttachment } from '../../api/types';

export { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BYTES };

function validateFile(file: File): void {
  if (file.size === 0) throw new Error(`“${file.name || 'Archivo'}” está vacío.`);
  if (!isSafeBasename(file.name)) throw new Error('El nombre del archivo no es seguro.');
  if (file.type && !isValidMediaType(file.type)) throw new Error(`“${file.name}” no tiene un tipo MIME válido.`);
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`“${file.name}” supera el límite de ${MAX_ATTACHMENT_BYTES.toLocaleString('es-CO')} bytes.`);
  }
}

export function validateAttachmentSelection(files: readonly File[]): void {
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`Podés adjuntar hasta ${String(MAX_ATTACHMENTS_PER_MESSAGE)} archivos.`);
  }
  let total = 0;
  for (const file of files) {
    validateFile(file);
    total += file.size;
  }
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
    throw new Error(`Los archivos superan el límite total de ${MAX_ATTACHMENTS_TOTAL_BYTES.toLocaleString('es-CO')} bytes.`);
  }
}

async function readBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => { reject(new Error(`No se pudo leer “${file.name}”.`)); };
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error(`No se pudo leer “${file.name}”.`));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsArrayBuffer(file);
  });
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function snapshotAttachments(files: readonly File[]): Promise<ChatAttachment[]> {
  validateAttachmentSelection(files);
  const attachments: ChatAttachment[] = [];
  for (const file of files) {
    const buffer = await readBuffer(file);
    const bytes = new Uint8Array(buffer);
    const mimeType = file.type || 'application/octet-stream';
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    attachments.push({
      kind: mimeType.toLowerCase().startsWith('image/') ? 'image' : 'document',
      name: file.name,
      mime_type: mimeType,
      file_size: bytes.byteLength,
      sha256,
      content_base64: encodeBase64(bytes),
    });
  }
  return attachments;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1_000) return `${String(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toLocaleString('es-CO', { maximumFractionDigits: 2 })} KB`;
  return `${(bytes / 1_000_000).toLocaleString('es-CO', { maximumFractionDigits: 2 })} MB`;
}
