import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  AttachmentContentSchema, isRfcUuid, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BYTES,
} from '@cauce/protocol';
import { CauceRepository, StoreError } from '@cauce/store';
import { consoleHumanAccess } from '../../console-human-authority.js';
import { messageReader, requirePermission } from '../../auth.js';
import { visibleMessage } from '../../facades.js';
import { principal, replyError } from '../shared.js';
import type { ConsoleRouteOptions } from './contracts.js';

function notFound(): never {
  throw new StoreError('not_found', 'message not found or not visible');
}

export function validatedInlineAttachment(value: unknown, index: number): {
  name: string; mimeType: string; bytes: Buffer;
} {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_ATTACHMENTS_PER_MESSAGE
      || !Array.isArray(value) || value.length === 0 || value.length > MAX_ATTACHMENTS_PER_MESSAGE) notFound();
  const attachments = [];
  let total = 0;
  for (const entry of value) {
    const parsed = AttachmentContentSchema.safeParse(entry);
    if (!parsed.success || parsed.data.mime_type.trim() !== parsed.data.mime_type
        || Buffer.from(parsed.data.name, 'utf8').toString('utf8') !== parsed.data.name) notFound();
    total += parsed.data.file_size;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) notFound();
    attachments.push(parsed.data);
  }
  let selected: { name: string; mimeType: string; bytes: Buffer } | undefined;
  for (const [position, attachment] of attachments.entries()) {
    const bytes = Buffer.from(attachment.content_base64, 'base64');
    if (bytes.length !== attachment.file_size || bytes.toString('base64') !== attachment.content_base64
        || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) notFound();
    if (position === index) selected = { name: attachment.name, mimeType: attachment.mime_type, bytes };
  }
  return selected ?? notFound();
}

export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^A-Za-z0-9._-]/gu, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function attachmentResponseType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  const passive = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|audio\/[a-z0-9!#$&^_.+-]+|video\/[a-z0-9!#$&^_.+-]+)$/u;
  return passive.test(normalized) ? normalized : 'application/octet-stream';
}

export function registerConsoleMessageAttachmentRoutes(
  app: FastifyInstance, options: Pick<ConsoleRouteOptions, 'pool' | 'authProvider'>,
): void {
  const repository = new CauceRepository(options.pool);
  app.get<{ Params: { messageId: string; attachmentIndex: string } }>(
    '/v3/console/messages/:messageId/attachments/:attachmentIndex', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
      let access;
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'read');
        const { messageId, attachmentIndex } = request.params;
        if (messageId.length !== 36 || !isRfcUuid(messageId)
            || attachmentIndex.length !== 1 || !/^[0-3]$/u.test(attachmentIndex)) notFound();
        access = await consoleHumanAccess(options.authProvider, request, reply, 'read');
        const result = access
          ? await repository.getHumanMessageAttachment(messageId, access.options)
          : await repository.getMessageAttachment(messageId, actor.tenant_id, actor.alias, messageReader(actor));
        if (visibleMessage(result.message, actor) === undefined) notFound();
        const attachment = validatedInlineAttachment(result.attachments, Number(attachmentIndex));
        reply.header('Content-Disposition', attachmentDisposition(attachment.name));
        return await reply.type(attachmentResponseType(attachment.mimeType)).send(attachment.bytes);
      } catch (error) { replyError(reply, error); }
      finally { access?.close(); }
    },
  );
}
