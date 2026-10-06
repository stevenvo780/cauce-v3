import { Menu } from '@base-ui/react/menu';
import { MoreHorizontal } from 'lucide-react';
import { useRef } from 'react';
import { MENU_ITEM, MENU_POPUP } from '../../components/kit';

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
