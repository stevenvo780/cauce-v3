import { Braces } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { CONFIG_SIN_CONTROL_REASON } from '../../navigation';
import { Badge, EmptyState, Panel, Time, Unknown } from '../../components/ui';
import type { ConfigCollection } from './collections';
import {
  accionDeColumna, accionDeRol, accionesDeFila, accionesFueraDeColumnas, claveDeFila, columnasDe,
  COLECCIONES_CON_ACCIONES, esColumnaDeFecha, esColumnaLarga, motivoSinCambioDeRol,
  resumirTextoLargo, rolesDisponibles,
  type AccionDeFila, type ColumnaTabla,
} from './collection-table';

/** Qué botón de qué fila está esperando el «Confirmar». Sólo hay uno a la vez en toda la página. */
export interface AccionPendiente {
  coleccion: string;
  filaId: string;
  accion: AccionDeFila;
}

export interface AvisoDeColeccion {
  text: string;
  tone: 'success' | 'error' | 'parcial';
}

/**
 * Una colección del snapshot como TABLA con columnas de verdad, con las operaciones frecuentes a un
 * clic y con el JSON crudo detrás de un desplegable para quien lo necesite.
 *
 * Antes esto era `<code>{JSON.stringify(row)}</code>` por fila y nada más: para deshabilitar una
 * membership había que tipear la mutación a mano en el textarea de abajo. El JSON no se borró
 * —sigue siendo la verdad literal del servidor— pero dejó de ser lo primero que se ve.
 */
export function CollectionTable({
  coleccion, politicasDeRol, soloLectura, busy, pendiente, aviso, onPedir, onConfirmar, onCancelar,
}: {
  coleccion: ConfigCollection;
  /** `role_policies` del snapshot: alimenta el selector de rol de las memberships. */
  politicasDeRol: ReadonlyArray<Record<string, unknown>> | undefined;
  soloLectura: boolean;
  busy: boolean;
  pendiente?: AccionPendiente;
  aviso?: AvisoDeColeccion;
  onPedir: (pendiente: AccionPendiente) => void;
  onConfirmar: () => void;
  onCancelar: () => void;
}) {
  const { key, title, rows } = coleccion;
  const filas = rows ?? [];
  const columnas = columnasDe(key, filas);
  // La columna «Acciones» sólo se dibuja si SOBRA algo después de que cada booleano se convierta en
  // el interruptor de su propia columna. Con los datos de producción no sobra nada en ninguna de
  // las cuatro colecciones, así que la columna —y con ella los 61 botones duplicados— desaparece.
  const conAcciones = COLECCIONES_CON_ACCIONES.has(key) && filas.some((fila) => {
    const todas = accionesDeFila(key, fila);
    // Una fila SIN ninguna acción sigue necesitando la columna: ahí es donde se dice por qué.
    return todas.length === 0 || accionesFueraDeColumnas(todas, columnas).length > 0;
  });

  return <Panel title={title} subtitle="Datos efectivos del servidor">
    {/* Clave ausente y lista vacía NO son lo mismo: un gateway anterior a una migración no publica
        su tabla, y decir «sin registros» ahí sería mentir. */}
    {!rows ? <EmptyState>UNKNOWN: este gateway no publica esta colección ({key}).</EmptyState>
      : !filas.length ? <EmptyState>Sin registros.</EmptyState>
        : <>
          <div className="table-wrap"><table><thead><tr>
            {columnas.map((columna) => <th key={columna.clave}>{columna.etiqueta}</th>)}
            {conAcciones ? <th>Acciones</th> : null}
          </tr></thead><tbody>
            {filas.map((fila, indice) => {
              const filaId = claveDeFila(key, fila, indice);
              return <tr key={filaId}>
                {columnas.map((columna) => <td key={columna.clave}>
                  <Celda
                    coleccion={key} columna={columna} fila={fila} filaId={filaId}
                    acciones={accionesDeFila(key, fila)}
                    politicasDeRol={politicasDeRol} soloLectura={soloLectura} busy={busy}
                    onPedir={onPedir}
                  />
                </td>)}
                {conAcciones ? <td><Acciones
                  coleccion={key} fila={fila} filaId={filaId} columnas={columnas}
                  soloLectura={soloLectura} busy={busy} onPedir={onPedir}
                /></td> : null}
              </tr>;
            })}
          </tbody></table></div>

          {pendiente ? <ConfirmacionDeAccion
            pendiente={pendiente} busy={busy} onConfirmar={onConfirmar} onCancelar={onCancelar}
          /> : null}

          {aviso ? <p
            className={aviso.tone === 'error' ? 'notice error' : aviso.tone === 'parcial' ? 'notice parcial' : 'notice success'}
            role={aviso.tone === 'success' ? 'status' : 'alert'}
          >{aviso.text}</p> : null}

          {/* El JSON crudo no se borra: es la única forma de ver un campo que la tabla no tiene
              columna para mostrar. Lo que cambia es que ya no es lo primero que se ve. */}
          <details className="config-raw">
            <summary><Braces size={13} aria-hidden="true" /> Ver crudo ({filas.length} filas tal cual las publica el servidor)</summary>
            <ul className="config-records">
              {filas.map((fila, indice) => <li key={claveDeFila(key, fila, indice)}><code>{JSON.stringify(fila)}</code></li>)}
            </ul>
          </details>
        </>}
  </Panel>;
}

function Celda({ coleccion, columna, fila, filaId, acciones, politicasDeRol, soloLectura, busy, onPedir }: {
  coleccion: string;
  columna: ColumnaTabla;
  fila: Record<string, unknown>;
  filaId: string;
  acciones: readonly AccionDeFila[];
  politicasDeRol: ReadonlyArray<Record<string, unknown>> | undefined;
  soloLectura: boolean;
  busy: boolean;
  onPedir: (pendiente: AccionPendiente) => void;
}) {
  const valor = fila[columna.clave];

  // El rol de una membership se cambia acá mismo, en su propia columna. El `value` sigue atado al
  // dato del servidor: si el operador cancela la confirmación, el selector vuelve solo a lo que la
  // fila dice, sin que la pantalla llegue a mostrar un rol que nadie guardó.
  if (coleccion === 'memberships' && columna.clave === 'role') {
    const actual = typeof valor === 'string' ? valor : '';
    const opciones = rolesDisponibles(politicasDeRol, actual === '' ? undefined : actual);
    // Sin los tres campos de identidad no hay mutación que armar. Antes el `onChange` llamaba
    // igual, recibía `undefined` y no pasaba NADA: ni escritura ni cartel. Ahora el control se
    // apaga y el motivo queda escrito al lado, que es la diferencia entre «no se puede» y «roto».
    const motivo = motivoSinCambioDeRol(fila);
    return <>
      <select
        aria-label={`Rol de ${filaId}`}
        value={actual}
        disabled={soloLectura || busy || motivo !== undefined}
        title={motivo ?? (soloLectura ? CONFIG_SIN_CONTROL_REASON : undefined)}
        onChange={(event) => {
          const accion = accionDeRol(fila, event.target.value);
          if (accion) onPedir({ coleccion, filaId, accion });
        }}
      >
        {actual === '' ? <option value="">UNKNOWN</option> : null}
        {opciones.map((rol) => <option key={rol} value={rol}>{rol}</option>)}
      </select>
      {motivo ? <span className="unknown">{motivo}</span> : null}
    </>;
  }

  // Un campo de párrafo entero (`role_brief`: hasta 1200 caracteres) empuja las otras once columnas
  // de «Agent registry» fuera de la pantalla. Se muestra resumido; el texto completo queda en el
  // `title`, en «Ver crudo» y —para editarlo— en la pestaña «Rol» del cajón de «La flota ahora».
  if (esColumnaLarga(columna.clave) && typeof valor === 'string' && valor.trim() !== '') {
    return <span className="config-resumen" title={valor}>{resumirTextoLargo(valor)}</span>;
  }

  if (typeof valor === 'boolean') {
    // Un booleano que TIENE acción propia es un interruptor, no una etiqueta con un botón al lado.
    // El clic no escribe: abre la misma confirmación de siempre, con la mutación exacta.
    const accion = accionDeColumna(acciones, columna.clave);
    if (accion) {
      return <button
        type="button"
        role="switch"
        className="config-switch"
        aria-checked={valor}
        aria-label={`${columna.etiqueta} de ${filaId}`}
        title={soloLectura ? CONFIG_SIN_CONTROL_REASON : accion.descripcion}
        disabled={soloLectura || busy}
        onClick={() => onPedir({ coleccion, filaId, accion })}
      ><span className="config-switch-pista" aria-hidden="true"><span className="config-switch-perilla" /></span></button>;
    }
    return <Badge tone={valor ? 'online' : 'offline'}>{valor ? 'Sí' : 'No'}</Badge>;
  }
  if (esColumnaDeFecha(columna.clave)) return <Time value={valor} />;
  if (Array.isArray(valor)) {
    // Una lista vacía es un dato conocido —«no tiene ninguna»—, no un UNKNOWN.
    return valor.length ? <span>{valor.map((item) => String(item)).join(', ')}</span> : <span className="unknown">(vacío)</span>;
  }
  if (valor !== null && typeof valor === 'object') return <code>{JSON.stringify(valor)}</code>;
  return <Unknown value={valor} />;
}

function Acciones({ coleccion, fila, filaId, columnas, soloLectura, busy, onPedir }: {
  coleccion: string;
  fila: Record<string, unknown>;
  filaId: string;
  columnas: readonly ColumnaTabla[];
  soloLectura: boolean;
  busy: boolean;
  onPedir: (pendiente: AccionPendiente) => void;
}) {
  const todas = accionesDeFila(coleccion, fila);
  if (!todas.length) {
    // Sin `enabled` booleano no se sabe cuál es «el contrario»: es preferible una fila sin botones a
    // una que apague algo por suponer que estaba encendido.
    return <span className="unknown">UNKNOWN: sin datos para armar la mutación</span>;
  }
  // Todo lo que ya es interruptor en su propia columna no se repite acá.
  const acciones = accionesFueraDeColumnas(todas, columnas);
  if (!acciones.length) return null;
  return <span className="config-actions">
    {acciones.map((accion) => <button
      key={accion.id}
      type="button"
      className="button small"
      aria-label={accion.descripcion}
      title={soloLectura ? CONFIG_SIN_CONTROL_REASON : accion.descripcion}
      disabled={soloLectura || busy}
      onClick={() => onPedir({ coleccion, filaId, accion })}
    >{accion.etiqueta}</button>)}
  </span>;
}

/**
 * Confirmación con la mutación EXACTA a la vista. No alcanza con un «¿seguro?»: lo que se firma es
 * una escritura versionada en `config_revisions`, y el operador tiene derecho a leer el JSON que va
 * a viajar antes de que viaje.
 *
 * Era un `<div role="group">` pegado debajo del botón que lo abría, y eso costaba tres cosas
 * MEDIDAS en Chrome contra el snapshot real:
 *  - 269px de alto, de los cuales 170 eran el volcado de JSON. En un viewport de 900px «Confirmar»
 *    y «Cancelar» caían en y=999..1039, o sea INVISIBLES: había que adivinar que se baja.
 *  - `aria-modal` ausente, ESC sin efecto y el foco quieto en el botón de la fila.
 *  - el fondo seguía siendo pulsable: con la confirmación abierta se podía apretar «Cerrar sesión»
 *    de la cabecera —pasó de verdad durante la revisión— y la sesión se cerraba con el cambio a
 *    medio firmar.
 *
 * Ahora es un diálogo de verdad: se monta en `document.body` (fuera de `.app-shell`), pone el resto
 * de la página en `inert` mientras vive, atrapa el tabulador, se cierra con ESC o con clic fuera, y
 * devuelve el foco al control que lo abrió. Los dos botones viven en un pie que NO scrollea, así
 * que no pueden quedar debajo del pliegue por largo que sea el JSON. Y el JSON pasa a estar detrás
 * de «Ver la mutación exacta»: sigue entero y a un clic, pero ya no empuja la decisión fuera de la
 * pantalla. Lo que queda arriba, siempre visible, es la frase en castellano.
 */
function ConfirmacionDeAccion({ pendiente, busy, onConfirmar, onCancelar }: {
  pendiente: AccionPendiente;
  busy: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
}) {
  const dialogo = useRef<HTMLDivElement>(null);
  const confirmar = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const abridor = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // `inert` sobre el armazón —no sobre `body`, donde vive este diálogo— es lo que apaga de verdad
    // la cabecera y la barra lateral: ni ratón, ni tabulador, ni lector de pantalla.
    const fondo = document.querySelector('.app-shell');
    fondo?.setAttribute('inert', '');
    confirmar.current?.focus();
    return () => {
      fondo?.removeAttribute('inert');
      abridor?.focus();
    };
  }, []);

  // ESC cancela, y el tabulador da la vuelta dentro del diálogo en vez de irse al fondo.
  const teclado = (evento: KeyboardEvent<HTMLDivElement>) => {
    if (evento.key === 'Escape') { evento.stopPropagation(); onCancelar(); return; }
    if (evento.key !== 'Tab') return;
    const focos = dialogo.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), summary, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focos || focos.length === 0) return;
    const primero = focos[0];
    const ultimo = focos[focos.length - 1];
    if (!evento.shiftKey && document.activeElement === ultimo) { evento.preventDefault(); primero.focus(); }
    if (evento.shiftKey && document.activeElement === primero) { evento.preventDefault(); ultimo.focus(); }
  };

  return createPortal(
    <div className="config-modal-fondo" onMouseDown={(evento) => { if (evento.target === evento.currentTarget) onCancelar(); }}>
      <div
        className="config-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-modal-titulo"
        ref={dialogo}
        onKeyDown={teclado}
      >
        <div className="config-modal-cuerpo">
          <p id="config-modal-titulo">Confirmá el cambio: <strong>{pendiente.accion.descripcion}</strong>.</p>
          <details className="config-modal-detalle">
            <summary><Braces size={13} aria-hidden="true" /> Ver la mutación exacta que se va a enviar</summary>
            <pre className="config-preview" aria-label="Mutación a aplicar">{JSON.stringify(pendiente.accion.mutation, null, 2)}</pre>
          </details>
        </div>
        <div className="config-modal-pie config-actions">
          <button className="button primary" type="button" ref={confirmar} disabled={busy} onClick={onConfirmar}>Confirmar</button>
          <button className="button small" type="button" disabled={busy} onClick={onCancelar}>Cancelar</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
