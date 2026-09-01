import type { TimelineEvent } from '../../api/types';
import { Badge, Time } from '../../components/ui';
import { DELIVERY_POLICY, deliveryPolicy } from '../deliveries/delivery-policy';

const ordered = ['published', 'accepted', 'started'] as const;

function timelinePolicy(status: unknown) {
  if (status === 'published') return { label: 'PUBLICADA', tone: 'info' as const, className: 'published' };
  if (status === 'done / failed') return {
    label: `${DELIVERY_POLICY.done.label} / ${DELIVERY_POLICY.failed.label}`,
    tone: 'unknown' as const,
    className: 'unknown',
  };
  const policy = deliveryPolicy(status);
  return {
    label: policy.label,
    tone: policy.tone,
    className: policy.known ? policy.state : 'unknown',
  };
}

export function MessageTimeline({ events = [] }: { events?: TimelineEvent[] | null }) {
  const safeEvents = events ?? [];
  const terminal = safeEvents.find((event) => event.status === 'done' || event.status === 'failed');
  const steps: { label: string; event?: TimelineEvent }[] = [
    ...ordered.map((status) => ({ label: status, event: safeEvents.find((event) => event.status === status) })),
    { label: terminal?.status ?? 'done / failed', event: terminal },
  ];

  return (
    <ol className="timeline" aria-label="Timeline publish a resultado terminal">
      {steps.map(({ label, event }) => (
        <li key={label} className={event ? `timeline-${timelinePolicy(event.status).className}` : 'timeline-missing'}>
          <span className="timeline-node" aria-hidden="true" />
          <div>
            <Badge tone={event ? timelinePolicy(event.status).tone : 'unknown'}>
              {event ? timelinePolicy(event.status).label : `${timelinePolicy(label).label} · UNKNOWN`}
            </Badge>
            <Time value={event?.at} />
            {event?.attempt ? <small>Intento {event.attempt}</small> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
