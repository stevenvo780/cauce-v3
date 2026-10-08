import { AlertTriangle, Bot, PowerOff, RefreshCw, Timer } from 'lucide-react';
import { Button, Notice } from '../../components/kit';
import type { TerminalSessionListItem } from './api';
import { LIVE_TUI_MODE, SHELL_MODE } from './fleet';
import { minutosParaLiberar } from './plazas';

export type MotivoReconciliacionPlaza = 'session_limit' | 'invalid_grant_receipt';

interface Copia { titulo: string; cuerpo: string }

function copia(items: number, aLaVista: number, motivo: MotivoReconciliacionPlaza | undefined, hayError: boolean): Copia {
  const vacio = items === 0 && aLaVista === 0;
  if (hayError) {
    return {
      titulo: 'No se pudo leer qué sesiones están ocupando el tope',
      cuerpo: items === 0
        ? 'El inventario del gateway no es verificable. No se infiere que haya cero sesiones ni que todas estén abiertas en esta pantalla. Reintentá la lectura antes de decidir qué cerrar.'
        : `No se pudo actualizar el inventario. Las ${String(items)} filas de abajo son el último inventario verificable y pueden estar desactualizadas; no prueban cuántas plazas siguen ocupadas ahora.`,
    };
  }
  if (vacio && motivo === 'session_limit') {
    return {
      titulo: 'El tope se liberó antes de terminar la verificación',
      cuerpo: 'El POST recibió 409, pero el GET exacto posterior ya no encontró ninguna sesión ocupando plaza. Hubo una liberación concurrente: no hay nada que cerrar y podés reintentar la apertura.',
    };
  }
  if (vacio && motivo === 'invalid_grant_receipt') {
    return {
      titulo: 'El grant fue inválido y no hay una reserva visible',
      cuerpo: 'No se revocó el session_id del recibo roto porque no era confiable. El inventario exacto posterior no muestra una reserva que puedas cerrar; reintentá sólo después de releer si el estado cambia.',
    };
  }
  if (motivo === 'invalid_grant_receipt' && items > 0) {
    return {
      titulo: 'El grant fue inválido; estas son las reservas visibles',
      cuerpo: 'No se usó el session_id del recibo roto para borrar nada. Las filas de abajo vienen del GET exacto posterior: cerrá una sólo si reconocés que esa reserva ya no debe seguir viva.',
    };
  }
  if (items === 0) {
    return {
      titulo: `Tope de sesiones alcanzado: las ${String(items + aLaVista)} que lo gastan están abiertas acá`,
      cuerpo: 'El tope de sesiones simultáneas es por operador y ya lo gastaste con las sesiones abiertas en esta pantalla. '
        + 'Cerrá una desde el menú de la sesión y volvé a pedir la que querías: se libera al instante.',
    };
  }
  return {
    titulo: items === 1
      ? 'Una sesión tuya sigue ocupando plaza fuera de esta pantalla'
      : `${String(items)} sesiones tuyas siguen ocupando plaza fuera de esta pantalla`,
    cuerpo: 'El tope de sesiones simultáneas es por operador, así que estas cuentan aunque su pestaña ya no exista '
      + '—otra ventana, un cierre a lo bruto, una recarga a destiempo—. Mientras sigan vivas, abrir otra TUI '
      + 'devuelve 409. Se sueltan solas al vencer; el botón necesita la prueba original que conserva la pestaña que las abrió.',
  };
}

export function PlazasColgadas({ items, aLaVista, topeAlcanzado, motivo, revisando, cerrando, error, errorCierre, onRevisar, onCerrar }: {
  items: TerminalSessionListItem[];
  aLaVista: number;
  topeAlcanzado: boolean;
  motivo?: MotivoReconciliacionPlaza;
  revisando: boolean;
  cerrando: Record<string, boolean | undefined>;
  error?: string;
  errorCierre?: string;
  onRevisar: () => void;
  onCerrar: (sessionId: string) => void;
}) {
  if (items.length === 0 && !topeAlcanzado) return null;
  const ahora = Date.now();
  const { titulo, cuerpo } = copia(items.length, aLaVista, motivo, error !== undefined);
  return (
    <section
      aria-label="Sesiones de terminal que siguen ocupando plaza"
      className="shrink-0 border-b border-warn/40 bg-warn-soft px-3 py-2 text-[13px] text-warn-ink"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <strong className="font-semibold">{titulo}</strong>
          <p className="m-0 mt-0.5 text-xs text-fg-2">{cuerpo}</p>
          {error ? <Notice tone="danger" className="mt-1.5" role="alert">{error}</Notice> : null}
          {errorCierre ? <Notice tone="danger" className="mt-1.5" role="alert">{errorCierre}</Notice> : null}
        </div>
        <Button size="sm" onClick={onRevisar} disabled={revisando}>
          <RefreshCw size={13} aria-hidden="true" /> {revisando ? 'Revisando…' : 'Revisar'}
        </Button>
      </div>
      {items.length === 0 ? null : (
        <ul className="m-0 mt-2 grid list-none gap-1 p-0">
          {items.map((item) => (
            <li key={item.session_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-surface px-2.5 py-1.5 text-fg">
              <span className="inline-flex items-center gap-1"><Bot size={12} aria-hidden="true" /> <strong>{item.alias}</strong> <small className="text-muted">{item.tenant_id}</small></span>
              <span className="text-xs text-muted">{item.mode === LIVE_TUI_MODE ? 'TUI en vivo' : item.mode === SHELL_MODE ? 'shell' : item.mode}</span>
              <span className="inline-flex items-center gap-1 text-xs text-muted"><Timer size={12} aria-hidden="true" /> se suelta sola en {minutosParaLiberar(item, ahora)} min</span>
              <Button size="sm" className="ml-auto" onClick={() => { onCerrar(item.session_id); }} disabled={cerrando[item.session_id] === true}>
                <PowerOff size={13} aria-hidden="true" /> {cerrando[item.session_id] === true ? 'Cerrando…' : 'Cerrar ahora'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
