import type { DeliveryView } from '../../api/types';

export function MessageDeliveryCheck({ delivery }: { delivery: DeliveryView }) {
  const status = delivery.status ?? [...(delivery.timeline ?? [])].reverse()
    .find((event) => event.status !== 'published')?.status;
  const events = delivery.timeline ?? [];
  const received = ['accepted', 'started', 'done'].includes(status ?? '')
    || events.some((event) => ['accepted', 'started', 'done'].includes(event.status ?? ''));
  const published = events.some((event) => event.status === 'published');
  const failed = status === 'failed' || status === 'dead';
  const checks = received ? 2 : published ? 1 : 0;
  const labels = new Map([
    ['accepted', 'Recibido por el agente · entrega aceptada'],
    ['started', 'Recibido por el agente · ejecución iniciada'],
    ['done', 'Recibido por el agente · ejecución terminada'],
    ['failed', 'La ejecución falló'], ['dead', 'La entrega quedó detenida'], ['retry', 'Cauce reintentará la entrega'],
  ]);
  const label = (status ? labels.get(status) : undefined)
    ?? (published ? 'Publicado · esperando aceptación del agente' : 'Estado de entrega no disponible');
  return <span className={failed ? 'chat-delivery-check chat-delivery-check-danger' : 'chat-delivery-check'}
    role="status" aria-label={`Entrega: ${label}`} title={`${label}. No hay comprobante de lectura.`}>
    <span aria-hidden="true" data-checks={checks || undefined}>{checks === 2 ? '✓✓' : checks === 1 ? '✓' : '◷'}</span>
    {failed ? <span>{label}</span> : null}
  </span>;
}
