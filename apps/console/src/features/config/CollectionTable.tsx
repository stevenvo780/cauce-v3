import { Braces } from 'lucide-react';
import { CONFIG_SIN_CONTROL_REASON } from '../../navigation';
import { Badge, EmptyState, Panel, Time, Unknown } from '../../components/ui';
import type { ConfigCollection } from './collections';
import {
  accionDeRol, accionesDeFila, claveDeFila, columnasDe, COLECCIONES_CON_ACCIONES, esColumnaDeFecha,
  esColumnaLarga, motivoSinCambioDeRol, resumirTextoLargo, rolesDisponibles,
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
  const conAcciones = COLECCIONES_CON_ACCIONES.has(key);

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
                    politicasDeRol={politicasDeRol} soloLectura={soloLectura} busy={busy}
                    onPedir={onPedir}
                  />
                </td>)}
                {conAcciones ? <td><Acciones
                  coleccion={key} fila={fila} filaId={filaId} soloLectura={soloLectura} busy={busy}
                  onPedir={onPedir}
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

function Celda({ coleccion, columna, fila, filaId, politicasDeRol, soloLectura, busy, onPedir }: {
  coleccion: string;
  columna: ColumnaTabla;
  fila: Record<string, unknown>;
  filaId: string;
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

function Acciones({ coleccion, fila, filaId, soloLectura, busy, onPedir }: {
  coleccion: string;
  fila: Record<string, unknown>;
  filaId: string;
  soloLectura: boolean;
  busy: boolean;
  onPedir: (pendiente: AccionPendiente) => void;
}) {
  const acciones = accionesDeFila(coleccion, fila);
  if (!acciones.length) {
    // Sin `enabled` booleano no se sabe cuál es «el contrario»: es preferible una fila sin botones a
    // una que apague algo por suponer que estaba encendido.
    return <span className="unknown">UNKNOWN: sin datos para armar la mutación</span>;
  }
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
 */
function ConfirmacionDeAccion({ pendiente, busy, onConfirmar, onCancelar }: {
  pendiente: AccionPendiente;
  busy: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
}) {
  return <div className="config-confirm" role="group" aria-label="Confirmar el cambio">
    <p>Confirmá el cambio: <strong>{pendiente.accion.descripcion}</strong>.</p>
    <pre className="config-preview" aria-label="Mutación a aplicar">{JSON.stringify(pendiente.accion.mutation, null, 2)}</pre>
    <div className="config-actions">
      <button className="button primary" type="button" disabled={busy} onClick={onConfirmar}>Confirmar</button>
      <button className="button small" type="button" disabled={busy} onClick={onCancelar}>Cancelar</button>
    </div>
  </div>;
}
