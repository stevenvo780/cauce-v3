import {
  CreditCard, Gauge, LayoutDashboard, ListRestart, MessageSquareText,
  Settings2, Sparkles, TerminalSquare,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useApi } from './api/context';
import { useResource } from './api/use-resource';
import { useTerminalRelayStatus } from './features/terminal/relay-status';
import { permissionState } from './lib';
import {
  configNavAvailability,
  terminalNavAvailability,
  type NavEntryAvailability,
} from './navigation';

/**
 * **El menú, en un solo sitio.**
 *
 * Existía por duplicado: la barra lateral lo declaraba en `App.tsx` y la portada volvía a
 * escribirlo a mano en `LandingPage.tsx`. Las dos copias ya habían divergido el mismo día en que
 * nacieron —la portada llamaba «Configuration» a lo que el menú llama «Ajustes y altas», y
 * se olvidaba entera de «Ultimate Terminal»—, y el rótulo del panel decía «Ocho vistas» porque
 * alguien las contó con el dedo. Un rótulo contado a mano miente en cuanto se agrega una entrada,
 * y el recuento de acá se DERIVA de la lista.
 *
 * `que` es lo que la portada añade sobre la barra lateral: la pregunta que responde cada vista.
 * Vive acá, junto al rótulo, para que agregar una entrada obligue a decir para qué sirve.
 */
export interface NavEntry {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  /** La pregunta que responde la vista. Sólo lo usa la portada. */
  que: string;
}

/**
 * Entradas de navegación principal con rótulo visible. Las rutas ocultas viven en `App.tsx`.
 * Cada `id` debe existir en `PAGES` y no puede ser clave de `ROUTE_ALIASES`.
 */
export const NAV_ENTRIES: NavEntry[] = [
  { id: '', label: 'Portada', icon: LayoutDashboard, que: 'El resumen de conjunto: flota, colas, cuotas y lo que exige atención.' },
  { id: 'live', label: 'La flota ahora', icon: Sparkles, que: 'Quién está trabajando, quién está trabado y quién le delegó a quién, en vivo.' },
  { id: 'accounts', label: 'Cuentas y cuotas', icon: CreditCard, que: 'El registro de cuentas, qué agente usa cada una y cuánto saldo le queda.' },
  { id: 'messages', label: 'Mensajes', icon: MessageSquareText, que: 'La conversación con cada agente y el estado de cada entrega.' },
  { id: 'queues', label: 'Queues & DLQ', icon: ListRestart, que: 'Cada entrega pendiente, en reintento o muerta, con reinyectar y cancelar.' },
  { id: 'observability', label: 'Señales y auditoría', icon: Gauge, que: 'Las señales del gateway, el egress al origen y quién autorizó cada cosa.' },
  { id: 'config', label: 'Ajustes y altas', icon: Settings2, que: 'Tenants, salas, membresías, roles y altas — con reversión por revisión.' },
  { id: 'terminal', label: 'Terminal de agentes', icon: TerminalSquare, que: 'La terminal de cada bot, con su feed durable aunque el relay PTY no esté.' },
];

/**
 * **La única respuesta a «¿este usuario puede abrir esta vista?».**
 *
 * Vivía dentro de `ConsoleShell`, así que sólo la barra lateral podía preguntarlo, y la portada
 * —que es la PRIMERA pantalla de todo el mundo— ofrecía como enlace vivo exactamente lo que la
 * barra dejaba inerte tres centímetros más a la izquierda. Un menú honesto y una portada que
 * miente son, para quien hace clic, una consola que miente. Está acá, y no en `navigation.ts`,
 * porque es un hook: lee el RBAC y el relay, no es una función pura.
 *
 * Las dos lecturas comparten clave de caché con las páginas que ya las piden (`console-access`,
 * y el sondeo del relay), así que montar esto en dos sitios no agrega peticiones.
 */
export function useNavAvailability(): (id: string) => NavEntryAvailability {
  const api = useApi();
  const access = useResource('console-access', () => api.getConsoleAccess());
  const relay = useTerminalRelayStatus();
  return (id: string): NavEntryAvailability => {
    if (id === 'terminal') return terminalNavAvailability(relay);
    if (id === 'config') return configNavAvailability(permissionState(access.data, 'config.write'));
    return { hidden: false, disabled: false };
  };
}
