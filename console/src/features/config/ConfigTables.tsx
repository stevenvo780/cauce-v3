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
      const aviso: AvisoDeColeccion | undefined = vencida
        ? {
          tone: 'error',
          text: `La confirmación de «${pedido.accion.descripcion}» se anuló sola: la configuración `
            + `pasó a la revisión ${String(snapshotRevision ?? 'UNKNOWN')} mientras estaba pendiente, así `
            + 'que lo que ibas a firmar ya no describe la fila que hay. Volvé a pedir el cambio '
            + 'sobre el dato de ahora.',
        }
        : propio;
      return <CollectionTable
        key={coleccion.key}
        coleccion={coleccion}
        politicasDeRol={ctx.politicasDeRol}
        soloLectura={ctx.soloLectura}
        busy={ctx.busy}
        control={ctx.interruptores}
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
