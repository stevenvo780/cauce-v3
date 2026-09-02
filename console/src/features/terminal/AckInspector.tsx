import { Clock3, ExternalLink } from 'lucide-react';
import type { DeliveryView } from '../../api/types';
import { Badge, EmptyState, Time, Unknown } from '../../components/ui';
import { compactId } from '../../lib';
import { queueDeliveryPath } from '../deliveries/delivery-links';
import { deliveryPolicy } from '../deliveries/delivery-policy';

export function AckInspector({ delivery }: { delivery?: DeliveryView }) {
  const policy = deliveryPolicy(delivery?.status);
  const queuePath = queueDeliveryPath(delivery?.delivery_id);

  return (
    <section className="terminal-inspector-section" aria-labelledby="ack-inspector-title">
      <header className="inspector-title">
        <div><p className="eyebrow">Delivery lifecycle</p><h3 id="ack-inspector-title">ACK timeline</h3></div>
        {delivery ? <Badge tone={policy.tone}><Unknown
          value={policy.known ? policy.label : undefined}
          motivo={delivery.status && !policy.known
            ? `El servidor mandó un estado que esta consola no conoce: ${delivery.status}`
            : undefined}
        /></Badge> : null}
      </header>
      {!delivery ? <EmptyState>Seleccioná una delivery del transcript para inspeccionar sus ACK.</EmptyState> : (
        <>
          <dl className="ack-meta">
            <div><dt>Delivery</dt><dd className="mono">{compactId(delivery.delivery_id)}</dd></div>
            <div><dt>Intento</dt><dd><Unknown value={delivery.attempt} /></dd></div>
          </dl>
          <ol className="ack-timeline">
            {(delivery.timeline ?? []).length ? (delivery.timeline ?? []).map((event, index) => {
              const eventPolicy = deliveryPolicy(event.status);
              return <li key={`${event.status}-${String(event.at ?? index)}`} data-state={event.status}>
                <span className="ack-node" aria-hidden="true" />
                <div>
                  <strong>{eventPolicy.known ? eventPolicy.label : event.status.toUpperCase()}</strong>
                  <Time value={event.at} />
                  {event.detail ? <p>{event.detail}</p> : null}
                </div>
                <small>#{event.attempt ?? '—'}</small>
              </li>;
            }) : <li className="ack-unknown"><Clock3 size={15} aria-hidden="true" /> Timeline no informada por el servidor.</li>}
          </ol>
          {queuePath ? (
            <a
              className="button small secondary terminal-queue-link"
              href={queuePath}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={14} aria-hidden="true" /> Gestionar en Queues &amp; DLQ
            </a>
          ) : <p className="inspector-footnote">El servidor no informó un ID navegable para esta delivery.</p>}
        </>
      )}
    </section>
  );
}
