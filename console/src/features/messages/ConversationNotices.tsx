import { ChevronDown, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { onNavClick } from '../../router';
import type { SaludDeCola } from './queue-health';

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
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusInside = useRef(false);
  const lastFocused = useRef<HTMLElement | null>(null);
  const hasQueueAttention = (health?.reintentos ?? 0) > 0 || (health?.muertas ?? 0) > 0;
  const hasNotices = Boolean(hasQueueAttention || queueError || feedError || leaseWarning || topologyWarning);
  useEffect(() => {
    if (hasNotices) return;
    setOpen(false);
    if (focusInside.current) fallbackFocusRef?.current?.focus({ preventScroll: true });
    focusInside.current = false;
  }, [hasNotices, fallbackFocusRef]);
  useEffect(() => {
    if (!open || !hasNotices) return;
    heading.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        const hadFocus = container.current?.contains(document.activeElement);
        setOpen(false);
        if (hadFocus) requestAnimationFrame(() => {
          if (document.activeElement === document.body) trigger.current?.focus({ preventScroll: true });
        });
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open, hasNotices]);
  useEffect(() => {
    const previous = lastFocused.current;
    if (open && hasNotices && focusInside.current && previous && !previous.isConnected
      && document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
  }, [open, hasNotices, queueError, feedError, leaseWarning, topologyWarning, hasQueueAttention]);
  if (!hasNotices) return null;
  const labels: { text: string; role: 'status' | 'alert' | 'note' }[] = [];
  if (hasQueueAttention) labels.push({ role: 'status', text:
    `${health?.reintentos ? `${String(health.reintentos)} reintento(s). ` : ''}`
      + `${health?.muertas ? `${health.muertasTruncadas ? '≥ ' : ''}${String(health.muertas)} muerta(s).` : ''}` });
  if (queueError) labels.push({ role: 'alert', text: 'Cola sin verificar' });
  if (feedError) labels.push({ role: 'alert', text: 'Historial anterior: sin actualizar' });
  if (leaseWarning) labels.push({ role: 'note', text: leaseExpired ? 'Lease vencido · envío en cola' : 'Lease sin dato · envío en cola' });
  if (topologyWarning) labels.push({ role: 'note', text: 'Fuera de la topología' });
  return <div ref={container} className="chat-notices"
    onFocusCapture={(event) => {
      focusInside.current = true;
      lastFocused.current = event.target instanceof HTMLElement ? event.target : null;
    }}
    onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
        focusInside.current = false;
        setOpen(false);
      }
    }}>
    <div className="chat-notice-bar">
      <span className="chat-notice-summary">{labels.map(({ role, text }) => <span key={text} role={role}>{text}</span>)}</span>
      <button type="button" ref={trigger} className="chat-notice-trigger" aria-expanded={open}
        aria-label={`Ver detalles: ${labels.map((label) => label.text).join('. ')}`}
        onClick={() => { setOpen(!open); }}>Detalles<ChevronDown size={14} aria-hidden="true" /></button>
    </div>
    {open ?     <section className="chat-notice-panel" aria-label="Detalles de los avisos">
      <header><h3 ref={heading} tabIndex={-1}>Avisos de la conversación</h3>
        <button type="button" className="button small secondary" aria-label="Cerrar avisos"
          onClick={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }}><X size={16} aria-hidden="true" /></button>
      </header>
      {hasQueueAttention ? <p>Hay entregas que necesitan atención. <a href="/queues" onClick={(event) => { onNavClick(event, '/queues'); }}>Revisar en Colas</a></p> : null}
      {queueError ? <div><p>No se pudo actualizar la cola: {queueError.message}. Estado sin verificar.</p>
        <button className="button small secondary" type="button" onClick={onQueueReload}>Reintentar cola</button></div> : null}
      {feedError ? <p>No se pudo actualizar la conversación: {feedError.message}. Se muestra el último historial recibido.</p> : null}
      {leaseWarning ? <p role="note">{leaseWarning}</p> : null}
      {topologyWarning ? <p role="note">{topologyWarning}</p> : null}
    </section> : null}
  </div>;
}
