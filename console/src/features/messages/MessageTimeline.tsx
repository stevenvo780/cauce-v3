import type { ClientMailboxDeliveryReceipt, TimelineEvent } from '../../api/types';
import { cn } from '../../cn';
import { Badge, Time } from '../../components/ui';
import { DELIVERY_POLICY } from '../deliveries/delivery-policy';
import { MAILBOX_EXPLANATION, deliveryReceiptPolicy, isClientMailboxDelivery } from '../deliveries/client-mailbox';

const ordered = ['published', 'accepted', 'started'] as const;

function timelinePolicy(status: unknown, clientMailbox?: ClientMailboxDeliveryReceipt | null) {
  if (status === 'published') return { label: 'PUBLICADA', tone: 'info' as const, known: true };
  if (status === 'done / failed') return { label: `${DELIVERY_POLICY.done.label} / ${DELIVERY_POLICY.failed.label}`, tone: 'unknown' as const, known: false };
  const policy = deliveryReceiptPolicy(status, clientMailbox);
  return { label: policy.label, tone: policy.tone, known: policy.known };
}

export function MessageTimeline({
  events = [],
  clientMailbox,
}: {
  events?: TimelineEvent[] | null;
  clientMailbox?: ClientMailboxDeliveryReceipt | null;
}) {
  const safeEvents = events ?? [];
  const isMailbox = isClientMailboxDelivery({ client_mailbox: clientMailbox });
  const terminal = safeEvents.find((event) => event.status === 'done' || event.status === 'failed');
  const steps: { label: string; event?: TimelineEvent }[] = isMailbox
    ? ['published', 'done'].map((status) => ({ label: status, event: safeEvents.find((event) => event.status === status) }))
    : [
      ...ordered.map((status) => ({ label: status, event: safeEvents.find((event) => event.status === status) })),
      { label: terminal?.status ?? 'done / failed', event: terminal },
    ];

  return (
    <ol className="m-0 grid list-none gap-2 border-l border-line p-0 pl-4" aria-label={isMailbox ? 'Timeline publish a guardado en buzón' : 'Timeline publish a resultado terminal'}>
      {steps.map(({ label, event }) => {
        const policy = timelinePolicy(event ? event.status : label, isMailbox ? clientMailbox : undefined);
        return (
          <li key={label} className="relative flex flex-wrap items-center gap-2 text-xs text-muted" data-missing={event ? undefined : true}>
            <span className={cn('absolute top-1.5 -left-[21px] size-2 rounded-full ring-2 ring-surface', event && policy.known ? 'bg-brand' : 'bg-line-strong')} aria-hidden="true" />
            <Badge tone={event ? policy.tone : 'unknown'}>{event ? policy.label : `${policy.label} · UNKNOWN`}</Badge>
            <Time value={event?.at} />
            {isMailbox && label === 'done' ? <small>{MAILBOX_EXPLANATION}</small>
              : event?.attempt ? <small>Intento {event.attempt}</small> : null}
          </li>
        );
      })}
    </ol>
  );
}
