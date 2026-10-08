import { Menu } from '@base-ui/react/menu';
import { Check, Copy, MoreHorizontal, Quote, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MENU_ITEM, MENU_POPUP } from '../../components/kit';

const QUICK = 'grid size-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg';

/** Copy, quote into the composer and, for a failed own message, put its text back to send again. */
export function MessageQuickActions({ text, onQuote, onResend }: { text: string; onQuote?: () => void; onResend?: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => { setCopied(false); }, 1500);
    return () => { window.clearTimeout(timer); };
  }, [copied]);
  return (
    <>
      {text ? (
        <button type="button" className={QUICK} aria-label={copied ? 'Copiado' : 'Copiar mensaje'} title={copied ? 'Copiado' : 'Copiar'}
          onClick={() => {
            try { void navigator.clipboard.writeText(text).then(() => { setCopied(true); }, () => undefined); } catch { /* no clipboard outside a secure context */ }
          }}>
          {copied ? <Check size={15} aria-hidden="true" className="text-ok-ink" /> : <Copy size={15} aria-hidden="true" />}
        </button>
      ) : null}
      {onQuote && text ? (
        <button type="button" className={QUICK} aria-label="Citar en la respuesta" title="Citar" onClick={onQuote}>
          <Quote size={15} aria-hidden="true" />
        </button>
      ) : null}
      {onResend ? (
        <button type="button" className={QUICK} aria-label="Volver a escribir este mensaje" title="Volver a enviar" onClick={onResend}>
          <RotateCcw size={15} aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}

export function MessageActions({ disabled, onDetail, onRetry }: {
  disabled: boolean;
  /** Receives the trigger so the detail can hand focus back to it when it closes. */
  onDetail: (opener: HTMLElement | null) => void;
  onRetry?: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  // The detail takes focus itself; the closing menu must not pull it back to the trigger.
  const detailRequested = useRef(false);
  return (
    <Menu.Root
      onOpenChange={(open) => { if (open) detailRequested.current = false; }}
      onOpenChangeComplete={(open) => { if (!open && detailRequested.current) onDetail(trigger.current); }}
    >
      <Menu.Trigger
        ref={trigger}
        aria-label="Opciones del mensaje"
        disabled={disabled}
        className="grid size-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 data-[popup-open]:bg-subtle data-[popup-open]:text-fg"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup className={MENU_POPUP} finalFocus={() => !detailRequested.current}>
            <Menu.Item className={MENU_ITEM} onClick={() => { detailRequested.current = true; }}>Ver detalle</Menu.Item>
            {onRetry ? <Menu.Item className={MENU_ITEM} onClick={onRetry}>Releer respuesta</Menu.Item> : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
