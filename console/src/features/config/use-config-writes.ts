import { useMemo, useState, type SyntheticEvent } from 'react';
import { useConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import type { ConfigAction, ConfigMutation, ConfigResource } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { permissionState } from '../../lib';
import {
  CONFIG_SIN_CONTROL_REASON, CONFIG_WRITE_NO_ACREDITADO_REASON,
} from '../../router';
import type { AccionPendiente } from './CollectionTable';
import { configCollections } from './collections';
import { describeConfigError, textoRecarga, type EstadoRecarga } from './config-change';
import { exactConfigurationReceipt } from './config-receipt';
import { actionsFor, mutationText, parseMutation, rollbackPolicy } from './mutation-editor';
import { useConfigMutation, useRevisionEncadenada } from './use-config-mutation';
import { useInterruptores } from './use-interruptores';

/**
 * What a table-action notice is true for: the collection where the operator clicked AND the snapshot revision under
 * which it holds. Without the revision, the notice outlived what disproved it: it kept asserting "the tables are at
 * revision 2" after another write—the onboarding, the wizard, the raw editor, a rollback—moved them to 3.
 */
export function alcanceDeAccion(coleccion: string, revision: number | undefined): string {
  return `${coleccion}@${String(revision ?? 'UNKNOWN')}`;
}

/**
 * The action awaiting confirmation PLUS the revision on which it was requested. A pending confirmation describes the
 * row AS IT STOOD: if the snapshot moved underneath (another operator, or the "Refresh" button itself), what the
 * operator read in the `<pre>` is no longer what is there, and sending it anyway with the new revision applies an
 * unsigned mutation.
 */
interface AccionPendienteVigente extends AccionPendiente {
  revision: number | undefined;
}

/**
 * The revision the snapshot has AFTER a write. If the reread arrived, the revision it brought is what the screen is
 * painting; if it did not, the snapshot stayed where it was.
 */
function revisionTrasEscribir(recarga: EstadoRecarga | undefined, actual: number | undefined): number | undefined {
  if (recarga?.releido) return recarga.revision;
  return actual;
}

export function useConfigWrites() {
  const api = useApi();
  const config = useResource('configuration', () => api.getConfiguration());
  const access = useConsoleAccess();
  const [resource, setResource] = useState<ConfigResource>('acl_edge');
  const [action, setAction] = useState<ConfigAction>('create');
  const [editor, setEditor] = useState(() => mutationText('acl_edge', 'create'));
  const [pendiente, setPendiente] = useState<AccionPendienteVigente>();
  // Navigating and reading remain available under RBAC `unknown`, but writing fails closed. A reload error also
  // invalidates a previous ALLOW: keeping it would enable mutations precisely when we can no longer attest that
  // `config.write` is still in force.
  const estadoPermisoDeEscritura = access.error
    ? 'unknown'
    : permissionState(access.data, 'config.write');
  const motivoDeSoloLectura = estadoPermisoDeEscritura === 'denied'
    ? CONFIG_SIN_CONTROL_REASON
    : estadoPermisoDeEscritura === 'unknown'
      ? CONFIG_WRITE_NO_ACREDITADO_REASON
      : undefined;
  const soloLectura = motivoDeSoloLectura !== undefined;
  const encadenado = useRevisionEncadenada();
  const escritura = {
    config,
    access,
    encadenado,
    fallback: 'Cambio rechazado: UNKNOWN',
    ...(motivoDeSoloLectura === undefined ? {} : { bloqueo: `Cambio bloqueado. ${motivoDeSoloLectura}` }),
  };
  /**
   * One channel per control that writes, because their outcomes are different assertions. The audit trail and the
   * table actions paint theirs NEXT TO the button that fired it; the raw editor's live inside a `<details>` closed by
   * default, where a failing rollback looked EXACTLY like a working one. All three share the same write path AND the
   * same chained revision: what a write leaves chained is true of the server, not of the control that fired it.
   */
  const canalEditor = useConfigMutation({ ...escritura, canal: 'editor' });
  const canalRollback = useConfigMutation({ ...escritura, canal: 'rollback' });
  const canalAccion = useConfigMutation({ ...escritura, canal: 'row-action' });
  const busy = canalEditor.busy || canalRollback.busy || canalAccion.busy;
  const snapshotRevision = typeof config.data?.revision === 'number' ? config.data.revision : undefined;
  const groups = useMemo(() => configCollections(config.data), [config.data]);
  const politicasDeRol = config.data?.role_policies ?? undefined;
  /**
   * The switches in the tables. They write through the SAME `change()` as the raw editor, the wizard, and the
   * onboarding—that is, `POST /v3/console/config/changes` with `expected_revision`—so there is no second write path
   * that can lag behind the first. What the hook adds is optimistic behavior and, above all, REVERSION when the
   * server rejects.
   *
   * `camino: 'directo'`: a switch does not preview anything, so a 409 cannot redirect to "back to preview".
   */
  const interruptores = useInterruptores(
    (mutation) => canalAccion.change(mutation, false, 'directo'),
    snapshotRevision,
  );

  /**
   * Switching section cancels the pending confirmation and clears outcome notices.
   *
   * A confirmation describes ONE row in ONE table and is painted next to it; if the operator moves to another section,
   * the `<pre>` they were reading is no longer in view, and returning later would show them a "Confirm" whose content
   * they no longer remember. Same with the green ones: they are valid only for the screen that produced them.
   */
  function alCambiarDeSeccion() {
    setPendiente(undefined);
    canalAccion.informar(undefined);
    interruptores.limpiar();
  }

  function selectTemplate(nextResource: ConfigResource, nextAction: ConfigAction) {
    // Switching resource can leave the action outside what that resource supports (chain_policy only accepts update):
    // it falls back to the first valid action instead of building an impossible mutation.
    const actions = actionsFor(nextResource);
    const validAction = actions.includes(nextAction) ? nextAction : actions[0];
    setResource(nextResource);
    setAction(validAction);
    setEditor(mutationText(nextResource, validAction));
    // The preview and notice were for the PREVIOUS mutation. Leaving the "applied" green under a different JSON turns it into an assertion about something the server never saw.
    canalEditor.clear();
  }

  /** Editing the JSON invalidates what was said about the previous JSON: same reason as `selectTemplate`. */
  function editarMutacion(texto: string) {
    setEditor(texto);
    canalEditor.clear();
  }

  /**
   * Rereads the snapshot and WAITS for the data. It is called after every write and every revision conflict: without
   * waiting, the screen would assert "reloaded" without having verified it, and on a 409 it would keep sending the
   * stale revision on every retry—a loop the operator cannot escape.
   */
  async function releer(): Promise<EstadoRecarga> {
    const resultado = await config.reload();
    if (resultado.error) return { releido: false, motivo: resultado.error.message };
    const revision = typeof resultado.data.revision === 'number' ? resultado.data.revision : undefined;
    return { releido: true, ...(revision === undefined ? {} : { revision }) };
  }

  async function submit(event: SyntheticEvent, dryRun: boolean) {
    event.preventDefault();
    canalEditor.informar(undefined);
    let mutation: ConfigMutation;
    try {
      mutation = parseMutation(editor);
    } catch (error) {
      canalEditor.informar({ text: error instanceof Error ? error.message : 'Mutación rechazada: UNKNOWN', tone: 'error' });
      return;
    }
    const outcome = await canalEditor.change(mutation, dryRun);
    if (!outcome.ok) {
      if (outcome.conflict) canalEditor.mostrar(undefined);
      canalEditor.informar({ text: outcome.message + textoRecarga(outcome.recarga), tone: 'error' });
      return;
    }
    if (dryRun) {
      canalEditor.mostrar(JSON.stringify(outcome.result, null, 2));
      return;
    }
    canalEditor.mostrar(undefined);
    canalEditor.informar({
      tone: outcome.recarga && !outcome.recarga.releido ? 'parcial' : 'success',
      text: `Cambio atómico aplicado en revisión ${String(outcome.result.revision ?? 'UNKNOWN')}: `
        + `${outcome.result.summary ?? 'UNKNOWN'}.${textoRecarga(outcome.recarga)}`,
    });
  }

  /**
   * Applies the table action the operator just confirmed. The green appears with the server's response—never before
   * sending—and also states whether the reread arrived: without that, the row could end up showing the old value with
   * a freshly-saved look.
   */
  async function confirmarAccion() {
    if (!pendiente) return;
    const { coleccion, accion } = pendiente;
    // Belt and suspenders: the confirmation isn't even painted when the snapshot moved underneath, but if it ever gets here it's still NOT sent. What the operator read described a different row.
    if (pendiente.revision !== snapshotRevision) {
      setPendiente(undefined);
      return;
    }
    canalAccion.informar(undefined);
    // Limpiar `pendiente` ANTES del await: la guarda de arriba ya validó la revisión, y dejarlo vivo
    // mientras `change()` espera la relectura hace que la subida de revisión (1→2) lo pinte como
    // «vencido» —un alert rojo «otro operador cambió la config»— en una escritura que SÍ se aplicó.
    setPendiente(undefined);
    // `directo`: these buttons don't preview anything, so a 409 cannot redirect to "back to preview".
    const outcome = await canalAccion.change(accion.mutation, false, 'directo');
    const alcance = alcanceDeAccion(coleccion, revisionTrasEscribir(outcome.recarga, snapshotRevision));
    if (!outcome.ok) {
      canalAccion.informar({
        alcance, tone: 'error',
        text: outcome.uncertain
          ? `No se pudo acreditar «${accion.descripcion}»: ${outcome.message}${textoRecarga(outcome.recarga)}`
          : `NO se aplicó «${accion.descripcion}»: ${outcome.message}${textoRecarga(outcome.recarga)}`,
      });
      return;
    }
    canalAccion.informar({
      alcance,
      tone: outcome.recarga && !outcome.recarga.releido ? 'parcial' : 'success',
      text: `${accion.descripcion}: aplicado en la revisión ${String(outcome.result.revision ?? 'UNKNOWN')} `
        + `(${outcome.result.summary ?? 'sin resumen del servidor'}).${textoRecarga(outcome.recarga)}`,
    });
  }

  /** Revert a revision from the audit trail. Its own channel: an outcome read inside the raw editor's `<details>` is an outcome nobody reads. */
  async function rollback(revisionId: string, operation: unknown, dryRun: boolean) {
    const policy = rollbackPolicy(operation);
    if (!policy.allowed) {
      canalRollback.mostrar(undefined);
      canalRollback.informar({ tone: 'error', text: policy.message });
      return;
    }
    if (motivoDeSoloLectura) {
      canalRollback.mostrar(undefined);
      canalRollback.informar({ tone: 'error', text: `Rollback bloqueado. ${motivoDeSoloLectura}` });
      return;
    }
    const expectedRevision = canalRollback.expectedRevision;
    canalRollback.informar(undefined);
    await canalRollback.ocupar(async () => {
      try {
        const result = await api.rollbackConfiguration(revisionId, {
          dryRun,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        });
        if (!exactConfigurationReceipt(result, dryRun, undefined, Number(revisionId))) {
          canalRollback.mostrar(undefined);
          const recarga = dryRun ? undefined : await releer();
          canalRollback.informar({
            tone: 'error',
            text: dryRun
              ? `El servidor devolvió un 2xx sin el recibo exacto del preview de rollback ${revisionId}; no se acredita.`
              : `El servidor devolvió un 2xx sin el recibo durable exacto del rollback ${revisionId}. Puede haberse aplicado; verificá la relectura antes de repetirlo.${textoRecarga(recarga)}`,
          });
          return;
        }
        if (dryRun) {
          canalRollback.mostrar(JSON.stringify(result, null, 2));
          // A dry-run that says nothing is indistinguishable from a button that did nothing: the `<pre>` appears below, but the phrase is what gets read first.
          canalRollback.informar({
            tone: 'success',
            text: `Preview del rollback de la revisión ${revisionId} aceptado por el servidor: `
              + 'no se escribió nada todavía, revisá el resultado de abajo.',
          });
          return;
        }
        canalRollback.mostrar(undefined);
        if (typeof result.revision === 'number') canalRollback.encadenar(result.revision);
        const recarga = await releer();
        canalRollback.informar({
          tone: recarga.releido ? 'success' : 'parcial',
          text: `Rollback atómico de la revisión ${revisionId} aplicado: revisión `
            + `${String(result.revision ?? 'UNKNOWN')}.${textoRecarga(recarga)}`,
        });
      } catch (error) {
        // `rollback`: this path does not preview before applying, so a 409 cannot redirect to "back to preview"—it redirects to picking the revision again over the new state.
        const described = describeConfigError(error, 'Rollback rechazado: UNKNOWN', 'rollback');
        if (!described.conflict) {
          canalRollback.informar({ text: described.message, tone: 'error' });
          return;
        }
        canalRollback.encadenar(undefined);
        canalRollback.mostrar(undefined);
        const recarga = await releer();
        canalRollback.informar({ text: described.message + textoRecarga(recarga), tone: 'error' });
      }
    });
  }

  return {
    config, access, groups, politicasDeRol, snapshotRevision,
    estadoPermisoDeEscritura, motivoDeSoloLectura, soloLectura, busy,
    canalEditor, canalRollback, canalAccion, interruptores,
    pendiente, setPendiente, confirmarAccion,
    resource, action, editor, selectTemplate, editarMutacion, submit,
    rollback, alCambiarDeSeccion,
  };
}

export type ConfigWrites = ReturnType<typeof useConfigWrites>;
