import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Tooltip } from '../../components/ui';
import { CONFIG_SIN_CONTROL_REASON } from '../../navigation';
import { fechaRelativa } from './fecha-relativa';
import type { Interruptor } from './interruptores';
import type { ControlDeInterruptores, FalloDeInterruptor } from './use-interruptores';

/**
 * **El interruptor.** Un `<input type="checkbox" role="switch">` de verdad, no un `<div>` pintado:
 * lo alcanza el tabulador, se activa con la barra espaciadora, un lector de pantalla lo anuncia como
 * «interruptor, activado» y el navegador ya sabe hacer todo eso sin una línea de JavaScript.
 *
 * El `aria-label` nombra la fila Y el permiso («Ruta en la arista Steven → Miguel»): veinticuatro
 * controles que sólo dicen «Ruta» son veinticuatro controles indistinguibles para quien no ve la
 * tabla.
 *
 * `aria-busy` mientras la escritura vuela. No es decoración: es la única señal de que el estado que
 * se está pintando todavía no lo confirmó nadie.
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

  /**
   * **Devolverle el foco al interruptor cuando la escritura termina.**
   *
   * MEDIDO en Chrome, con el teclado: mientras la escritura vuela la página entra en `busy` y todos
   * los controles quedan `disabled` — y un elemento deshabilitado PIERDE el foco. O sea que quien
   * navegaba con Tab pulsaba un interruptor con la barra espaciadora y aparecía con el foco en el
   * `<body>`, al principio del documento, con diecinueve filas por recorrer otra vez. No daba ningún
   * error y en jsdom no se ve: jsdom no aplica esa regla del navegador.
   */
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
 * La cabecera de una columna de permiso, con el tooltip que explica QUÉ concede.
 *
 * El dueño los pidió con esa palabra. Y hacían falta: la cabecera decía `ALLOW_CONTROL` —el nombre
 * de una columna de Postgres, en inglés, en mayúsculas— y en ningún sitio de la pantalla se decía
 * que es el permiso que deja a un cliente escribir la configuración de otro.
 */
export function CabeceraConAyuda({ etiqueta, explicacion }: { etiqueta: string; explicacion?: string }) {
  if (!explicacion) return <>{etiqueta}</>;
  return <Tooltip label={explicacion} placement="bottom" className="cabecera-ayuda">
    <span>{etiqueta}<span className="cabecera-ayuda-marca" aria-hidden="true">?</span></span>
    <span className="sr-only">: {explicacion}</span>
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
 * Una fecha como DISTANCIA, con la exacta entera en el `title` y en `dateTime`.
 *
 * La columna «Alta» repetía `1 jul 2026, 10:00:00` en las diecinueve filas, partido en tres líneas.
 * Nada se perdió: lo que cambia es cuál de los dos datos está a la vista.
 */
export function FechaRelativa({ value }: { value: unknown }) {
  const relativa = fechaRelativa(value);
  if (!relativa) return <span className="unknown">UNKNOWN</span>;
  return <time className="fecha-relativa" dateTime={relativa.iso} title={relativa.absoluta}>
    {relativa.texto}
    <span className="sr-only"> ({relativa.absoluta})</span>
  </time>;
}
