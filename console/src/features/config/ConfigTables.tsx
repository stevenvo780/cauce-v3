import { useEffect, useState } from 'react';
import { ConfigCollectionForm } from './ConfigCollectionForm';
import { GroupEditor } from './GroupEditor';
import { groupHasRuntime, groupOperationTarget } from './GroupMembershipModel';
import { configFormDefinition } from './config-form-model';
import { canUseConfigForm, platformCatalogReason, retiredConfigRows } from './config-form-access';
import { CollectionTable, type AvisoDeColeccion } from './CollectionTable';
import { coleccionesDe, type ConfigSectionId } from './sections';
import { alcanceDeAccion, type ConfigWrites } from './use-config-writes';

/** The editable tables of one section, each wired to the shared write channels. */
export function TablasDeSeccion({ ctx, seccion, omitir = [] }: {
  ctx: ConfigWrites;
  seccion: ConfigSectionId;
  /** Collection keys this section paints with a view of its own. */
  omitir?: readonly string[];
}) {
  const { canalAccion, snapshotRevision, pendiente } = ctx;
  // Collection whose form just applied and closed: its success notice moves to the table,
  // because the form that painted it is gone. Opening another form retires it.
  const [aplicada, setAplicada] = useState<string>();
  useEffect(() => { if (ctx.formTarget) setAplicada(undefined); }, [ctx.formTarget]);
  return <>
    {coleccionesDe(seccion, ctx.groups).filter((coleccion) => !omitir.includes(coleccion.key)).map((coleccion) => {
      const pedido = pendiente?.coleccion === coleccion.key ? pendiente : undefined;
      // A pending confirmation is valid for the revision on which it was requested. If the snapshot moved
      // underneath —"Refresh", or another write— the row the operator read is no longer the one there: the
      // confirmation is canceled and announced instead of being sent against the new revision.
      const vigente = pedido !== undefined && pedido.revision === snapshotRevision;
      const vencida = pedido !== undefined && !vigente;
      // Same criterion for the outcome notice: it stops being shown as soon as the state that produced it changes.
      const propio = canalAccion.notice?.alcance === alcanceDeAccion(coleccion.key, snapshotRevision)
        ? { text: canalAccion.notice.text, tone: canalAccion.notice.tone }
        : undefined;
      const deFormulario = aplicada === coleccion.key && !ctx.formTarget && ctx.canalFormulario.notice
        ? { text: ctx.canalFormulario.notice.text, tone: ctx.canalFormulario.notice.tone }
        : undefined;
      const aviso: AvisoDeColeccion | undefined = vencida
        ? {
          tone: 'error',
          text: `La confirmación de «${pedido.accion.descripcion}» se anuló sola: la configuración `
            + `pasó a la revisión ${String(snapshotRevision ?? 'UNKNOWN')} mientras estaba pendiente, así `
            + 'que lo que ibas a firmar ya no describe la fila que hay. Volvé a pedir el cambio '
            + 'sobre el dato de ahora.',
        }
        : propio ?? deFormulario;
      const definition = configFormDefinition(coleccion.key);
      const Form = coleccion.key === 'rooms' ? GroupEditor : ConfigCollectionForm;
      const form = ctx.formTarget?.collection === coleccion.key && !ctx.formModal && definition && ctx.config.data
        ? <Form key={`${coleccion.key}:${ctx.formTarget.action}:${JSON.stringify(ctx.formTarget.row ?? {})}`}
          definition={definition} target={ctx.formTarget} snapshot={ctx.config.data} runner={ctx.canalFormulario} busy={ctx.busy}
          onCancel={() => { ctx.setFormTarget(undefined); ctx.canalFormulario.clear(); }} onRelated={ctx.openForm}
          onApplied={() => { setAplicada(coleccion.key); ctx.setFormTarget(undefined); }} />
        : undefined;
      const bloqueoDeCatalogo = definition && ctx.config.data
        ? platformCatalogReason(ctx.config.data, definition.resource)
        : undefined;
      return <CollectionTable
        key={coleccion.key}
        coleccion={coleccion}
        politicasDeRol={ctx.politicasDeRol}
        espacios={ctx.config.data?.tenants}
        soloLectura={ctx.soloLectura}
        busy={ctx.busy}
        control={ctx.interruptores}
        editor={form}
        {...(bloqueoDeCatalogo ? { bloqueoDeCatalogo } : {})}
        onFormAction={ctx.openForm}
        onFormAllowed={(target) => {
          const fleetTarget = target.row ? groupOperationTarget(target.collection, target.row) : undefined;
          if (target.action === 'delete' && fleetTarget && ctx.config.data && groupHasRuntime(ctx.config.data, fleetTarget)) return false;
          return Boolean(definition && ctx.config.data && canUseConfigForm(ctx.config.data, definition, target.action, target.row));
        }}
        onGroupOperation={(target, kind) => { ctx.setFormTarget(undefined); ctx.setRemoval({ target, kind }); }}
        retiredRows={retiredConfigRows(ctx.config.data, coleccion.key)}
        {...(vigente ? { pendiente: pedido } : {})}
        {...(aviso ? { aviso } : {})}
        onPedir={(siguiente) => {
          canalAccion.informar(undefined);
          ctx.setPendiente({ ...siguiente, revision: snapshotRevision });
        }}
        onConfirmar={() => void ctx.confirmarAccion()}
        onCancelar={() => { ctx.setPendiente(undefined); }}
      />;
    })}
  </>;
}
