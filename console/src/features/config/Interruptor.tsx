import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Tooltip } from '../../components/ui';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { MARCA_INERTE } from './campos-inertes';
import { fechaRelativa } from './fecha-relativa';
import type { Interruptor } from './interruptores';
import type { ControlDeInterruptores, FalloDeInterruptor } from './use-interruptores';

/**
 * **The switch.** A real `<input type="checkbox" role="switch">`, not a painted `<div>`: tab
 * reaches it, the spacebar toggles it, a screen reader announces it as "switch, on/off", and the
 * browser already knows how to do all of that without a single line of JavaScript.
 *
 * The `aria-label` names the row and the corresponding permission for accessibility.
 *
 * `aria-busy` while the write is in flight.
 */
export function InterruptorDeCelda({ interruptor, control, soloLectura, busy }: {
  interruptor: Interruptor;
  control: ControlDeInterruptores;
  soloLectura: boolean;
  busy: boolean;
}) {
  const valor = control.valorPintado(interruptor);
  const enVuelo = control.enVuelo(interruptor.clave);
  const fallo = control.fallo(interruptor.clave);
  const nodo = useRef<HTMLInputElement>(null);
  // THIS control was clicked while holding focus, and focus must be given back when the write ends.
  const devolverElFoco = useRef(false);
  const volaba = useRef(false);

  /** Returns focus to the switch when the in-flight write finishes. */
  useEffect(() => {
    if (volaba.current && !enVuelo && devolverElFoco.current) {
      devolverElFoco.current = false;
      nodo.current?.focus();
    }
    volaba.current = enVuelo;
  }, [enVuelo]);

  return <span className="interruptor-caja">
    <input
      ref={nodo}
      type="checkbox"
      role="switch"
      className="interruptor"
      aria-label={interruptor.aria}
      aria-busy={enVuelo || undefined}
      aria-invalid={fallo ? true : undefined}
      checked={valor}
      disabled={soloLectura || busy}
      title={soloLectura ? CONFIG_SIN_CONTROL_REASON : interruptor.aria}
      onChange={() => {
        devolverElFoco.current = typeof document !== 'undefined' && document.activeElement === nodo.current;
        control.pulsar(interruptor);
      }}
    />
    {/* The state in words, in addition to the drawing: color alone is not data, and
        "on/off" is what must be readable without interpreting a shade of green. */}
    <span className="interruptor-estado" aria-hidden="true">{valor ? 'sí' : 'no'}</span>
  </span>;
}

/**
 * Column header with informative tooltip or inert-field indicator.
 */
export function CabeceraConAyuda({ etiqueta, explicacion, inerte }: {
  etiqueta: string;
  explicacion?: string;
  /** Why this column has no effect. See `campos-inertes.ts`. */
  inerte?: string;
}) {
  const ayuda = inerte ?? explicacion;
  if (!ayuda) return <>{etiqueta}</>;
  return <Tooltip label={ayuda} placement="bottom" className="cabecera-ayuda">
    <span>
      {etiqueta}
      {inerte
        ? <span className="cabecera-inerte">{MARCA_INERTE}</span>
        : <span className="cabecera-ayuda-marca" aria-hidden="true">?</span>}
    </span>
    <span className="sr-only">: {ayuda}</span>
  </Tooltip>;
}

/**
 * What went wrong on ONE switch, attached to its row and carrying the reason **from the server**.
 *
 * Goes on its own `<tr>` just below the row that failed, not in a banner at the foot of the table:
 * with nineteen memberships, a notice at the end does not say which of the nineteen got rejected.
 */
export function FilaDeFallo({ fallo, columnas, control, busy }: {
  fallo: FalloDeInterruptor;
  columnas: number;
  control: ControlDeInterruptores;
  busy: boolean;
}) {
  return <tr className="interruptor-fallo">
    <td colSpan={columnas}>
      <p role="alert">
        <AlertTriangle size={14} aria-hidden="true" />
        <span>
          <strong>No se aplicó «{fallo.interruptor.descripcion}».</strong> El interruptor volvió solo
          a lo que dice la configuración. El servidor contestó: {fallo.motivo}
        </span>
      </p>
      <button
        type="button" className="button small" disabled={busy}
        onClick={() => { control.reintentar(fallo.interruptor.clave); }}
      ><RotateCcw size={13} aria-hidden="true" />Reintentar</button>
    </td>
  </tr>;
}

/**
 * **The only confirmation left on screen**: removing the Control permission.
 *
 * See `interruptores.ts` for the why. It renders next to the table that asked for it, with the
 * subject spelled out, not as a `window.confirm` the browser paints out of context and without
 * saying which row it is asking about.
 */
export function ConfirmarQuitarControl({ control, busy }: {
  control: ControlDeInterruptores;
  busy: boolean;
}) {
  const pedida = control.confirmacion;
  if (!pedida) return null;
  return <div className="interruptor-confirmacion" role="group" aria-label="Confirmar quitar el permiso de Control">
    {/* The icon and the text are TWO children of a flex; without wrapping the text in a single
        `<span>`, the title and the body split across two columns and the title is squashed into a
        90 px strip. */}
    <p>
      <AlertTriangle size={15} aria-hidden="true" />
      <span><strong>{pedida.interruptor.descripcion}.</strong> {pedida.texto}</span>
    </p>
    <div className="config-actions">
      <button className="button primary" type="button" disabled={busy} onClick={control.confirmar}>
        Quitar Control
      </button>
      <button className="button small" type="button" disabled={busy} onClick={control.cancelar}>
        Cancelar
      </button>
    </div>
  </div>;
}

/**
 * Renders an accessible relative date, with the exact ISO date in dateTime and title.
 */
export function FechaRelativa({ value }: { value: unknown }) {
  const relativa = fechaRelativa(value);
  if (!relativa) return <span className="unknown">UNKNOWN</span>;
  return <time className="fecha-relativa" dateTime={relativa.iso} title={relativa.absoluta}>
    {relativa.texto}
    <span className="sr-only"> ({relativa.absoluta})</span>
  </time>;
}
