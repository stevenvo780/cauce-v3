import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button, Notice } from '../../components/kit';
import { Tooltip } from '../../components/ui';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { MARCA_INERTE } from './campos-inertes';
import { fechaRelativa } from './fecha-relativa';
import type { Interruptor } from './interruptores';
import type { ControlDeInterruptores, FalloDeInterruptor } from './use-interruptores';

/** A checkbox repainted as a switch: tab reaches it, space toggles it and screen readers announce it as one. */
const SWITCH = 'relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full border border-line-strong bg-muted-bg p-0 transition-colors '
  + 'before:absolute before:top-0.5 before:left-0.5 before:size-3.5 before:rounded-full before:bg-muted before:transition-transform before:content-[\'\'] '
  + 'checked:border-ok checked:bg-ok-soft checked:before:translate-x-4 checked:before:bg-ok '
  + 'enabled:hover:border-brand disabled:cursor-not-allowed disabled:opacity-50 '
  + 'aria-busy:border-warn aria-busy:before:animate-pulse aria-busy:before:bg-warn aria-invalid:border-danger '
  + 'motion-reduce:transition-none motion-reduce:before:transition-none motion-reduce:before:animate-none';

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

  return <span className="inline-flex items-center gap-2">
    <input
      ref={nodo}
      type="checkbox"
      role="switch"
      className={SWITCH}
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
    <span className="min-w-[1.4em] text-xs text-muted uppercase tabular-nums" aria-hidden="true">{valor ? 'sí' : 'no'}</span>
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
  return <Tooltip label={ayuda} placement="bottom" className="cursor-help">
    <span className="inline-flex items-center gap-1">
      {etiqueta}
      {inerte
        ? <span className="rounded-full bg-muted-bg px-1.5 text-[11px] font-medium text-fg-2">{MARCA_INERTE}</span>
        : <span className="grid size-4 place-items-center rounded-full border border-line-strong text-[11px] font-semibold text-muted" aria-hidden="true">?</span>}
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
  return <tr>
    <td colSpan={columnas} className="bg-danger-soft max-md:!block">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p role="alert" className="m-0 flex min-w-0 flex-1 items-start gap-2 text-[13px] text-danger-ink">
          <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>
            <strong>No se aplicó «{fallo.interruptor.descripcion}».</strong> El interruptor volvió solo
            a lo que dice la configuración. El servidor contestó: {fallo.motivo}
          </span>
        </p>
        <Button size="sm" disabled={busy} onClick={() => { control.reintentar(fallo.interruptor.clave); }}>
          <RotateCcw size={13} aria-hidden="true" />Reintentar
        </Button>
      </div>
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
  return <Notice tone="warn" role="group" aria-label="Confirmar quitar el permiso de Control" className="grid gap-2">
    <p className="flex items-start gap-2">
      <AlertTriangle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span><strong>{pedida.interruptor.descripcion}.</strong> {pedida.texto}</span>
    </p>
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" disabled={busy} onClick={control.confirmar}>Quitar Control</Button>
      <Button size="sm" disabled={busy} onClick={control.cancelar}>Cancelar</Button>
    </div>
  </Notice>;
}

/**
 * Renders an accessible relative date, with the exact ISO date in dateTime and title.
 */
export function FechaRelativa({ value }: { value: unknown }) {
  const relativa = fechaRelativa(value);
  if (!relativa) return <span className="text-muted italic">UNKNOWN</span>;
  return <time className="whitespace-nowrap text-muted tabular-nums" dateTime={relativa.iso} title={relativa.absoluta}>
    {relativa.texto}
    <span className="sr-only"> ({relativa.absoluta})</span>
  </time>;
}
