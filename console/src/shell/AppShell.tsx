import { Dialog } from '@base-ui/react/dialog';
import { ChevronDown, Ellipsis, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { BOTTOM_BAR_VIEWPORT, RAIL_VIEWPORT } from '../breakpoints';
import { Logo, LogoMark } from '../components/brand/Logo';
import { cn } from '../cn';
import { NAV_ENTRIES, PRIMARY_NAV_IDS, useNavAvailability } from '../nav';
import { onNavClick } from '../router';
import { AgentList } from './AgentList';
import { useChatNavTarget, useTerminalNavTarget } from './last-chat';
import { useMediaQuery } from './use-media-query';

const SIDEBAR_SHORTCUT = 'Alt+Shift+B';
const PRIMARY = new Set(PRIMARY_NAV_IDS);

function NavLink({ id, routeId, rail, onNavigate }: { id: string; routeId: string; rail: boolean; onNavigate?: () => void }) {
  const availability = useNavAvailability()(id);
  const chatTarget = useChatNavTarget();
  const terminalTarget = useTerminalNavTarget();
  const entry = NAV_ENTRIES.find((item) => item.id === id);
  if (!entry || availability.hidden) return null;
  const Icon = entry.icon;
  const current = routeId === id;
  const target = id === 'messages' ? chatTarget : id === 'terminal' ? terminalTarget : `/${id}`;
  return (
    <a
      href={target}
      aria-current={current ? 'page' : undefined}
      aria-disabled={availability.disabled || undefined}
      aria-label={rail ? entry.label : undefined}
      title={availability.reason ?? (rail ? entry.label : undefined)}
      onClick={(event) => { onNavClick(event, target, availability.reason); if (!availability.reason) onNavigate?.(); }}
      className={cn(
        'flex items-center gap-2.5 rounded-lg text-[13px] font-medium no-underline transition-colors',
        rail ? 'size-10 justify-center' : 'px-2.5 py-1.5',
        current ? 'bg-muted-bg text-fg' : 'text-fg-2 hover:bg-subtle hover:text-fg',
        availability.disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <Icon size={17} aria-hidden={true} />
      {rail ? null : <span>{entry.label}</span>}
    </a>
  );
}

function Sidebar({ routeId, activeAgentId, rail, collapsible, onToggle, footer }: {
  routeId: string;
  activeAgentId?: string;
  rail: boolean;
  collapsible: boolean;
  onToggle: () => void;
  footer: ReactNode;
}) {
  const secondaryActive = !PRIMARY.has(routeId);
  const [toolsOpen, setToolsOpen] = useState(secondaryActive);
  useEffect(() => { if (secondaryActive) setToolsOpen(true); }, [secondaryActive]);
  const secondary = NAV_ENTRIES.filter((item) => !PRIMARY.has(item.id));
  return (
    <aside
      className={cn(
        'sticky top-0 z-20 flex h-dvh shrink-0 flex-col border-r border-line bg-surface',
        rail ? 'w-16 items-center' : 'w-[272px]',
      )}
    >
      <div className={cn('flex h-14 shrink-0 items-center', rail ? 'justify-center' : 'justify-between px-4')}>
        <a href="/messages" onClick={(event) => { onNavClick(event, '/messages'); }} className="no-underline" aria-label="Cauce, ir al chat">
          {rail ? <LogoMark size={30} live /> : <Logo live />}
        </a>
        {collapsible && !rail ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label="Plegar barra lateral"
            aria-keyshortcuts={SIDEBAR_SHORTCUT}
            title={`Plegar barra lateral (${SIDEBAR_SHORTCUT})`}
            className="grid size-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg"
          >
            <PanelLeftClose size={17} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {collapsible && rail ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label="Desplegar barra lateral"
          aria-keyshortcuts={SIDEBAR_SHORTCUT}
          title={`Desplegar barra lateral (${SIDEBAR_SHORTCUT})`}
          className="mb-1 grid size-10 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg"
        >
          <PanelLeftOpen size={17} aria-hidden="true" />
        </button>
      ) : null}
      <nav aria-label="Navegación principal" className={cn('shrink-0', rail ? 'grid justify-items-center gap-1' : 'grid gap-0.5 px-2')}>
        {PRIMARY_NAV_IDS.map((id) => <NavLink key={id} id={id} routeId={routeId} rail={rail} />)}
        {rail ? (
          <>
            <span className="my-1 h-px w-8 bg-line" aria-hidden="true" />
            {secondary.map((item) => <NavLink key={item.id} id={item.id} routeId={routeId} rail />)}
          </>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={toolsOpen}
              aria-controls="nav-gestion"
              onClick={() => { setToolsOpen(!toolsOpen); }}
              className="mt-2 flex cursor-pointer items-center justify-between rounded-lg border-0 bg-transparent px-2.5 py-1 text-xs font-medium text-muted hover:text-fg"
            >
              Gestión
              <ChevronDown size={14} aria-hidden="true" className={cn('transition-transform', toolsOpen && 'rotate-180')} />
            </button>
            <div id="nav-gestion" hidden={!toolsOpen} className="grid gap-0.5">
              {secondary.map((item) => <NavLink key={item.id} id={item.id} routeId={routeId} rail={false} />)}
            </div>
          </>
        )}
      </nav>
      <div className={cn('mt-3 flex min-h-0 flex-1 flex-col border-t border-line pt-3', rail && 'w-full')}>
        <AgentList routeId={routeId} activeId={activeAgentId} rail={rail} />
      </div>
      <div
        className={cn(
          'shrink-0 border-t border-line p-2',
          rail && 'flex w-full justify-center [&_.account-chevron]:hidden [&_.account-name]:hidden [&_.mock-flag]:hidden',
        )}
      >
        {footer}
      </div>
    </aside>
  );
}

function BottomBar({ routeId, account }: { routeId: string; account: ReactNode }) {
  const [open, setOpen] = useState(false);
  const secondary = NAV_ENTRIES.filter((item) => !PRIMARY.has(item.id));
  const secondaryActive = !PRIMARY.has(routeId);
  const chatTarget = useChatNavTarget();
  const terminalTarget = useTerminalNavTarget();
  return (
    <nav
      aria-label="Navegación principal"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      {PRIMARY_NAV_IDS.map((id) => {
        const entry = NAV_ENTRIES.find((item) => item.id === id);
        if (!entry) return null;
        const Icon = entry.icon;
        const current = routeId === id;
        const target = id === 'messages' ? chatTarget : id === 'terminal' ? terminalTarget : `/${id}`;
        return (
          <a
            key={id}
            href={target}
            aria-current={current ? 'page' : undefined}
            onClick={(event) => { onNavClick(event, target); }}
            className={cn('flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium no-underline', current ? 'text-brand-ink' : 'text-muted')}
          >
            <Icon size={20} aria-hidden={true} />
            {entry.label}
          </a>
        );
      })}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger
          aria-current={secondaryActive ? 'true' : undefined}
          className={cn('flex h-14 cursor-pointer flex-col items-center justify-center gap-0.5 border-0 bg-transparent text-[11px] font-medium', secondaryActive ? 'text-brand-ink' : 'text-muted')}
        >
          <Ellipsis size={20} aria-hidden="true" />
          Más
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
          <Dialog.Popup className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-pop">
            <div className="mb-3 flex items-center justify-between">
              <Dialog.Title className="m-0 text-[15px] font-semibold">Gestión</Dialog.Title>
              <Dialog.Close aria-label="Cerrar" className="grid size-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle">
                <X size={18} aria-hidden="true" />
              </Dialog.Close>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {secondary.map((item) => <NavLink key={item.id} id={item.id} routeId={routeId} rail={false} onNavigate={() => { setOpen(false); }} />)}
            </div>
            <div className="mt-3 border-t border-line pt-3">{account}</div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </nav>
  );
}

/**
 * One sidebar on desktop (sections + the agent roster + account), an icon rail on tablets and a
 * bottom bar on phones. The roster lives here so the chat and the terminal stop drawing their own.
 */
export function AppShell({ routeId, activeAgentId, bounded = false, account, notices, children }: {
  routeId: string;
  /** The page owns its scroll areas: the column is exactly one viewport tall. */
  bounded?: boolean;
  activeAgentId?: string;
  account: ReactNode;
  notices?: ReactNode;
  children: ReactNode;
}) {
  const phone = useMediaQuery(BOTTOM_BAR_VIEWPORT);
  const tablet = useMediaQuery(RAIL_VIEWPORT);
  const [collapsed, setCollapsed] = useState(false);
  const rail = tablet || collapsed;
  const toggle = useCallback(() => { setCollapsed((value) => !value); }, []);

  useEffect(() => {
    if (tablet) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyB' || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], .xterm')) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [tablet, toggle]);

  return (
    <div
      className="flex min-h-dvh bg-canvas text-fg [&:has([data-keyboard-open])_nav[aria-label='Navegación principal']]:hidden"
      data-sidebar={phone ? 'bottom' : rail ? 'rail' : 'expanded'}
    >
      <a
        href="#main-content"
        className="fixed top-3 left-3 z-[100] -translate-y-[200%] rounded-md bg-fg px-3 py-2 text-sm font-medium text-canvas focus:translate-y-0"
      >
        Saltar al contenido
      </a>
      {phone ? null : (
        <Sidebar
          routeId={routeId}
          activeAgentId={activeAgentId}
          rail={rail}
          collapsible={!tablet}
          onToggle={toggle}
          footer={account}
        />
      )}
      <div className={cn('flex min-w-0 flex-1 flex-col', bounded && 'h-dvh overflow-hidden')}>
        {notices}
        {children}
      </div>
      {phone ? <BottomBar routeId={routeId} account={account} /> : null}
    </div>
  );
}
