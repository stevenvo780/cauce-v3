import { MoreHorizontal } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';

export function ConversationMenu({ children, triggerRef }: {
  children: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); };
  }, [open]);
  return <div className="chat-more" ref={container} onKeyDown={(event) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" className="button small secondary" ref={triggerRef}
      aria-expanded={open} aria-controls={id} onClick={() => { setOpen(!open); }}>
      <MoreHorizontal size={18} aria-hidden="true" /><span>Más</span>
    </button>
    {open ? <section id={id} className="chat-more-panel" aria-label="Más opciones de conversación">{children}</section> : null}
  </div>;
}
