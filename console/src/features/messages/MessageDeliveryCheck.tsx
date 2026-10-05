import type { DeliveryView } from '../../api/types';
import { HarnessConsumptionEvidenceSchema } from '@cauce/protocol';

export function MessageDeliveryCheck({ delivery }: { delivery: DeliveryView }) {
  const events = (delivery.timeline ?? []).filter((event) => event.applied !== false
    && event.detail !== 'duplicate_or_out_of_order');
  const status = delivery.status ?? [...events].reverse()
    .find((event) => event.status !== 'published')?.status;
  const received = ['accepted', 'started', 'done'].includes(status ?? '')
    || events.some((event) => ['accepted', 'started', 'done'].includes(event.status));
  const published = events.some((event) => event.status === 'published');
  const failed = status === 'failed' || status === 'dead';
  const read = Number.isSafeInteger(delivery.attempt) && (delivery.attempt ?? 0) > 0
    && events.some((event) => event.applied === true && event.status === 'done'
    && event.attempt === delivery.attempt
    && HarnessConsumptionEvidenceSchema.safeParse(event.harness_consumption).success);
  const checks = read ? 2 : received ? 1 : 0;
  const labels = new Map([
    ['accepted', 'Recibido por el agente · entrega aceptada'],
    ['started', 'Recibido por el agente · ejecución iniciada'],
    ['done', 'Recibido por el agente · ejecución terminada'],
    ['failed', 'La ejecución falló'], ['dead', 'La entrega quedó detenida'], ['retry', 'Cauce reintentará la entrega'],
  ]);
  const label = (!failed && read ? 'Leído por el agente · respuesta nativa comprobada' : undefined)
    ?? (status ? labels.get(status) : undefined)
    ?? (published ? 'Publicado · esperando aceptación del agente' : 'Estado de entrega no disponible');
  return <span className={failed ? 'chat-delivery-check chat-delivery-check-danger' : 'chat-delivery-check'}
    role="status" aria-label={`Entrega: ${label}`} title={`${label}. ${read ? 'Lectura comprobada.' : 'Lectura sin comprobar.'}`}>
    <span aria-hidden="true" data-checks={checks || undefined}>{checks === 2 ? '✓✓' : checks === 1 ? '✓' : '◷'}</span>
    {failed ? <span>{label}</span> : null}
  </span>;
}
