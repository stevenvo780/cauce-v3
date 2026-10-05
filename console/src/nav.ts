import {
  BookOpen, CreditCard, Gauge, LayoutDashboard, ListRestart, MessageSquareText,
  Settings2, Network, TerminalSquare,
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
  /** The question the view answers. Only the front page uses it. */
  que: string;
}

/**
 * Main navigation entries with a visible label. Hidden routes live in `App.tsx`.
 * Each `id` must exist in `PAGES` and cannot be a key of `ROUTE_ALIASES`.
 */
export const PRIMARY_NAV_IDS: readonly string[] = ['messages', 'live'];

export const NAV_ENTRIES: NavEntry[] = [
  { id: 'messages', label: 'Conversaciones', icon: MessageSquareText, que: 'La conversación con cada agente y el estado de cada entrega.' },
  { id: 'live', label: 'Grafo y actividad', icon: Network, que: 'Quién está trabajando, quién está trabado y quién le delegó a quién, en vivo.' },
  { id: 'overview', label: 'Resumen', icon: LayoutDashboard, que: 'El resumen de conjunto: flota, colas, cuotas y lo que exige atención.' },
  { id: 'accounts', label: 'Cuentas y cuotas', icon: CreditCard, que: 'El registro de cuentas, qué agente usa cada una y cuánto saldo le queda.' },
  { id: 'queues', label: 'Queues & DLQ', icon: ListRestart, que: 'Cada entrega pendiente, en reintento o muerta, con reinyectar y cancelar.' },
  { id: 'observability', label: 'Señales y auditoría', icon: Gauge, que: 'Las señales del gateway, el egress al origen y quién autorizó cada cosa.' },
  { id: 'config', label: 'Ajustes y altas', icon: Settings2, que: 'Tenants, salas, membresías, roles y altas — con reversión por revisión.' },
  { id: 'terminal', label: 'Terminal de agentes', icon: TerminalSquare, que: 'La terminal de cada bot, con su feed durable aunque el relay PTY no esté.' },
  { id: 'ayuda', label: 'Ayuda', icon: BookOpen, que: 'Qué contesta cada vista, qué significa cada estado de la flota y los atajos de teclado.' },
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
