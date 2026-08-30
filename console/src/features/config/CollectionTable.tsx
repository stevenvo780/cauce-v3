import { Braces } from 'lucide-react';
import { Fragment, useEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { Badge, Desplazable, EmptyState, Panel, Unknown } from '../../components/ui';
import type { ConfigCollection } from './collections';
import {
  accionDeRol, claveDeFila, columnaNumerica, columnasDe, esColumnaDeFecha, esColumnaFundida,
  esColumnaLarga, identidadFundida, motivoSinCambioDeRol, resumirTextoLargo, rolesDisponibles,
  type AccionDeRol, type ColumnaTabla,
} from './collection-table';
import { columnasInertesDe, motivoInerte } from './campos-inertes';
import {
  CabeceraConAyuda, ConfirmarQuitarControl, FechaRelativa, FilaDeFallo, InterruptorDeCelda,
} from './Interruptor';
import { esCampoConmutable, explicacionDeCampo, interruptorDeFila } from './interruptores';
import type { ControlDeInterruptores } from './use-interruptores';
import './toggles.css';

/** Which ROLE change of which row is awaiting the "Confirm". Only one at a time. */
export interface AccionPendiente {
  coleccion: string;
  filaId: string;
  accion: AccionDeRol;
}

export interface AvisoDeColeccion {
  text: string;
  tone: 'success' | 'error' | 'parcial';
}

/**
 * Interactive table to view and modify configuration collections via toggles.
 */
export function CollectionTable({
  coleccion, politicasDeRol, soloLectura, busy, control, pendiente, aviso,
  onPedir, onConfirmar, onCancelar,
}: {
  coleccion: ConfigCollection;
  /** `role_policies` from the snapshot: feeds the role selector of memberships. */
  politicasDeRol: readonly Record<string, unknown>[] | undefined;
  soloLectura: boolean;
  busy: boolean;
  control: ControlDeInterruptores;
  pendiente?: AccionPendiente;
  aviso?: AvisoDeColeccion;
  onPedir: (pendiente: AccionPendiente) => void;
  onConfirmar: () => void;
  onCancelar: () => void;
}) {
  const { key, title, rows } = coleccion;
  const filas = rows ?? [];
  const columnas = columnasDe(key, filas);
  // Which columns right-align. Decided from this collection's DATA, not a name list: `max_per_hour`
  // is numeric here and might not be on a gateway that publishes something else under that name.
  // See `columnaNumerica`.
  const numericas = new Set(columnas.filter((columna) => columnaNumerica(filas, columna.clave)).map((columna) => columna.clave));
  // The inert columns THIS TABLE IS PAINTING, not those the catalog knows of this collection: the
  // notice above has to show and hide with what the gateway publishes.
  const inertesPresentes = columnasInertesDe(key, columnas.map((columna) => columna.clave));
  const avisoDeInterruptor = control.avisoDe(key);
  const confirmandoAqui = control.confirmacion?.interruptor.coleccion === key;

  return <Panel title={title} subtitle="Datos efectivos del servidor">
    {/* Clave ausente y lista vacía NO son lo mismo: un gateway anterior a una migración no publica
        su tabla, y decir «sin registros» ahí sería mentir. */}
    {!rows ? <EmptyState>UNKNOWN: este gateway no publica esta colección ({key}).</EmptyState>
      : !filas.length ? <EmptyState>Sin registros.</EmptyState>
        : <>
          {/* El desenlace de un interruptor se anuncia acá arriba, en un `role="status"` que el
              lector de pantalla lee solo: el interruptor moviéndose es una señal visual, y sin esto
              quien no ve la pantalla no se entera de que la escritura llegó. */}
          {avisoDeInterruptor ? <p
            className={avisoDeInterruptor.tone === 'parcial' ? 'notice parcial' : 'notice success'}
            role="status"
          >{avisoDeInterruptor.text}</p> : null}

          {confirmandoAqui ? <ConfirmarQuitarControl control={control} busy={busy} /> : null}

          {/* El aviso de la tabla, UNA vez y arriba. Marcar columna por columna contesta «¿esta
              sirve?» pero no «¿qué hago entonces?», y esa segunda pregunta es la que trae al
              operador hasta acá. No se esconden las columnas: el servidor las publica, y esconder
              un dato que existe es la otra forma de mentir sobre lo que hay configurado. */}
          {inertesPresentes.length ? <p className="notice config-inertes" role="note">
            {inertesPresentes.length === 1 ? 'Una columna de esta tabla se guarda' : `${String(inertesPresentes.length)} columnas de esta tabla se guardan`},
            {inertesPresentes.length === 1 ? ' se audita y se puede deshacer' : ' se auditan y se pueden deshacer'}, pero
            <strong> no {inertesPresentes.length === 1 ? 'la lee' : 'las lee'} ningún camino de ejecución</strong>:
            {inertesPresentes.length === 1 ? ' va marcada' : ' van marcadas'} «sin efecto» y cada una dice de dónde sale
            el valor que sí manda.
          </p> : null}

          <Desplazable etiqueta={title}><table><thead><tr>
            {columnas.map((columna) => {
              const inerte = motivoInerte(key, columna.clave);
              return <th
                key={columna.clave}
                data-numero={numericas.has(columna.clave) ? 'true' : undefined}
                data-inerte={inerte === undefined ? undefined : 'true'}
              >
                <CabeceraConAyuda
                  etiqueta={columna.etiqueta}
                  {...(() => {
                    const ayuda = explicacionDeCampo(key, columna.clave);
                    return ayuda === undefined ? {} : { explicacion: ayuda };
                  })()}
                  {...(inerte === undefined ? {} : { inerte })}
                />
              </th>;
            })}
          </tr></thead><tbody>
            {filas.map((fila, indice) => {
              const filaId = claveDeFila(key, fila, indice);
// One failure per row: the global `busy` serializes writes, so two toggles of the same row
                // cannot be rejected at the same time.
              const fallo = columnas
                .map((columna) => control.fallo(`${key}|${filaId}|${columna.clave}`))
                .find((encontrado) => encontrado !== undefined);
              return <Fragment key={filaId}>
                <tr>
                  {/* La celda de una columna inerte se apaga con el mismo `data-inerte` que su
                      cabecera: el valor sigue legible —es lo que hay declarado— pero deja de
                      competir por la atención con las columnas que sí gobiernan algo. */}
                  {columnas.map((columna) => <td
                    key={columna.clave}
                    data-numero={numericas.has(columna.clave) ? 'true' : undefined}
                    data-inerte={motivoInerte(key, columna.clave) === undefined ? undefined : 'true'}
                  >
                    <Celda
                      coleccion={key} columna={columna} fila={fila} filaId={filaId} indice={indice}
                      politicasDeRol={politicasDeRol} soloLectura={soloLectura} busy={busy}
                      control={control} onPedir={onPedir}
                    />
                  </td>)}
                </tr>
                {fallo ? <FilaDeFallo
                  fallo={fallo} columnas={columnas.length} control={control} busy={busy}
                /> : null}
              </Fragment>;
            })}
          </tbody></table></Desplazable>

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

function Celda({
  coleccion, columna, fila, filaId, indice, politicasDeRol, soloLectura, busy, control, onPedir,
}: {
  coleccion: string;
  columna: ColumnaTabla;
  fila: Record<string, unknown>;
  filaId: string;
  indice: number;
  politicasDeRol: readonly Record<string, unknown>[] | undefined;
  soloLectura: boolean;
  busy: boolean;
  control: ControlDeInterruptores;
  onPedir: (pendiente: AccionPendiente) => void;
}) {
  // The merged identity column: `From` + `To` are read as a single edge.
  if (esColumnaFundida(coleccion, columna.clave)) {
    const arista = identidadFundida(coleccion, fila);
    return arista === undefined ? <Unknown value={null} /> : <span className="mono">{arista}</span>;
  }

  const valor = fila[columna.clave];

  // **The toggle.** Only rendered when the mutation can be assembled from what the row carries;
  // otherwise it falls back to the read-only pill, which shows the data without promising it is changeable.
  if (esCampoConmutable(coleccion, columna.clave)) {
    const interruptor = interruptorDeFila(coleccion, fila, columna.clave, indice);
    if (interruptor) {
      return <InterruptorDeCelda
        interruptor={interruptor} control={control} soloLectura={soloLectura} busy={busy}
      />;
    }
  }

  // A membership's role is changed right here, in its own column. It is not a boolean —it is a
  // choice among several values— so it stays a `<select>` and keeps confirming: changing role
  // rewrites what the agent can do, and there is no "opposite" to revert to with one click.
  if (coleccion === 'memberships' && columna.clave === 'role') {
    const actual = typeof valor === 'string' ? valor : '';
    const opciones = rolesDisponibles(politicasDeRol, actual === '' ? undefined : actual);
    // Without the three identity fields there is no mutation to assemble. Previously `onChange` was
    // called the same and received `undefined`, so nothing happened: no write, no notice. Now the
    // control disables and the reason is written next to it — the difference between "can't" and "broken".
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

  // A full-paragraph field (`role_brief`: up to 1200 characters) pushes the other eleven columns
  // of "Agent registry" off-screen. It is shown summarized; the full text lives in the `title`,
  // in "View raw", and —to edit it— in the "Role" tab of the "Fleet now" drawer.
  if (esColumnaLarga(columna.clave) && typeof valor === 'string' && valor.trim() !== '') {
    return <span className="config-resumen" title={valor}>{resumirTextoLargo(valor)}</span>;
  }

  if (typeof valor === 'boolean') {
    return <Badge tone={valor ? 'online' : 'offline'}>{valor ? 'Sí' : 'No'}</Badge>;
  }
  if (esColumnaDeFecha(columna.clave)) return <FechaRelativa value={valor} />;
  if (Array.isArray(valor)) {
    // An empty list is a known datum —"has none"—, not UNKNOWN.
    return valor.length ? <span>{valor.map((item) => String(item)).join(', ')}</span> : <span className="unknown">(vacío)</span>;
  }
  if (valor !== null && typeof valor === 'object') return <code>{JSON.stringify(valor)}</code>;
  return <Unknown value={valor} />;
}

/**
 * Modal confirmation dialog carrying the exact mutation for non-boolean changes (role).
 * Mounted as a modal with `inert` on the background, a focus trap, and ESC support.
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
    // `inert` on the shell —not on `body`, where this dialog lives— is what actually disables the
    // header and the side bar: no mouse, no tab, no screen reader.
    const fondo = document.querySelector('.app-shell');
    fondo?.setAttribute('inert', '');
    confirmar.current?.focus();
    return () => {
      fondo?.removeAttribute('inert');
      abridor?.focus();
    };
  }, []);

  const atraparFoco = useFocusTrap(dialogo);
  // ESC cancels, and the tab wraps inside the dialog instead of going to the background.
  const teclado = (evento: KeyboardEvent<HTMLDivElement>) => {
    if (evento.key === 'Escape') { evento.stopPropagation(); onCancelar(); return; }
    atraparFoco(evento);
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
