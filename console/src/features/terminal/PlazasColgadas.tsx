import {
  AlertTriangle,
  Bot,
  PowerOff,
  RefreshCw,
  Timer,
} from 'lucide-react';
import type { TerminalSessionListItem } from './api';
import { LIVE_TUI_MODE, SHELL_MODE } from './fleet';
import { minutosParaLiberar } from './plazas';

export type MotivoReconciliacionPlaza = 'session_limit' | 'invalid_grant_receipt';

export function PlazasColgadas({ items, aLaVista, topeAlcanzado, motivo, revisando, cerrando, error, onRevisar, onCerrar }: {
  items: TerminalSessionListItem[];
  aLaVista: number;
  topeAlcanzado: boolean;
  motivo?: MotivoReconciliacionPlaza;
  revisando: boolean;
  cerrando: Record<string, true>;
  error?: string;
  onRevisar: () => void;
  onCerrar: (sessionId: string) => void;
}) {
  if (items.length === 0 && !topeAlcanzado) return null;
  const ahora = Date.now();
  const total = items.length + aLaVista;
  return (
    <section className="pty-plazas" aria-label="Sesiones de terminal que siguen ocupando plaza">
      <header>
        <AlertTriangle size={15} aria-hidden="true" />
        <div>
          <strong>
            {error
              ? 'No se pudo leer qué sesiones están ocupando el tope'
              : items.length === 0 && aLaVista === 0 && motivo === 'session_limit'
                ? 'El tope se liberó antes de terminar la verificación'
              : items.length === 0 && aLaVista === 0 && motivo === 'invalid_grant_receipt'
                ? 'El grant fue inválido y no hay una reserva visible'
              : motivo === 'invalid_grant_receipt' && items.length > 0
                ? 'El grant fue inválido; estas son las reservas visibles'
              : items.length === 0
              ? `Tope de sesiones alcanzado: las ${total} que lo gastan están abiertas acá`
              : items.length === 1
                ? 'Una sesión tuya sigue ocupando plaza fuera de esta pantalla'
                : `${items.length} sesiones tuyas siguen ocupando plaza fuera de esta pantalla`}
          </strong>
          <p>
            {error
              ? items.length === 0
                ? 'El inventario del gateway no es verificable. No se infiere que haya cero sesiones ni que todas estén abiertas en esta pantalla. Reintentá la lectura antes de decidir qué cerrar.'
                : `No se pudo actualizar el inventario. Las ${items.length} filas de abajo son el último inventario verificable y pueden estar desactualizadas; no prueban cuántas plazas siguen ocupadas ahora.`
              : items.length === 0 && aLaVista === 0 && motivo === 'session_limit'
                ? 'El POST recibió 409, pero el GET exacto posterior ya no encontró ninguna sesión ocupando plaza. Hubo una liberación concurrente: no hay nada que cerrar y podés reintentar la apertura.'
              : items.length === 0 && aLaVista === 0 && motivo === 'invalid_grant_receipt'
                ? 'No se revocó el session_id del recibo roto porque no era confiable. El inventario exacto posterior no muestra una reserva que puedas cerrar; reintentá sólo después de releer si el estado cambia.'
              : motivo === 'invalid_grant_receipt' && items.length > 0
                ? 'No se usó el session_id del recibo roto para borrar nada. Las filas de abajo vienen del GET exacto posterior: cerrá una sólo si reconocés que esa reserva ya no debe seguir viva.'
              : items.length === 0
              ? 'El tope de sesiones simultáneas es por operador y ya lo gastaste con las pestañas de arriba. '
                + 'Cerrá una con su aspa y volvé a pedir la que querías: se libera al instante.'
              : 'El tope de sesiones simultáneas es por operador, así que estas cuentan aunque su pestaña ya no exista '
                + '—otra ventana, un cierre a lo bruto, una recarga a destiempo—. Mientras sigan vivas, abrir otra TUI '
                + 'devuelve 409. Se sueltan solas al vencer; el botón las suelta ahora.'}
          </p>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </div>
        <button className="button small secondary" type="button" onClick={onRevisar} disabled={revisando}>
          <RefreshCw size={13} aria-hidden="true" /> {revisando ? 'Revisando…' : 'Revisar'}
        </button>
      </header>
      {items.length === 0 ? null : (
      <ul>
        {items.map((item) => (
          <li key={item.session_id}>
            <span className="pty-plazas-alias"><Bot size={12} aria-hidden="true" /> <strong>{item.alias}</strong> <small>{item.tenant_id}</small></span>
            <span className="pty-plazas-modo">{item.mode === LIVE_TUI_MODE ? 'TUI en vivo' : item.mode === SHELL_MODE ? 'shell' : item.mode}</span>
            <span className="pty-plazas-resto"><Timer size={12} aria-hidden="true" /> se suelta sola en {minutosParaLiberar(item, ahora)} min</span>
            <button className="button small" type="button" onClick={() => onCerrar(item.session_id)} disabled={Boolean(cerrando[item.session_id])}>
              <PowerOff size={13} aria-hidden="true" /> {cerrando[item.session_id] ? 'Cerrando…' : 'Cerrar ahora'}
            </button>
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}
