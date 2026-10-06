import { AlertTriangle, ChevronDown, Info } from 'lucide-react';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { cn } from '../../cn';
import { onNavClick } from '../../router';
import type { SaludDeCola } from './queue-health';

/**
 * One quiet line under the header with every condition that changes how a send behaves. Critical
 * states stay readable on that line; the explanation unfolds inline on demand.
 */
export function ConversationNotices({ health, queueError, feedError, leaseWarning, leaseExpired, topologyWarning, onQueueReload, fallbackFocusRef }: {
  health?: SaludDeCola;
  queueError?: Error;
  feedError?: Error;
  leaseWarning?: string;
  leaseExpired: boolean;
  topologyWarning?: string;
  onQueueReload: () => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusInside = useRef(false);
  const queueAttention = (health?.reintentos ?? 0) > 0 || (health?.muertas ?? 0) > 0;
  const labels: { text: string; role: 'status' | 'alert' | 'note' }[] = [];
  if (queueAttention) labels.push({ role: 'status', text:
    (health?.reintentos ? `${String(health.reintentos)} reintento(s). ` : '')
      + (health?.muertas ? `${health.muertasTruncadas ? '≥ ' : ''}${String(health.muertas)} muerta(s).` : '') });
  if (queueError) labels.push({ role: 'alert', text: 'Cola sin verificar' });
  if (feedError) labels.push({ role: 'alert', text: 'Historial anterior: sin actualizar' });
  if (leaseWarning) labels.push({ role: 'note', text: leaseExpired ? 'Lease vencido · envío en cola' : 'Lease sin dato · envío en cola' });
  if (topologyWarning) labels.push({ role: 'note', text: 'Fuera de la topología' });
  const hasNotices = labels.length > 0;
  const severe = queueError !== undefined || feedError !== undefined || Boolean(health?.muertas);

  useEffect(() => {
    if (hasNotices) return;
    setOpen(false);
    if (focusInside.current) fallbackFocusRef?.current?.focus({ preventScroll: true });
    focusInside.current = false;
  }, [hasNotices, fallbackFocusRef]);
  useEffect(() => { if (open) heading.current?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => {
    // A control that vanished with its notice must not drop focus to the page.
    if (open && focusInside.current && document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
  });

  if (!hasNotices) return null;
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  return (
    <div
      ref={container}
      className={cn('shrink-0 border-b border-line text-xs', severe ? 'bg-danger-soft/60 text-danger-ink' : 'bg-subtle text-fg-2')}
      onFocusCapture={() => { focusInside.current = true; }}
      onBlurCapture={(event) => { if (!(event.relatedTarget instanceof Node && container.current?.contains(event.relatedTarget))) focusInside.current = false; }}
      onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); close(); } }}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-1.5 in-data-[keyboard-open]:py-0.5">
        {severe ? <AlertTriangle size={14} aria-hidden="true" className="shrink-0" />
          : <Info size={14} aria-hidden="true" className={cn('shrink-0', leaseExpired ? 'text-warn-ink' : 'text-muted')} />}
        <span className="min-w-0 flex-1 leading-4 in-data-[keyboard-open]:truncate" title={labels.map((label) => label.text).join(' · ')}>
          {labels.map(({ role, text }, index) => <span key={text}>{index > 0 ? <span aria-hidden="true"> · </span> : null}<span role={role}>{text}</span></span>)}
        </span>
        <button
          ref={trigger}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`Ver detalles: ${labels.map((label) => label.text).join('. ')}`}
          onClick={() => { setOpen(!open); }}
          className="flex min-h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 font-medium text-inherit hover:bg-muted-bg"
        >
          <span className="in-data-[keyboard-open]:sr-only">Detalles</span><ChevronDown size={14} aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open ? (
        <section id={panelId} aria-label="Detalles de los avisos" className="mx-auto grid max-w-3xl gap-2 px-4 pt-1 pb-3 text-[13px] text-fg-2">
          <h3 ref={heading} tabIndex={-1} className="m-0 text-[13px] font-semibold text-fg outline-none">Avisos de la conversación</h3>
          {queueAttention ? <p className="m-0">Hay entregas que necesitan atención. <a href="/queues" className="text-brand-ink" onClick={(event) => { onNavClick(event, '/queues'); }}>Revisar en Colas</a></p> : null}
          {queueError ? (
            <p className="m-0 flex flex-wrap items-center gap-2">
              <span>No se pudo actualizar la cola: {queueError.message}. Estado sin verificar.</span>
              <button className="button small secondary" type="button" onClick={onQueueReload}>Reintentar cola</button>
            </p>
          ) : null}
          {feedError ? <p className="m-0">No se pudo actualizar la conversación: {feedError.message}. Se muestra el último historial recibido.</p> : null}
          {leaseWarning ? <p role="note" className="m-0">{leaseWarning}</p> : null}
          {topologyWarning ? <p role="note" className="m-0">{topologyWarning}</p> : null}
          <div><button type="button" onClick={close} aria-label="Cerrar avisos" className="button small secondary">Ocultar</button></div>
        </section>
      ) : null}
    </div>
  );
}
