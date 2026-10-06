import type { FastifyInstance } from 'fastify';
import { isRfcUuid } from '@cauce/protocol';
import { CauceRepository, StoreError } from '@cauce/store';
import { requirePermission } from '../../auth.js';
import { consoleHumanAccess } from '../../console-human-authority.js';
import { principal, replyError } from '../shared.js';
import type { ConsoleRouteOptions } from './contracts.js';
import { attachmentDisposition, attachmentResponseType, validatedInlineAttachment } from './message-attachments.js';

export function registerConsoleReplyAttachmentRoutes(
  app: FastifyInstance, options: Pick<ConsoleRouteOptions, 'pool' | 'authProvider'>,
): void {
  const repository = new CauceRepository(options.pool);
  app.get<{ Params: { messageId: string; deliveryId: string; attempt: string; attachmentIndex: string } }>(
    '/v3/console/messages/:messageId/replies/:deliveryId/:attempt/attachments/:attachmentIndex',
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
      let access;
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'read');
        const { messageId, deliveryId, attempt, attachmentIndex } = request.params;
        if (messageId.length !== 36 || !isRfcUuid(messageId) || deliveryId.length !== 36 || !isRfcUuid(deliveryId)
            || !/^(?:0|[1-9][0-9]{0,9})$/u.test(attempt) || Number(attempt) > 2147483647
            || !/^[0-3]$/u.test(attachmentIndex)) throw new StoreError('not_found', 'message not found or not visible');
        access = await consoleHumanAccess(options.authProvider, request, reply, 'read');
        if (!access) throw new StoreError('not_found', 'message not found or not visible');
        const attachments = await repository.getReplyAttachments(messageId, deliveryId, Number(attempt), access.options);
        const attachment = validatedInlineAttachment(attachments, Number(attachmentIndex));
        reply.header('Content-Disposition', attachmentDisposition(attachment.name));
        return await reply.type(attachmentResponseType(attachment.mimeType)).send(attachment.bytes);
      } catch (error) { replyError(reply, error); }
      finally { access?.close(); }
    },
  );
}
