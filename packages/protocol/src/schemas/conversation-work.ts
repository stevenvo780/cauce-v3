import { z } from 'zod';
import { AliasSchema, DeliveryIdSchema, DeliveryStateSchema, MessageIdSchema } from './core.js';

export const ConversationWorkStateSchema = z.object({
  as_of: z.iso.datetime({ offset: true }),
  has_more: z.boolean(),
  branches: z.array(z.object({
    source_delivery_id: DeliveryIdSchema,
    child_delivery_id: DeliveryIdSchema,
    root_message_id: MessageIdSchema,
    target_alias: AliasSchema,
    status: DeliveryStateSchema,
    updated_at: z.iso.datetime({ offset: true }),
    task_untrusted: z.string().max(2048),
    result_untrusted: z.string().max(4096),
    review_untrusted: z.string().max(2048),
    review_status: DeliveryStateSchema.nullable(),
    review_updated_at: z.iso.datetime({ offset: true }).nullable(),
    review_input_at: z.iso.datetime({ offset: true }).nullable(),
    review_matches_current_result: z.boolean(),
  }).strict()).max(16),
}).strict();

export type ConversationWorkState = z.infer<typeof ConversationWorkStateSchema>;
