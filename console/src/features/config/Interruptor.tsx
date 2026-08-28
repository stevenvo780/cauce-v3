import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Tooltip } from '../../components/ui';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { MARCA_INERTE } from './campos-inertes';
import { fechaRelativa } from './fecha-relativa';
import type { Interruptor } from './interruptores';
import type { ControlDeInterruptores, FalloDeInterruptor } from './use-interruptores';

/**
 * **El interruptor.** Un `<input type="checkbox" role="switch">` de verdad, no un `<div>` pintado:
 * lo alcanza el tabulador, se activa con la barra espaciadora, un lector de pantalla lo anuncia como
 * «interruptor, activado» y el navegador ya sabe hacer todo eso sin una línea de JavaScript.
 *
 * El `aria-label` nombra la fila y el permiso correspondiente para accesibilidad.
 *
 * `aria-busy` mientras la escritura vuela.
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
  // Se pulsó ESTE control teniendo el foco, y hay que devolvérselo cuando la escritura termine.
  const devolverElFoco = useRef(false);
  const volaba = useRef(false);

  /** Devuelve el foco al interruptor cuando concluye la escritura en vuelo. */
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
    {/* El estado en palabras, además de en el dibujo: el color por sí solo no es un dato, y
        «encendido/apagado» es lo que hay que poder leer sin interpretar un tono de verde. */}
    <span className="interruptor-estado" aria-hidden="true">{valor ? 'sí' : 'no'}</span>
  </span>;
}

/**
 * Cabecera de columna con tooltip informativo o indicador de campo inerte.
 */
export function CabeceraConAyuda({ etiqueta, explicacion, inerte }: {
  etiqueta: string;
  explicacion?: string;
  /** Por qué esta columna no tiene efecto. Ver `campos-inertes.ts`. */
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
 * Lo que salió mal en UN interruptor, pegado a su fila y con el motivo **del servidor**.
 *
 * Va en su propia `<tr>` justo debajo de la fila que falló y no en un cartel al pie de la tabla:
 * con diecinueve membresías, un aviso al final no dice cuál de las diecinueve se rechazó.
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
        onClick={() => control.reintentar(fallo.interruptor.clave)}
      ><RotateCcw size={13} aria-hidden="true" />Reintentar</button>
    </td>
  </tr>;
}

/**
 * **La única confirmación que queda en la pantalla**: quitar el permiso de Control.
 *
 * Ver `interruptores.ts` para el porqué. Se pinta junto a la tabla que la pidió, con el sujeto
 * escrito, y no como un `window.confirm` que el navegador dibuja fuera de contexto y sin decir
 * sobre qué fila se está preguntando.
 */
export function ConfirmarQuitarControl({ control, busy }: {
  control: ControlDeInterruptores;
  busy: boolean;
}) {
  const pedida = control.confirmacion;
  if (!pedida) return null;
  return <div className="interruptor-confirmacion" role="group" aria-label="Confirmar quitar el permiso de Control">
    {/* El icono y el texto son DOS hijos de un flex; sin envolver el texto en un solo `<span>`, el
        título y el cuerpo se reparten como dos columnas y el título queda en una tira de 90 px. */}
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
 * Renderiza una fecha relativa accesible, con la fecha ISO exacta en dateTime y title.
 */
export function FechaRelativa({ value }: { value: unknown }) {
  const relativa = fechaRelativa(value);
  if (!relativa) return <span className="unknown">UNKNOWN</span>;
  return <time className="fecha-relativa" dateTime={relativa.iso} title={relativa.absoluta}>
    {relativa.texto}
    <span className="sr-only"> ({relativa.absoluta})</span>
  </time>;
}
