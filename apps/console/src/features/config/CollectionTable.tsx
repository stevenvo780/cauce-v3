import { Braces } from 'lucide-react';
import { Fragment, useEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { CONFIG_SIN_CONTROL_REASON } from '../../navigation';
import { Badge, EmptyState, Panel, Unknown } from '../../components/ui';
import type { ConfigCollection } from './collections';
import {
  accionDeRol, claveDeFila, columnaNumerica, columnasDe, esColumnaDeFecha, esColumnaFundida,
  esColumnaLarga, identidadFundida, motivoSinCambioDeRol, resumirTextoLargo, rolesDisponibles,
  type AccionDeRol, type ColumnaTabla,
} from './collection-table';
import {
  CabeceraConAyuda, ConfirmarQuitarControl, FechaRelativa, FilaDeFallo, InterruptorDeCelda,
} from './Interruptor';
import { esCampoConmutable, explicacionDeCampo, interruptorDeFila } from './interruptores';
import type { ControlDeInterruptores } from './use-interruptores';
import './toggles.css';

/** Qué cambio de ROL de qué fila está esperando el «Confirmar». Sólo hay uno a la vez. */
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
 * Una colección del snapshot como TABLA, con los booleanos como INTERRUPTORES.
 *
 * Lo que había antes de este cambio, medido en Chrome sobre la pantalla real:
 *  - `Directed ACL`: 24 botones de texto para 6 filas —«Deshabilitar», «Quitar allow_route»,
 *    «Quitar allow_read», «Quitar allow_control»— apilados en una columna «Acciones», con la fila
 *    a 147 px de alto;
 *  - el mismo dato dicho DOS veces por permiso: la píldora decía «SÍ» y el botón de al lado decía
 *    «Deshabilitar»;
 *  - «Espacios y miembros»: 30 botones con el texto exacto «Deshabilitar» y 3.769 px de alto.
 *
 * Ahora cada booleano escribible es un interruptor en su propia columna: dice el estado y lo cambia
 * en el mismo sitio. La columna «Acciones» desapareció porque no le quedaba nada que hacer.
 */
export function CollectionTable({
  coleccion, politicasDeRol, soloLectura, busy, control, pendiente, aviso,
  onPedir, onConfirmar, onCancelar,
}: {
  coleccion: ConfigCollection;
  /** `role_policies` del snapshot: alimenta el selector de rol de las memberships. */
  politicasDeRol: ReadonlyArray<Record<string, unknown>> | undefined;
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
  // Qué columnas se alinean a la derecha. Se decide por los DATOS de esta colección y no por una
  // lista de nombres: `max_per_hour` es numérico acá y podría no serlo en un gateway que publique
  // otra cosa con ese nombre. Ver `columnaNumerica`.
  const numericas = new Set(columnas.filter((columna) => columnaNumerica(filas, columna.clave)).map((columna) => columna.clave));
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

          <div className="table-wrap"><table><thead><tr>
            {columnas.map((columna) => <th key={columna.clave} data-numero={numericas.has(columna.clave) ? 'true' : undefined}>
              <CabeceraConAyuda
                etiqueta={columna.etiqueta}
                {...(() => {
                  const ayuda = explicacionDeCampo(key, columna.clave);
                  return ayuda === undefined ? {} : { explicacion: ayuda };
                })()}
              />
            </th>)}
          </tr></thead><tbody>
            {filas.map((fila, indice) => {
              const filaId = claveDeFila(key, fila, indice);
              // Un fallo por fila: el `busy` global serializa las escrituras, así que no puede
              // haber dos interruptores de la misma fila rechazados a la vez.
              const fallo = columnas
                .map((columna) => control.fallo(`${key}|${filaId}|${columna.clave}`))
                .find((encontrado) => encontrado !== undefined);
              return <Fragment key={filaId}>
                <tr>
                  {columnas.map((columna) => <td key={columna.clave} data-numero={numericas.has(columna.clave) ? 'true' : undefined}>
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

function Celda({
  coleccion, columna, fila, filaId, indice, politicasDeRol, soloLectura, busy, control, onPedir,
}: {
  coleccion: string;
  columna: ColumnaTabla;
  fila: Record<string, unknown>;
  filaId: string;
  indice: number;
  politicasDeRol: ReadonlyArray<Record<string, unknown>> | undefined;
  soloLectura: boolean;
  busy: boolean;
  control: ControlDeInterruptores;
  onPedir: (pendiente: AccionPendiente) => void;
}) {
  // La columna de identidad fundida: `Desde` + `Hacia` se leen como una sola arista.
  if (esColumnaFundida(coleccion, columna.clave)) {
    const arista = identidadFundida(coleccion, fila);
    return arista === undefined ? <Unknown value={null} /> : <span className="mono">{arista}</span>;
  }

  const valor = fila[columna.clave];

  // **El interruptor.** Sólo sale si se puede armar la mutación con lo que la fila trae: si no,
  // se cae a la píldora de sólo lectura, que dice el dato sin prometer que se pueda cambiar.
  if (esCampoConmutable(coleccion, columna.clave)) {
    const interruptor = interruptorDeFila(coleccion, fila, columna.clave, indice);
    if (interruptor) {
      return <InterruptorDeCelda
        interruptor={interruptor} control={control} soloLectura={soloLectura} busy={busy}
      />;
    }
  }

  // El rol de una membership se cambia acá mismo, en su propia columna. No es un booleano —es una
  // elección entre varios valores—, así que sigue siendo un `<select>` y sigue confirmando: cambiar
  // de rol reescribe qué puede hacer ese agente, y no hay «el contrario» al que volver de un clic.
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
  if (esColumnaDeFecha(columna.clave)) return <FechaRelativa value={valor} />;
  if (Array.isArray(valor)) {
    // Una lista vacía es un dato conocido —«no tiene ninguna»—, no un UNKNOWN.
    return valor.length ? <span>{valor.map((item) => String(item)).join(', ')}</span> : <span className="unknown">(vacío)</span>;
  }
  if (valor !== null && typeof valor === 'object') return <code>{JSON.stringify(valor)}</code>;
  return <Unknown value={valor} />;
}

/**
 * Confirmación con la mutación EXACTA a la vista. Queda SÓLO para el cambio de rol: lo que se firma
 * es una escritura versionada en `config_revisions` y el rol no tiene «el contrario» al que volver
 * con otro clic, así que acá el JSON sí se lee antes de que viaje.
 *
 * Los booleanos ya no pasan por acá. Confirmar veinte veces seguidas no protege de nada: enseña a
 * apretar «Confirmar» sin leer, y el día que aparece el que importa ya nadie lo lee.
 *
 * Y es un DIÁLOGO, no un bloque pegado debajo del control que lo abre. Eso último costaba tres
 * cosas medidas en Chrome contra el snapshot real:
 *  - 269 px de alto, de los cuales 170 eran el volcado de JSON. En un viewport de 900 px
 *    «Confirmar» y «Cancelar» caían en y=999..1039, o sea INVISIBLES: había que adivinar que se
 *    baja.
 *  - `aria-modal` ausente, ESC sin efecto y el foco quieto en el control de la fila.
 *  - el fondo seguía siendo pulsable: con la confirmación abierta se podía apretar «Cerrar sesión»
 *    de la cabecera —pasó de verdad durante la revisión— y la sesión se cerraba con el cambio a
 *    medio firmar.
 *
 * Ahora se monta en `document.body` (fuera de `.app-shell`), pone el resto de la página en `inert`
 * mientras vive, atrapa el tabulador, se cierra con ESC o con clic fuera, y devuelve el foco al
 * control que lo abrió. Los dos botones viven en un pie que NO scrollea, así que no pueden quedar
 * debajo del pliegue por largo que sea el JSON. Y el JSON pasa a estar detrás de «Ver la mutación
 * exacta»: sigue entero y a un clic, pero ya no empuja la decisión fuera de la pantalla.
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
