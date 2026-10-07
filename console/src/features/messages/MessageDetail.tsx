import { X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { Button } from '../../components/kit';
import { Badge, Time, Unknown } from '../../components/ui';
import { compactId, safeJobLane } from '../../lib';
import { onNavClick } from '../../router';
import { queueDeliveryPath } from '../deliveries/delivery-links';
import { deliveryPolicy } from '../deliveries/delivery-policy';
import { CARACTERES_DE_PREVISUALIZACION, previsualizacionRecortada, textoDelCuerpo } from '../terminal/cuerpo-del-mensaje';
import { fleetAgentId } from '../terminal/fleet';
import type { TranscriptItem } from '../terminal/session';
import type { FullBody } from './ChatMessage';
import { MessageTimeline } from './MessageTimeline';

function QueueLink({ deliveryId }: { deliveryId?: string | null }) {
  const path = queueDeliveryPath(deliveryId);
  if (!path) return null;
  return (
    <a href={path} onClick={(event) => { onNavClick(event, path); }} className="text-brand-ink no-underline hover:underline"
      aria-label={`Gestionar delivery ${deliveryId ?? 'UNKNOWN'} en Colas`}>Gestionar en Colas</a>
  );
}

function Field({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className={mono ? 'm-0 font-mono text-xs [overflow-wrap:anywhere]' : 'm-0 text-[13px] [overflow-wrap:anywhere]'}>{children}</dd>
    </div>
  );
}

/**
 * The technical side of one message: body, routing fields, timeline and the fan-out of the same
 * publish. Ids are shown whole and selectable, since a trimmed trace cannot be searched.
 */
export function MessageDetail({ item, chosen, outOfWindow, agentId, fullBody, headingRef, onFetchBody, onClose }: {
  item: TranscriptItem;
  chosen: boolean;
  outOfWindow: boolean;
  agentId: string;
  fullBody?: FullBody;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onFetchBody: (messageId: string) => void;
  onClose: () => void;
}) {
  const { message, delivery } = item;
  const id = message.message_id ?? undefined;
  const truncated = previsualizacionRecortada(message.body_preview);
  const preview = textoDelCuerpo(message.body_preview);
  const previewText = preview?.trim() ? preview
    : message.body_preview == null ? 'Contenido no incluido por el servidor.' : 'Mensaje sin contenido textual.';
  const siblings = (message.deliveries ?? []).filter((entry) => fleetAgentId(entry.recipient_tenant ?? '', entry.recipient_alias ?? '') !== agentId);

  return (
    <section
      role="group"
      aria-label="Detalle del mensaje seleccionado"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}
      className="z-20 flex min-h-0 w-full flex-col border-l border-line bg-surface max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:max-w-md max-[1100px]:shadow-pop min-[1101px]:w-[380px] min-[1101px]:shrink-0"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
        <h3 ref={headingRef} tabIndex={-1} className="m-0 text-[14px] font-semibold outline-none">{chosen ? 'Mensaje que elegiste' : 'Último mensaje del hilo'}</h3>
        <button type="button" onClick={onClose} aria-label="Cerrar detalle"
          className="grid size-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-4 text-[13px]">
        {outOfWindow ? <p role="note" className="m-0 rounded-md bg-warn-soft px-3 py-2 text-xs text-warn-ink">Mensaje fuera de la ventana actual; se muestra el último detalle recibido.</p> : null}
        <p className="m-0 text-xs text-muted">
          {delivery ? <>
            Entrega <span className="font-mono">{compactId(delivery.delivery_id)}</span> → {delivery.recipient_tenant ?? 'UNKNOWN'}:{delivery.recipient_alias ?? 'UNKNOWN'}
            {queueDeliveryPath(delivery.delivery_id) ? <> · <QueueLink deliveryId={delivery.delivery_id} /></> : null}
          </> : <>Mensaje <span className="font-mono">{compactId(id)}</span> · sin entrega para este par</>}
        </p>

        <section aria-label="Cuerpo del mensaje" className="grid gap-2">
          <h4 className="m-0 text-[11px] font-medium text-muted">Cuerpo</h4>
          <pre className="m-0 max-h-64 overflow-auto rounded-lg border border-line bg-subtle p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
            data-recortado={(fullBody?.estado !== 'listo' && truncated) || undefined}>
            {fullBody?.estado === 'listo' ? fullBody.texto : `${previewText}${truncated ? '…' : ''}`}
          </pre>
          {fullBody?.estado === 'fallo' ? <p role="alert" className="m-0 text-xs text-danger-ink">{fullBody.motivo}</p> : null}
          {truncated && fullBody?.estado !== 'listo' ? (
            <p className="m-0 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>El listado trae sólo los primeros {CARACTERES_DE_PREVISUALIZACION} caracteres.</span>
              <Button size="sm" disabled={!id || fullBody?.estado === 'pidiendo'}
                onClick={() => { if (id) onFetchBody(id); }}>
                {fullBody?.estado === 'pidiendo' ? 'Pidiendo…' : 'Ver el mensaje completo'}
              </Button>
            </p>
          ) : null}
        </section>

        <dl className="m-0 grid grid-cols-2 gap-3">
          <Field label="Room"><Unknown value={message.room_id} /></Field>
          <Field label="Carril"><Unknown value={safeJobLane(message.lane)} /></Field>
          <Field label="Actor verificado"><Unknown value={message.actor_alias} /></Field>
          <Field label="Tenant de origen"><Unknown value={message.tenant_id} /></Field>
          <Field label="Publicado"><Time value={message.created_at} /></Field>
          {delivery ? <Field label="Tenant destino"><Unknown value={delivery.recipient_tenant} /></Field> : null}
          <div className="col-span-2 grid gap-3">
            <Field label="Trace" mono>{message.trace_id ?? 'UNKNOWN'}</Field>
            <Field label="Message id" mono>{id ?? 'UNKNOWN'}</Field>
            {delivery ? <Field label="Delivery id" mono>{delivery.delivery_id ?? 'UNKNOWN'}</Field> : null}
          </div>
        </dl>

        {delivery ? <MessageTimeline events={delivery.timeline} /> : null}

        <section aria-label="Entregas hermanas del mismo publish" className="grid gap-2 border-t border-line pt-4">
          <h4 className="m-0 text-[11px] font-medium text-muted">Fan-out del publish</h4>
          {siblings.length === 0 ? (
            <p className="m-0 text-xs text-muted">
              {message.deliveries == null ? 'El servidor no incluyó las entregas de este mensaje.'
                : `El servidor devolvió ${String(message.deliveries.length)} entrega(s) para el mensaje; ninguna otra entrega fuera de este hilo.`}
            </p>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0">
              {siblings.map((entry, index) => {
                const policy = deliveryPolicy(entry.status);
                return (
                  <li key={entry.delivery_id ?? index} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <strong className="font-semibold text-fg">{entry.recipient_tenant ?? 'UNKNOWN'}:{entry.recipient_alias ?? 'UNKNOWN'}</strong>
                    <Badge tone={policy.tone}>
                      <Unknown value={policy.known ? policy.label : undefined}
                        motivo={entry.status && !policy.known ? `El servidor mandó un estado que esta consola no conoce: ${entry.status}` : undefined} />
                    </Badge>
                    <span className="font-mono">{compactId(entry.delivery_id)}</span>
                    <span>intento {entry.attempt ?? 'UNKNOWN'}</span>
                    <QueueLink deliveryId={entry.delivery_id} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
