import { createHash } from 'node:crypto';
import { AttachmentContentSchema, MAX_ATTACHMENTS_TOTAL_BYTES } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { attachmentsFromArtifacts } from '../agents/delegated-attachments.js';
import { loadDeliveryHumanLineage } from '../human-message-lineage.js';
import type { DeliveryRow } from '../observability.js';

export function validatedReplyAttachments(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return [];
  const attachments = [];
  let total = 0;
  for (const candidate of value) {
    const parsed = AttachmentContentSchema.safeParse(candidate);
    if (!parsed.success) return [];
    const item = parsed.data;
    const bytes = Buffer.from(item.content_base64, 'base64');
    total += bytes.length;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES || bytes.length !== item.file_size
        || bytes.toString('base64') !== item.content_base64 || item.mime_type.trim() !== item.mime_type
        || Buffer.from(item.name, 'utf8').toString('utf8') !== item.name
        || createHash('sha256').update(bytes).digest('hex') !== item.sha256) return [];
    attachments.push(item);
  }
  return attachments;
}

export function replyAttachmentMetadata(value: unknown) {
  if (!Array.isArray(value) || value.length > 4) return [];
  const items = [];
  let total = 0;
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const entry = candidate as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !['name', 'mime_type', 'file_size', 'sha256'].includes(key))) return [];
    const name = AttachmentContentSchema.shape.name.safeParse(entry.name);
    const mime = AttachmentContentSchema.shape.mime_type.safeParse(entry.mime_type);
    const size = AttachmentContentSchema.shape.file_size.safeParse(entry.file_size);
    const digest = AttachmentContentSchema.shape.sha256.safeParse(entry.sha256);
    if (!name.success || !mime.success || !size.success || !digest.success) return [];
    total += size.data;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) return [];
    items.push({ name: name.data, mime_type: mime.data, file_size: size.data, sha256: digest.data });
  }
  return items;
}

export async function withFinalReplyMedia(
  client: DatabaseClient, row: DeliveryRow, done: boolean,
  rawResult: Record<string, unknown> | undefined, storedResult: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!done || !rawResult) return storedResult;
  const output = rawResult.output;
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return storedResult;
  const attachments = validatedReplyAttachments(attachmentsFromArtifacts(
    (output as Record<string, unknown>).artifacts,
  ).attachments);
  if (attachments.length === 0) return storedResult;
  const lineage = await loadDeliveryHumanLineage(client, row);
  if (!lineage) return storedResult;
  const root = await client.query<{ console: boolean }>(
    `SELECT auth_channel='console' OR origin->>'adapter'='console' AS console
     FROM messages WHERE id=$1::uuid`, [lineage.rootMessageId],
  );
  if (root.rows[0]?.console !== true) return storedResult;
  return { ...storedResult, reply_attachments_v1: attachments };
}
