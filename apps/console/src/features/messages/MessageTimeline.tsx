import type { TimelineEvent } from '../../api/types';
import { Badge, Time } from '../../components/ui';

const ordered = ['published', 'accepted', 'started'] as const;

export function MessageTimeline({ events = [] }: { events?: TimelineEvent[] | null }) {
  const safeEvents = events ?? [];
  const terminal = safeEvents.find((event) => event.status === 'done' || event.status === 'failed');
  const steps: Array<{ label: string; event?: TimelineEvent }> = [
    ...ordered.map((status) => ({ label: status, event: safeEvents.find((event) => event.status === status) })),
    { label: terminal?.status ?? 'done / failed', event: terminal },
  ];

  return (
    <ol className="timeline" aria-label="Timeline publish a resultado terminal">
      {steps.map(({ label, event }) => (
        <li key={label} className={event ? `timeline-${event.status}` : 'timeline-missing'}>
          <span className="timeline-node" aria-hidden="true" />
          <div>
            <Badge tone={!event ? 'unknown' : event.status === 'failed' ? 'danger' : event.status === 'done' ? 'done' : event.status === 'started' ? 'running' : 'info'}>
              {event ? event.status.toUpperCase() : `${label.toUpperCase()} · UNKNOWN`}
            </Badge>
            <Time value={event?.at} />
            {event?.attempt ? <small>Intento {event.attempt}</small> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
