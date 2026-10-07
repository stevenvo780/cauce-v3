import type { DurablePublishReceipt } from '../../api/types';
import type { TranscriptItem } from '../terminal/session';

export interface OptimisticMessage extends TranscriptItem {
  optimistic: {
    clientId: string;
    state: 'sending' | 'published' | 'failed';
    files: readonly File[];
  };
}

export function optimisticMessageOf(item: TranscriptItem): OptimisticMessage['optimistic'] | undefined {
  return (item as TranscriptItem & Partial<Pick<OptimisticMessage, 'optimistic'>>).optimistic;
}

export function publishedMessage(item: OptimisticMessage, receipt: DurablePublishReceipt): OptimisticMessage {
  return {
    ...item,
    optimistic: { ...item.optimistic, state: 'published' },
    message: { ...item.message, message_id: receipt.message_id, tenant_id: receipt.tenant_id,
      actor_alias: receipt.actor_alias, request_id: receipt.request_id, trace_id: receipt.trace_id },
    delivery: { ...item.delivery, delivery_id: receipt.delivery_ids[0], status: 'pending', timeline: [{ status: 'published' }] },
  };
}

function sameReceipt(local: OptimisticMessage, remote: TranscriptItem): boolean {
  return typeof local.message.message_id === 'string' && local.message.message_id === remote.message.message_id
    && local.delivery?.delivery_id === remote.delivery?.delivery_id
    && local.delivery?.recipient_tenant === remote.delivery?.recipient_tenant
    && local.delivery?.recipient_alias === remote.delivery?.recipient_alias;
}

export function retainOptimisticMessages(local: OptimisticMessage[], feed: readonly TranscriptItem[]): OptimisticMessage[] {
  const kept = local.slice(-100).map((item) => {
    const attachments = feed.find((candidate) => sameReceipt(item, candidate))?.message.attachments;
    if (!item.optimistic.files.length || !Array.isArray(attachments) || attachments.length !== item.optimistic.files.length
      || !item.optimistic.files.every((file, index) => {
        const remote = attachments.at(index);
        return remote?.name === file.name && remote.file_size === file.size
          && remote.mime_type.toLowerCase() === (file.type || 'application/octet-stream').toLowerCase()
          && /^[a-f0-9]{64}$/u.test(remote.sha256);
      })) return item;
    return { ...item, optimistic: { ...item.optimistic, files: [] } };
  });
  return kept.length === local.length && kept.every((item, index) => item === local[index]) ? local : kept;
}

export function mergeOptimisticMessages(feed: readonly TranscriptItem[], local: readonly OptimisticMessage[]): TranscriptItem[] {
  const kept = retainOptimisticMessages([...local], feed);
  const merged = feed.map((item) => {
    const pending = kept.find((candidate) => sameReceipt(candidate, item));
    return pending ? { ...item, optimistic: pending.optimistic, message: {
      ...item.message, body_preview: pending.message.body_preview,
      author: item.message.author ?? pending.message.author,
    } } : item;
  });
  for (const item of kept) {
    if (!merged.some((candidate) => optimisticMessageOf(candidate)?.clientId === item.optimistic.clientId)) merged.push(item);
  }
  return merged.sort((left, right) => Date.parse(left.message.created_at ?? '') - Date.parse(right.message.created_at ?? ''));
}
