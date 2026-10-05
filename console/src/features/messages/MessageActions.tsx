import { MoreHorizontal } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

export function MessageActions({ disabled, onDetail, onRetry }: { disabled: boolean; onDetail: () => void; onRetry?: () => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    action.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); };
  }, [open]);
  return <div className="chat-message-actions" ref={root} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    }
  }}>
    <button type="button" className="chat-message-menu-trigger" aria-label="Opciones del mensaje"
      ref={trigger} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setOpen(!open); }}><MoreHorizontal size={18} aria-hidden="true" /></button>
    {open ? <div className="chat-message-menu" role="menu" id={id} aria-label="Acciones del mensaje">
      <button type="button" role="menuitem" ref={action} onClick={() => {
        trigger.current?.focus({ preventScroll: true });
        onDetail();
        setOpen(false);
      }}>Ver detalle</button>
      {onRetry ? <button type="button" role="menuitem" onClick={() => { onRetry(); setOpen(false); }}>Releer respuesta</button> : null}
    </div> : null}
  </div>;
}
