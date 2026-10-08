import { Menu } from '@base-ui/react/menu';
import { BookOpen, Ellipsis, Hourglass, PowerOff, RefreshCw } from 'lucide-react';
import { cn } from '../../cn';
import type { AgentRef } from '../../components/agent-actions/agent-actions';
import { AgentActionItems } from '../../components/agent-actions/AgentActionsMenu';
import { MENU_ITEM } from '../../components/kit';

const ITEM = cn(MENU_ITEM, '[&_svg]:text-muted');

/** Secondary actions of the open session. Every one that touches the PTY plane needs a live grant. */
export function StageMenu({ agent, hasGrant, canExtend, extending, onExtend, onClose, onRefresh, summary }: {
  agent?: AgentRef;
  hasGrant: boolean;
  canExtend: boolean;
  extending: boolean;
  onExtend: () => void;
  onClose: () => void;
  onRefresh: () => void;
  summary: string;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Más acciones"
        className="grid size-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg data-[popup-open]:bg-muted-bg"
      >
        <Ellipsis size={17} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={6} className="z-50">
          <Menu.Popup className="menu-pop w-64 rounded-lg border border-line bg-surface p-1 shadow-pop outline-none">
            <Menu.Item
              className={ITEM}
              disabled={!canExtend || extending}
              onClick={onExtend}
              title={canExtend ? 'Prorrogar la ventana de esta sesión con auditoría' : 'Disponible cuando el relay ya enganchó y consumió el ticket'}
            >
              <Hourglass size={15} aria-hidden="true" />{extending ? 'Prorrogando sesión…' : 'Prorrogar sesión'}
            </Menu.Item>
            <Menu.Item className={cn(ITEM, 'data-[highlighted]:text-danger-ink')} disabled={!hasGrant} onClick={onClose}
              title="Revoca la sesión PTY en el servidor y cierra el canal">
              <PowerOff size={15} aria-hidden="true" />Cerrar sesión PTY
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.Item className={ITEM} onClick={onRefresh}>
              <RefreshCw size={15} aria-hidden="true" />Actualizar flota y permisos
            </Menu.Item>
            <Menu.LinkItem className={ITEM} href="/ayuda#terminal">
              <BookOpen size={15} aria-hidden="true" />Docs
            </Menu.LinkItem>
            {agent ? (
              <>
                <Menu.Separator className="my-1 h-px bg-line" />
                <Menu.Group>
                  <Menu.GroupLabel className="px-2.5 pt-1 pb-0.5 text-[11px] font-medium text-muted">{agent.alias}</Menu.GroupLabel>
                  <AgentActionItems agent={agent} omit={['tui', 'terminal']} header={false} />
                </Menu.Group>
              </>
            ) : null}
            <p className="m-0 mt-1 border-t border-line px-2.5 pt-2 pb-1.5 text-xs text-muted">{summary}</p>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
