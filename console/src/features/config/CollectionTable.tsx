import { Dialog } from '@base-ui/react/dialog';
import { Braces } from 'lucide-react';
import { Fragment, useRef, type ReactNode } from 'react';
import type { FleetTarget } from '@cauce/protocol/fleet-operation';
import { groupOperationTarget } from './GroupMembershipModel';
import { configFormDefinition, type ConfigFormTarget } from './config-form-model';
import { cn } from '../../cn';
import { Button, CARD_TABLE, Notice, Outcome, PREVIEW, SCROLL, SectionCard } from '../../components/kit';
import { Badge, Desplazable, EmptyState, Time, Unknown } from '../../components/ui';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import type { ConfigCollection } from './collections';
import {
  accionDeRol, claveDeFila, columnaNumerica, columnasDe, detalleDeColumna, esColumnaDeFecha, esColumnaFundida,
  esColumnaLarga, identidadFundida, motivoSinCambioDeRol, resumirTextoLargo, rolesDisponibles,
  type AccionDeRol, type ColumnaTabla,
} from './collection-table';
import { columnasInertesDe, motivoInerte } from './campos-inertes';
import {
  CabeceraConAyuda, ConfirmarQuitarControl, FilaDeFallo, InterruptorDeCelda,
} from './Interruptor';
import { esCampoConmutable, explicacionDeCampo, interruptorDeFila } from './interruptores';
import type { ControlDeInterruptores } from './use-interruptores';

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
  onPedir, onConfirmar, onCancelar, editor, onFormAction, onFormAllowed, retiredRows, onGroupOperation,
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
  editor?: ReactNode;
  onFormAction?: (target: ConfigFormTarget) => void;
  onFormAllowed?: (target: ConfigFormTarget) => boolean;
  retiredRows?: Record<string, unknown>[];
  onGroupOperation?: (target: FleetTarget, kind: 'retire' | 'restore' | 'purge') => void;
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
  const formDefinition = configFormDefinition(key);

  return <SectionCard level={3} title={title}
    actions={rows ? <span className="text-xs text-muted tabular-nums">{filas.length} {filas.length === 1 ? 'fila' : 'filas'}</span> : undefined}>
    {formDefinition && onFormAction && !formDefinition.singleton ? <div className="flex flex-wrap gap-2">
      <Button disabled={soloLectura || busy || !rows || onFormAllowed?.({ collection: key, action: 'create' }) === false}
        onClick={() => { onFormAction({ collection: key, action: 'create' }); }}>Crear {formDefinition.label}</Button>
    </div> : null}
    {editor}
    {/* Clave ausente y lista vacía NO son lo mismo: un gateway anterior a una migración no publica
        su tabla, y decir «sin registros» ahí sería mentir. */}
    {!rows ? <EmptyState>UNKNOWN: este gateway no publica esta colección ({key}).</EmptyState>
      : !filas.length ? <EmptyState>Sin registros.</EmptyState>
        : <>
          {/* El desenlace de un interruptor se anuncia acá arriba, en un `role="status"` que el
              lector de pantalla lee solo: el interruptor moviéndose es una señal visual, y sin esto
              quien no ve la pantalla no se entera de que la escritura llegó. */}
          {avisoDeInterruptor ? <Outcome role="status" tone={avisoDeInterruptor.tone === 'parcial' ? 'parcial' : 'success'}>{avisoDeInterruptor.text}</Outcome> : null}

          {confirmandoAqui ? <ConfirmarQuitarControl control={control} busy={busy} /> : null}

          {/* El aviso de la tabla, UNA vez y arriba. No se esconden las columnas: el servidor las
              publica, y esconder un dato que existe es la otra forma de mentir sobre lo que hay
              configurado. */}
          {inertesPresentes.length ? <Notice role="note">
            Las columnas marcadas «declarativo» no configuran por sí solas el runtime.
            Cada una indica sus lectores y de dónde sale el valor en ejecución.
          </Notice> : null}

          <Desplazable etiqueta={title} className={SCROLL}><table className={CARD_TABLE}><thead><tr>
            {columnas.map((columna) => {
              const inerte = motivoInerte(key, columna.clave);
              return <th
                key={columna.clave}
                data-numero={numericas.has(columna.clave) ? 'true' : undefined}
                data-inerte={inerte === undefined ? undefined : 'true'}
                className={cn('whitespace-normal', numericas.has(columna.clave) && 'text-right', inerte !== undefined && 'opacity-70')}
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
            {formDefinition && onFormAction ? <th>Acciones</th> : null}
          </tr></thead><tbody>
            {filas.map((fila, indice) => {
              const filaId = claveDeFila(key, fila, indice);
              const fleetTarget = groupOperationTarget(key, fila);
              // One failure per row: the global `busy` serializes writes, so two toggles of the same
              // row cannot be rejected at the same time.
              const fallo = columnas
                .map((columna) => control.fallo(`${key}|${filaId}|${columna.clave}`))
                .find((encontrado) => encontrado !== undefined);
              return <Fragment key={filaId}>
                <tr>
                  {/* A column that configures nothing dims its cells with the same `data-inerte` as its
                      header: the value stays readable —it is what is declared— but stops competing
                      with the columns that do govern something. */}
                  {columnas.map((columna) => <td
                    key={columna.clave}
                    data-label={columna.etiqueta}
                    data-numero={numericas.has(columna.clave) ? 'true' : undefined}
                    data-inerte={motivoInerte(key, columna.clave) === undefined ? undefined : 'true'}
                    className={cn(numericas.has(columna.clave) && 'text-right tabular-nums', motivoInerte(key, columna.clave) !== undefined && 'opacity-60')}
                  >
                    <Celda
                      coleccion={key} columna={columna} fila={fila} filaId={filaId} indice={indice}
                      politicasDeRol={politicasDeRol} soloLectura={soloLectura} busy={busy}
                      control={control} onPedir={onPedir}
                    />
                  </td>)}
                  {formDefinition && onFormAction ? <td><div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={soloLectura || busy || onFormAllowed?.({ collection: key, action: 'update', row: fila }) === false}
                      aria-label={`Editar ${formDefinition.label} ${filaId}`}
                      onClick={() => { onFormAction({ collection: key, action: 'update', row: fila }); }}>Editar</Button>
                    {fleetTarget && onGroupOperation ? <Button size="sm" disabled={soloLectura || busy}
                      aria-label={`Retiro y recuperación de ${formDefinition.label} ${filaId}`}
                      onClick={() => { onGroupOperation(fleetTarget, 'retire'); }}>Retiro y recuperación</Button> : null}
                    {!formDefinition.singleton ? <Button size="sm" disabled={soloLectura || busy || onFormAllowed?.({ collection: key, action: 'delete', row: fila }) === false}
                      aria-label={`Eliminar ${formDefinition.label} ${filaId}`}
                      onClick={() => { onFormAction({ collection: key, action: 'delete', row: fila }); }}>Eliminar</Button> : null}
                    {['tenant', 'room', 'membership'].includes(formDefinition.resource) && onFormAllowed?.({ collection: key, action: 'retire', row: fila }) ? <Button
                      size="sm" disabled={soloLectura || busy}
                      aria-label={`Retirar ${formDefinition.label} ${filaId}`}
                      onClick={() => { onFormAction({ collection: key, action: 'retire', row: fila }); }}>Retirar</Button> : null}
                  </div></td> : null}
                </tr>
                {fallo ? <FilaDeFallo
                  fallo={fallo} columnas={columnas.length + (formDefinition && onFormAction ? 1 : 0)} control={control} busy={busy}
                /> : null}
              </Fragment>;
            })}
          </tbody></table></Desplazable>

          {pendiente ? <ConfirmacionDeAccion
            pendiente={pendiente} busy={busy} onConfirmar={onConfirmar} onCancelar={onCancelar}
          /> : null}

          {aviso ? <Outcome tone={aviso.tone}>{aviso.text}</Outcome> : null}

          {/* El JSON crudo no se borra: es la única forma de ver un campo que la tabla no tiene
              columna para mostrar. Lo que cambia es que ya no es lo primero que se ve. */}
          <details className="text-[13px]">
            <summary className="flex cursor-pointer items-center gap-1.5 text-muted"><Braces size={13} aria-hidden="true" /> Ver crudo ({filas.length} {filas.length === 1 ? 'fila' : 'filas'} tal cual {filas.length === 1 ? 'la publica' : 'las publica'} el servidor)</summary>
            <ul className="m-0 mt-2 grid max-h-80 list-none gap-1.5 overflow-auto p-0">
              {filas.map((fila, indice) => <li key={claveDeFila(key, fila, indice)} className="rounded-md bg-subtle p-2"><code className="text-xs break-all">{JSON.stringify(fila)}</code></li>)}
            </ul>
          </details>
        </>}
    {retiredRows?.length && formDefinition && onFormAction ? <div className="grid gap-3 rounded-lg border border-line bg-subtle p-3">
      <h3>Registros retirados</h3>
      <ul>{retiredRows.map((row, index) => {
        const rowId = claveDeFila(key, row, index);
        const fleetTarget = groupOperationTarget(key, row);
        return <li key={rowId}><span>{rowId} · {typeof row.display_name === 'string' ? row.display_name : typeof row.alias === 'string' ? row.alias : ''}</span>
          {fleetTarget && onGroupOperation ? <Button size="sm" disabled={soloLectura || busy}
            aria-label={`Historial y purga de ${formDefinition.label} ${rowId}`}
            onClick={() => { onGroupOperation(fleetTarget, 'purge'); }}>Historial y purga</Button> : null}
          <Button size="sm" disabled={soloLectura || busy || onFormAllowed?.({ collection: key, action: 'restore', row }) !== true}
            aria-label={`Restaurar ${formDefinition.label} ${rowId}`}
            onClick={() => { onFormAction({ collection: key, action: 'restore', row }); }}>Restaurar</Button>
        </li>;
      })}</ul>
    </div> : null}
  </SectionCard>;
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
    return arista === undefined ? <Unknown value={null} /> : <span className="font-mono text-[12.5px]">{arista}</span>;
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

  // A membership's PERMISSION role is not authored context. It stays a `<select>` because it
  // chooses a role_policy, and keeps confirming: changing it rewrites what the member can do and
  // has no boolean "opposite" to restore.
  if (coleccion === 'memberships' && columna.clave === 'role') {
    const actual = typeof valor === 'string' ? valor : '';
    const opciones = rolesDisponibles(politicasDeRol, actual === '' ? undefined : actual);
    // Without the three identity fields there is no mutation to assemble. Previously `onChange` was
    // called the same and received `undefined`, so nothing happened: no write, no notice. Now the
    // control disables and the reason is written next to it — the difference between "can't" and "broken".
    const motivo = motivoSinCambioDeRol(fila);
    return <>
      <select
        aria-label={`Rol de permisos de ${filaId}`}
        value={actual}
        disabled={soloLectura || busy || motivo !== undefined}
        title={motivo ?? (soloLectura ? CONFIG_SIN_CONTROL_REASON : undefined)}
        className="max-w-40 !min-h-8 !py-1"
        onChange={(event) => {
          const accion = accionDeRol(fila, event.target.value);
          if (accion) onPedir({ coleccion, filaId, accion });
        }}
      >
        {actual === '' ? <option value="">UNKNOWN</option> : null}
        {opciones.map((rol) => <option key={rol} value={rol}>{rol}</option>)}
      </select>
      {motivo ? <span className="mt-1 block max-w-64 text-xs font-medium text-muted italic">{motivo}</span> : null}
    </>;
  }

  // A full-paragraph field (`role_brief`: up to 1200 characters) pushes the other eleven columns
  // of "Agent registry" off-screen. It is shown summarized; the full text lives in the `title`,
  // in "View raw", and as a diagnostic projection in the single "Context" tab. It is not editable here.
  if (esColumnaLarga(columna.clave) && typeof valor === 'string' && valor.trim() !== '') {
    return <span className="block max-w-80 truncate" title={valor}>{resumirTextoLargo(valor)}</span>;
  }

  if (typeof valor === 'boolean') {
    const detalle = detalleDeColumna(coleccion, columna.clave, fila);
    return <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <Badge tone={valor ? 'online' : 'offline'}>{valor ? 'Sí' : 'No'}</Badge>
      {detalle.length ? <span className="text-xs text-muted">{detalle.join(' · ')}</span> : null}
    </span>;
  }
  if (esColumnaDeFecha(columna.clave)) return <Time value={valor} relativo />;
  if (Array.isArray(valor)) {
    // An empty list is a known datum —"has none"—, not UNKNOWN.
    return valor.length ? <span>{valor.map((item) => String(item)).join(', ')}</span> : <span className="text-muted italic">(vacío)</span>;
  }
  if (valor !== null && typeof valor === 'object') return <code>{JSON.stringify(valor)}</code>;
  return <Unknown value={valor} />;
}

/**
 * Confirmation carrying the exact mutation, for changes that are not a boolean flip (role).
 * Focus entry, Escape and the inert background come from the dialog primitive.
 */
function ConfirmacionDeAccion({ pendiente, busy, onConfirmar, onCancelar }: {
  pendiente: AccionPendiente;
  busy: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
}) {
  const confirmar = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open onOpenChange={(abierto) => { if (!abierto) onCancelar(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Popup initialFocus={confirmar}
          className="fixed top-1/2 left-1/2 z-50 grid max-h-[85dvh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-pop">
          <Dialog.Title className="m-0 text-[15px] font-normal">Confirmá el cambio: <strong>{pendiente.accion.descripcion}</strong>.</Dialog.Title>
          <details className="text-[13px]">
            <summary className="flex cursor-pointer items-center gap-1.5 text-muted"><Braces size={13} aria-hidden="true" /> Ver la mutación exacta que se va a enviar</summary>
            <pre className={cn(PREVIEW, 'mt-2')} aria-label="Mutación a aplicar">{JSON.stringify(pendiente.accion.mutation, null, 2)}</pre>
          </details>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" disabled={busy} onClick={onCancelar}>Cancelar</Button>
            <Button variant="primary" ref={confirmar} disabled={busy} onClick={onConfirmar}>Confirmar</Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
