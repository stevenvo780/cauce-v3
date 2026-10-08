import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { Ellipsis, Star } from 'lucide-react';
import { Fragment, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from 'react';
import { cn } from '../../cn';
import { onNavClick } from '../../router';
import { AgentOrb } from '../AgentOrb';
import { MENU_ITEM, MENU_POPUP } from '../kit';
import { agentKey, isContextMenuKey, openContextMenuAt, type AgentActionId, type AgentRef } from './agent-actions';
import { useAgentPreferences } from './preferences-context';
import { useAgentActions } from './use-agent-actions';

/**
 * The agent's actions as menu rows. Context Menu reuses Menu's item parts, so the right-click menu
 * and the kebab draw exactly the same list.
 */
export function AgentActionItems({ agent, omit, header = true }: { agent: AgentRef; omit?: readonly AgentActionId[]; header?: boolean }) {
  const { actions, run } = useAgentActions(agent, omit);
  return (
    <>
      {header ? (
        <div className="mb-1 flex items-center gap-2 border-b border-line px-2.5 pt-1.5 pb-2">
          <AgentOrb seed={agentKey(agent)} size={20} />
          <span className="min-w-0 truncate text-[13px] font-semibold">{agent.alias}</span>
          <span className="ml-auto truncate text-[11px] text-muted">{agent.tenantId}</span>
        </div>
      ) : null}
      {actions.map((action, index) => {
        const Icon = action.icon;
        const separator = index > 0 && actions[index - 1].section !== action.section
          ? <Menu.Separator className="my-1 h-px bg-line" /> : null;
        const body = (
          <>
            <Icon size={15} aria-hidden="true" className={cn('shrink-0 text-muted', action.reason && 'mt-0.5')} />
            {action.reason ? (
              <span className="grid min-w-0">
                <span>{action.label}</span>
                <span className="text-[11px] leading-snug text-muted">{action.reason}</span>
              </span>
            ) : action.label}
          </>
        );
        const { href } = action;
        return (
          <Fragment key={action.id}>
            {separator}
            {href ? (
              <Menu.LinkItem href={href} closeOnClick className={MENU_ITEM} data-action={action.id}
                onClick={(event) => { onNavClick(event, href); }}>
                {body}
              </Menu.LinkItem>
            ) : (
              <Menu.Item className={cn(MENU_ITEM, action.reason && 'items-start py-1.5')} disabled={action.disabled} data-action={action.id}
                onClick={() => { run(action); }}>
                {body}
              </Menu.Item>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

const KEBAB = 'relative grid size-7 shrink-0 cursor-pointer pointer-coarse:after:absolute pointer-coarse:after:-inset-2 place-items-center rounded-md border-0 bg-transparent text-muted transition-opacity hover:bg-muted-bg hover:text-fg data-[popup-open]:bg-muted-bg data-[popup-open]:text-fg';

/** The «⋯» button: always there on touch, revealed by hover or focus on a desktop row (`reveal`). */
export function AgentKebab({ agent, omit, className, reveal = false, label, triggerRef, tabIndex, children }: {
  agent: AgentRef;
  omit?: readonly AgentActionId[];
  className?: string;
  reveal?: boolean;
  label?: string;
  triggerRef?: Ref<HTMLButtonElement>;
  tabIndex?: number;
  /** Surface-specific rows drawn after the agent's own actions. */
  children?: ReactNode;
}) {
  const name = label ?? `Acciones de ${agent.alias}`;
  return (
    <Menu.Root>
      <Menu.Trigger ref={triggerRef} aria-label={name} title={name} tabIndex={tabIndex} data-agent-kebab="" onClick={(event) => { event.stopPropagation(); }}
        className={cn(KEBAB, reveal && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100 pointer-coarse:opacity-100', className)}>
        <Ellipsis size={16} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50">
          <Menu.Popup className={cn(MENU_POPUP, 'menu-pop w-64')}>
            <AgentActionItems agent={agent} omit={omit} />
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Shift+F10 and the ContextMenu key open the same menu as a right click, at the focused element. */
function openContextMenuFromKeyboard(event: KeyboardEvent<HTMLElement>): void {
  if (!isContextMenuKey(event)) return;
  event.preventDefault();
  const target = event.target instanceof HTMLElement ? event.target : event.currentTarget;
  const rect = target.getBoundingClientRect();
  openContextMenuAt(target, rect.left + Math.min(24, rect.width / 2), rect.bottom);
}

type TriggerProps = Omit<ComponentProps<typeof ContextMenu.Trigger>, 'render' | 'children'>;

/** Right click, long press or Shift+F10 anywhere inside `children` opens the agent's actions. */
export function AgentContextMenu({ agent, omit, render, children, onKeyDown, onTouchStart, onTouchEnd, onTouchCancel, ...props }: TriggerProps & {
  agent: AgentRef;
  omit?: readonly AgentActionId[];
  render?: ReactElement;
  children?: ReactNode;
}) {
  // Base UI opens on its own long-press timer; the finger then lifts over the link or the item now under it.
  const touching = useRef(false);
  const swallowRelease = useRef(false);
  return (
    <ContextMenu.Root onOpenChange={(open) => { if (open && touching.current) swallowRelease.current = true; }}>
      <ContextMenu.Trigger {...props} render={render}
        onKeyDown={(event) => { onKeyDown?.(event); openContextMenuFromKeyboard(event); }}
        onTouchStart={(event) => { touching.current = true; swallowRelease.current = false; onTouchStart?.(event); }}
        onTouchCancel={(event) => { touching.current = false; swallowRelease.current = false; onTouchCancel?.(event); }}
        onTouchEnd={(event) => {
          touching.current = false;
          onTouchEnd?.(event);
          if (!swallowRelease.current) return;
          swallowRelease.current = false;
          event.preventDefault();
        }}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none">
          <ContextMenu.Popup className={cn(MENU_POPUP, 'menu-pop w-64')}>
            <AgentActionItems agent={agent} omit={omit} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The star on a row: one click to pin the agent above the rest, with a small burst when it lands. */
export function FavoriteStar({ agent, className, tabIndex }: { agent: AgentRef; className?: string; tabIndex?: number }) {
  const preferences = useAgentPreferences();
  const [burst, setBurst] = useState(0);
  if (preferences?.status !== 'ready') return null;
  const key = agentKey(agent);
  const on = preferences.favorites.has(key);
  const label = on ? `Quitar a ${agent.alias} de favoritos` : `Agregar a ${agent.alias} a favoritos`;
  return (
    <button type="button" aria-pressed={on} aria-label={label} title={label} tabIndex={tabIndex} data-favorite-star=""
      aria-disabled={preferences.pending.has(key) || undefined}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (preferences.pending.has(key)) return;
        if (!on) setBurst((n) => n + 1);
        preferences.toggleFavorite(agent);
      }}
      className={cn(KEBAB, 'relative', className)}>
      <Star size={14} aria-hidden="true" className={cn('transition-transform', on && 'scale-110 fill-warn text-warn')} />
      {burst ? <span key={burst} className="sparkle-burst" aria-hidden="true" /> : null}
    </button>
  );
}
