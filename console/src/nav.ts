import {
  BookOpen, Building2, CreditCard, Gauge, ListRestart, MessageSquareText,
  Settings2, TerminalSquare,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useTerminalRelayStatus } from './features/terminal/relay-status';
import {
  terminalNavAvailability,
  type NavEntryAvailability,
} from './router';

/**
 * Centralized definition of the console main menu entries.
 */
interface NavEntry {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}

/**
 * Main navigation entries with a visible label. Hidden routes live in `App.tsx`.
 * Each `id` must exist in `PAGES` and cannot be a key of `ROUTE_ALIASES`.
 */
export const PRIMARY_NAV_IDS: readonly string[] = ['messages', 'live', 'terminal'];

export const NAV_ENTRIES: NavEntry[] = [
  { id: 'messages', label: 'Chat', icon: MessageSquareText },
  { id: 'live', label: 'Oficina', icon: Building2 },
  { id: 'accounts', label: 'Cuentas y cuotas', icon: CreditCard },
  { id: 'queues', label: 'Colas y DLQ', icon: ListRestart },
  { id: 'observability', label: 'Señales y auditoría', icon: Gauge },
  { id: 'config', label: 'Ajustes', icon: Settings2 },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'ayuda', label: 'Ayuda', icon: BookOpen },
];

/**
 * Hook to determine the availability and permissions of each navigation route.
 */
export function useNavAvailability(): (id: string) => NavEntryAvailability {
  const relay = useTerminalRelayStatus();
  return (id: string): NavEntryAvailability => {
    if (id === 'terminal') return terminalNavAvailability(relay);
    return { hidden: false, disabled: false };
  };
}
