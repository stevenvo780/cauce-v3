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
 * Las entradas CON rótulo: la portada más siete. Las rutas ocultas viven en `App.tsx`.
 *
 * **Este es el menú final del 2026-08-22**, después de tres retiradas y dos fusiones sobre las once
 * entradas que había: se fue «Jobs» (cero filas en la tabla desde que existe la base), se plegó
 * «Adapters» en la portada, «Cuotas y licencias» se fundió en «Cuentas y cuotas» y «Audit» en
 * «Señales y auditoría». Cada retirada dejó su alias en `ROUTE_ALIASES` (`App.tsx`), o su aviso
 * cuando no hay heredera.
 *
 * 🔴 **El `id` de cada entrada tiene que estar en `PAGES` y NO puede ser una clave de
 * `ROUTE_ALIASES`.** Un id sin página se monta como `undefined` y un id tapado por un alias no se
 * alcanza nunca: las dos cosas fallan sin un error, y por eso las guarda la tabla de
 * `App.invariantes.test.tsx` y no la buena voluntad de quien edite esta lista.
 */
export const NAV_ENTRIES: NavEntry[] = [
  { id: '', label: 'Portada', icon: LayoutDashboard, que: 'El resumen de conjunto: flota, colas, cuotas y lo que exige atención.' },
  { id: 'live', label: 'La flota ahora', icon: Sparkles, que: 'Quién está trabajando, quién está trabado y quién le delegó a quién, en vivo.' },
  { id: 'accounts', label: 'Cuentas y cuotas', icon: CreditCard, que: 'El registro de cuentas, qué agente usa cada una y cuánto saldo le queda.' },
  { id: 'messages', label: 'Mensajes', icon: MessageSquareText, que: 'La conversación con cada agente y el estado de cada entrega.' },
  { id: 'queues', label: 'Queues & DLQ', icon: ListRestart, que: 'Cada entrega pendiente, en reintento o muerta, con reinyectar y cancelar.' },
  { id: 'observability', label: 'Señales y auditoría', icon: Gauge, que: 'Las señales del gateway, el egress al origen y quién autorizó cada cosa.' },
  // 'Configuración y altas' -> 'Ajustes y altas' (2026-08-23). Con la letra de la barra movil
  // a 11 px, 'Configuración' sola mide 85,8 px y la celda da 68/78/85 px en 320/360/390: NO
  // entra en NINGUN ancho, asi que el navegador la partia a mitad de palabra ('Configurac' /
  // 'ión y altas'). 'Ajustes' mide 45,9 px y entra en los tres con holgura.
  // OJO AL METODO: esto NO lo caza scrollWidth > clientWidth, porque `overflow-wrap:break-word`
  // evita el desborde partiendo la palabra. La prueba automatica siempre dara 0. Se vio MIRANDO
  // la barra renderizada. Si volves a tocar el tamano de letra, mira la barra, no midas el ancho.
  { id: 'config', label: 'Ajustes y altas', icon: Settings2, que: 'Tenants, salas, membresías, roles y altas — con reversión por revisión.' },
  { id: 'terminal', label: 'Ultimate Terminal', icon: TerminalSquare, que: 'La terminal de cada bot, con su feed durable aunque el relay PTY no esté.' },
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
