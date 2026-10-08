import {
  Building2, Copy, MessageSquareText, MonitorPlay, Palette, SquareTerminal, Star, StarOff, UserRound, type LucideIcon,
} from 'lucide-react';
import type { PermissionState } from '../../lib';

export interface AgentRef {
  tenantId: string;
  alias: string;
}

export type AgentActionId = 'chat' | 'tui' | 'terminal' | 'office' | 'context' | 'appearance' | 'favorite' | 'copy';

export interface AgentAction {
  id: AgentActionId;
  label: string;
  icon: LucideIcon;
  /** Navigation actions are links, so middle-click and "open in a new tab" keep working. */
  href?: string;
  disabled: boolean;
  /** Why it is disabled, said in the menu itself: a disabled item cannot show a tooltip. */
  reason?: string;
  section: 'open' | 'agent';
}

export interface AgentActionContext {
  /** `undefined` while favorites cannot be read or written. */
  favorite: boolean | undefined;
  favoriteReason?: string;
  appearance: PermissionState;
  /** Set when the appearance cannot be edited from this surface at all, whatever the permission. */
  appearanceUnavailable?: string;
  /** Set when the server's PTY inventory has no destination for this agent. */
  ptyUnavailable?: string;
  /** Actions that would only repeat what the surface already is, e.g. «Abrir chat» inside the chat. */
  omit?: readonly AgentActionId[];
}

/** The same identity key the orb seeds from and the office uses: `tenant/alias`. */
export function agentKey(agent: AgentRef): string {
  return `${agent.tenantId}/${agent.alias}`;
}

export function agentPaths(agent: AgentRef) {
  const base = `${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}`;
  return {
    chat: `/messages/${base}`,
    tui: `/terminal/${base}?modo=tui`,
    terminal: `/terminal/${base}?modo=terminal`,
    office: `/live?agente=${encodeURIComponent(agentKey(agent))}`,
    context: `/messages/${base}?view=context`,
  } as const;
}

export const APPEARANCE_DENIED_REASON = 'Tu cuenta no tiene config.write: solo quien configura la flota cambia el icono.';
export const FAVORITES_UNAVAILABLE_REASON = 'Los favoritos todavía no se pudieron leer del servidor.';

function ptyAction(id: 'tui' | 'terminal', label: string, icon: LucideIcon, href: string, unavailable: string | undefined): AgentAction {
  return unavailable === undefined
    ? { id, label, icon, href, disabled: false, section: 'open' }
    : { id, label, icon, disabled: true, reason: unavailable, section: 'open' };
}

/** The one list of what can be done with an agent: every menu, kebab and context menu draws it. */
export function agentActions(agent: AgentRef, context: AgentActionContext): AgentAction[] {
  const paths = agentPaths(agent);
  const favoriteKnown = context.favorite !== undefined;
  const all: AgentAction[] = [
    { id: 'chat', label: 'Abrir chat', icon: MessageSquareText, href: paths.chat, disabled: false, section: 'open' },
    ptyAction('tui', 'Abrir TUI', MonitorPlay, paths.tui, context.ptyUnavailable),
    ptyAction('terminal', 'Abrir terminal', SquareTerminal, paths.terminal, context.ptyUnavailable),
    { id: 'office', label: 'Ver en la oficina', icon: Building2, href: paths.office, disabled: false, section: 'open' },
    { id: 'context', label: 'Perfil y contexto', icon: UserRound, href: paths.context, disabled: false, section: 'open' },
    {
      id: 'appearance', label: 'Personalizar icono…', icon: Palette, section: 'agent',
      disabled: context.appearanceUnavailable !== undefined || context.appearance === 'denied',
      reason: context.appearanceUnavailable ?? (context.appearance === 'denied' ? APPEARANCE_DENIED_REASON : undefined),
    },
    {
      id: 'favorite', section: 'agent',
      label: context.favorite ? 'Quitar de favoritos' : 'Agregar a favoritos',
      icon: context.favorite ? StarOff : Star,
      disabled: !favoriteKnown,
      reason: favoriteKnown ? undefined : context.favoriteReason ?? FAVORITES_UNAVAILABLE_REASON,
    },
    { id: 'copy', label: 'Copiar alias', icon: Copy, disabled: false, section: 'agent' },
  ];
  const omit = new Set(context.omit ?? []);
  return all.filter((action) => !omit.has(action.id));
}

/** Shift+F10 and the ContextMenu key are the keyboard's right click. */
export function isContextMenuKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}

/** A synthetic right click: Base UI's context menu opens wherever it lands. */
export function openContextMenuAt(target: Element, clientX: number, clientY: number): void {
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX, clientY }));
}

/** Curated picks for the icon grid; any other single emoji, letter or digit can be typed. */
export const APPEARANCE_GLYPHS = [
  '🦉', '🦊', '🐙', '🐝', '🐢', '🦄', '🐳', '🦁', '🐼', '🐧', '🌵', '🍄',
  '🌙', '⭐', '⚡', '🔥', '🌊', '🍀', '🚀', '🤖', '🧠', '🎯', '🧪', '🎨',
  '📚', '🔭', '🧭', '🛸', '🎲', '🪐', '💎', '🫧',
] as const;
