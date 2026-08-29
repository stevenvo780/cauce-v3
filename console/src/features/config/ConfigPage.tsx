import { Braces, RotateCcw, Save, SearchCheck, ShieldOff } from 'lucide-react';
import { useMemo, useState, type SyntheticEvent } from 'react';
import { useApi } from '../../api/context';
import type {
  AnyConfigResource, ConfigAction, ConfigMutation, ConfigResource, ConsoleAccess,
} from '../../api/types';
import { useResource } from '../../api/use-resource';
import {
  Badge, EmptyState, ErrorState, LoadingState, Panel, RefreshButton, Time, Unknown
} from '../../components/ui';
import { permissionState } from '../../lib';
import {
  CONFIG_SIN_CONTROL_REASON, CONFIG_SIN_LECTURA_REASON, CONFIG_WRITE_NO_ACREDITADO_REASON,
  onNavClick,
} from '../../router';
import { AltaDeEspacios } from './AltaDeEspacios';
import { AREA_POR_DEFECTO, agruparPorArea, type ConfigAreaId } from './areas';
import { ArnesesPanel } from './ArnesesPanel';
import { CollectionTable, type AccionPendiente, type AvisoDeColeccion } from './CollectionTable';
import { configCollections } from './collections';
import {
  describeConfigError, esNegativaDePermiso, textoRecarga,
  type CaminoDeCambio, type ConfigChangeOutcome, type EstadoRecarga,
} from './config-change';
import { exactConfigurationReceipt } from './config-receipt';
import { useInterruptores } from './use-interruptores';
import './config.css';

const templates: Record<ConfigResource, ConfigMutation> = {
  tenant: { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', is_hub: false, enabled: true } },
  room: { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
  membership: { resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'agent', value: { role: 'agent', enabled: true } },
  acl_edge: { resource: 'acl_edge', action: 'create', from_tenant: 'Acme', to_tenant: 'Steven', value: { enabled: true, allow_route: false, allow_read: false, allow_control: false } },
  // No `command`, same as the harness step of the wizard: the column is stored and no execution path reads it (see
  // `campos-inertes.ts`). The schema still accepts it—whoever needs it writes it by hand right here, that is what
  // the escape hatch is for—, but the template no longer offers it pre-filled: a template is a suggestion, and we
  // don't suggest what does nothing.
  harness: { resource: 'harness', action: 'create', id: 'custom', value: { display_name: 'Custom harness', capabilities: [], enabled: true } },
  role_policy: { resource: 'role_policy', action: 'create', role: 'observer', value: { allow_route: false, allow_read: false, allow_control: false } },
  chain_policy: { resource: 'chain_policy', action: 'update', id: 'default', value: { progress_relay_enabled: true, progress_relay_max_events: 8, cycle_cut_enabled: true } },
  egress_destination: {
    resource: 'egress_destination', action: 'create', tenant_id: 'Acme', alias: 'agent', handle: 'owner_dm',
    value: {
    adapter: 'telegram', channel: 'telegram', conversation_id: 'synthetic-dm', conversation_kind: 'dm',
      display_label: 'DM del dueño', allow_kinds: ['task_complete'], require_prior_contact: true,
      contact_ttl_days: 30, min_interval_seconds: 300, max_per_hour: 2, max_per_day: 8, max_per_root: 1,
      enabled: true
    }
  },
};

  /**
   * `chain_policy` is a singleton: `ChainPolicyConfigMutationSchema` only accepts `update` on the `default` id.
   * Offering create/delete would be sending the operator straight into a sure 400.
   */
const actionsByResource: Partial<Record<ConfigResource, readonly ConfigAction[]>> = {
  chain_policy: ['update'],
};
const allActions: readonly ConfigAction[] = ['create', 'update', 'delete'];

function actionsFor(resource: ConfigResource): readonly ConfigAction[] {
  return actionsByResource[resource] ?? allActions;
}

  /**
   * Everything `ConfigMutationSchema` accepts on the server, including registry resources that have their own screen.
   * The console must not be a second allowlist that lags behind the protocol: here we only discard what the server
   * would reject anyway, and the authority is still the gateway's zod plus the RBAC of `authorizeMutation`.
   */
const RESOURCES: readonly AnyConfigResource[] = [
  'tenant', 'room', 'membership', 'acl_edge', 'harness', 'role_policy',
  'chain_policy', 'egress_destination',
  'agent', 'provider_account', 'alias_routing_ceiling', 'agent_account_binding',
];

function mutationText(resource: ConfigResource, action: ConfigAction): string {
  const mutation = structuredClone(templates[resource]);
  mutation.action = action;
  if (action === 'delete') delete mutation.value;
  return JSON.stringify(mutation, null, 2);
}

function parseMutation(text: string): ConfigMutation {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('La mutación debe ser un objeto JSON.');
  const mutation = value as Partial<ConfigMutation>;
  if (!RESOURCES.includes(String(mutation.resource) as AnyConfigResource)) {
    throw new Error('resource no reconocido.');
  }
  if (!allActions.includes(String(mutation.action) as ConfigAction)) throw new Error('action no reconocida.');
  return mutation as ConfigMutation;
}

  /**
   * Notice for a table action, bound to the collection where the operator clicked AND to the snapshot revision under
   * which it is true. Without the revision, the notice outlived what disproved it: it kept asserting "the tables are at
   * revision 2" after another write—the onboarding, the wizard, the raw editor, a rollback—moved them to 3.
   */
interface AvisoDeAccion extends AvisoDeColeccion {
  coleccion: string;
  revision: number | undefined;
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

export function ConfigPage() {
  const api = useApi();
  const config = useResource('configuration', () => api.getConfiguration());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [resource, setResource] = useState<ConfigResource>('acl_edge');
  const [action, setAction] = useState<ConfigAction>('create');
  const [editor, setEditor] = useState(() => mutationText('acl_edge', 'create'));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'success' | 'error' | 'parcial' }>();
  const [preview, setPreview] = useState<string>();
  const [chainedRevision, setChainedRevision] = useState<number>();
  const [pendiente, setPendiente] = useState<AccionPendienteVigente>();
  const [avisoDeAccion, setAvisoDeAccion] = useState<AvisoDeAccion>();
  // The audit trail has its OWN notices and its own preview. Previously `rollback()` wrote to `notice`/`preview`, which
  // render inside the raw editor's `<details>`—closed by default—: the POST went out, the server answered 201, and
  // the screen said absolutely nothing. A failing rollback looked EXACTLY like a working one. The outcome of a write
  // is painted next to the control that fired it, without opening anything.
  const [avisoDeRollback, setAvisoDeRollback] = useState<{ text: string; tone: 'success' | 'error' | 'parcial' }>();
  const [previewDeRollback, setPreviewDeRollback] = useState<string>();
  // The open tab. `/config` used to be A single scroll with sixteen panels in a row—the onboarding, the wizard, the
  // raw editor, twelve tables, and the audit trail—and touching an ACL edge required scrolling past the AI
  // subscription pool. What changes is the ORDER, not the scope: no collection is hidden, each one gets its own tab,
  // and unknown ones fall under "Others".
  const [area, setArea] = useState<ConfigAreaId>(AREA_POR_DEFECTO);
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
  const snapshotRevision = typeof config.data?.revision === 'number' ? config.data.revision : undefined;
  // The wizard chains mutations and the snapshot reload is asynchronous: until it catches up to the revision the last apply returned, that revision is the only one expected to be true.
  const expectedRevision = chainedRevision !== undefined
    && (snapshotRevision === undefined || snapshotRevision < chainedRevision)
    ? chainedRevision
    : snapshotRevision;
  const groups = useMemo(() => configCollections(config.data), [config.data]);
  const areas = useMemo(() => agruparPorArea(groups), [groups]);
  // A tab the snapshot no longer justifies ("Others", once the unknown collection disappears) must not leave the screen blank: it falls back to the default one.
  const areaVisible = areas.some((entrada) => entrada.area.id === area) ? area : AREA_POR_DEFECTO;
  const activa = areas.find((entrada) => entrada.area.id === areaVisible);
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
    (mutation) => change(mutation, false, 'directo'),
    snapshotRevision,
  );

  /**
   * Switching tabs cancels the pending confirmation and clears outcome notices.
   *
   * A confirmation describes ONE row in ONE table and is painted next to it; if the operator moves to another tab, the
   * `<pre>` they were reading is no longer in view, and returning later would show them a "Confirm" whose content
   * they no longer remember. Same with the green ones: they are valid only for the screen that produced them.
   */
  function irAArea(siguiente: ConfigAreaId) {
    setArea(siguiente);
    setPendiente(undefined);
    setAvisoDeAccion(undefined);
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
    setPreview(undefined);
    setNotice(undefined);
  }

  /** Editing the JSON invalidates what was said about the previous JSON: same reason as `selectTemplate`. */
  function editarMutacion(texto: string) {
    setEditor(texto);
    setPreview(undefined);
    setNotice(undefined);
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

  /** The only write path: shared by the raw editor, the wizard, the onboarding, and the tables. */
  async function change(
    mutation: ConfigMutation, dryRun: boolean, camino: CaminoDeCambio = 'previsualizado',
  ): Promise<ConfigChangeOutcome> {
    if (motivoDeSoloLectura) {
      return { ok: false, conflict: false, message: `Cambio bloqueado. ${motivoDeSoloLectura}` };
    }
    setBusy(true);
    try {
      const result = await api.changeConfiguration(mutation, {
        dryRun,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      if (!exactConfigurationReceipt(result, dryRun, mutation)) {
        const recarga = dryRun ? undefined : await releer();
        return {
          ok: false,
          conflict: false,
          uncertain: !dryRun,
          message: dryRun
            ? 'El servidor devolvió un 2xx sin el recibo exacto del dry-run; no se habilitó aplicar.'
            : 'El servidor devolvió un 2xx sin el recibo durable exacto del cambio. La escritura puede haberse aplicado; verificá la relectura antes de repetirla.',
          ...(recarga === undefined ? {} : { recarga }),
        };
      }
      // A dry-run does not write anything, so there is no snapshot to reread nor a reread to count.
      if (dryRun) return { ok: true, result };
      if (typeof result.revision === 'number') setChainedRevision(result.revision);
      return { ok: true, result, recarga: await releer() };
    } catch (error) {
      const described = describeConfigError(error, 'Cambio rechazado: UNKNOWN', camino);
      if (!described.conflict) return { ok: false, ...described };
      setChainedRevision(undefined);
      return { ok: false, ...described, recarga: await releer() };
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: SyntheticEvent, dryRun: boolean) {
    event.preventDefault();
    setNotice(undefined);
    let mutation: ConfigMutation;
    try {
      mutation = parseMutation(editor);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Mutación rechazada: UNKNOWN', tone: 'error' });
      return;
    }
    const outcome = await change(mutation, dryRun);
    if (!outcome.ok) {
      if (outcome.conflict) setPreview(undefined);
      setNotice({ text: outcome.message + textoRecarga(outcome.recarga), tone: 'error' });
      return;
    }
    if (dryRun) {
      setPreview(JSON.stringify(outcome.result, null, 2));
      return;
    }
    setPreview(undefined);
    setNotice({
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
    setAvisoDeAccion(undefined);
    // Limpiar `pendiente` ANTES del await: la guarda de arriba ya validó la revisión, y dejarlo vivo
    // mientras `change()` espera la relectura hace que la subida de revisión (1→2) lo pinte como
    // «vencido» —un alert rojo «otro operador cambió la config»— en una escritura que SÍ se aplicó.
    setPendiente(undefined);
    // `directo`: these buttons don't preview anything, so a 409 cannot redirect to "back to preview".
    const outcome = await change(accion.mutation, false, 'directo');
    if (!outcome.ok) {
      setAvisoDeAccion({
        coleccion, tone: 'error', revision: revisionTrasEscribir(outcome.recarga, snapshotRevision),
        text: outcome.uncertain
          ? `No se pudo acreditar «${accion.descripcion}»: ${outcome.message}${textoRecarga(outcome.recarga)}`
          : `NO se aplicó «${accion.descripcion}»: ${outcome.message}${textoRecarga(outcome.recarga)}`,
      });
      return;
    }
    setAvisoDeAccion({
      coleccion,
      revision: revisionTrasEscribir(outcome.recarga, snapshotRevision),
      tone: outcome.recarga && !outcome.recarga.releido ? 'parcial' : 'success',
      text: `${accion.descripcion}: aplicado en la revisión ${String(outcome.result.revision ?? 'UNKNOWN')} `
        + `(${outcome.result.summary ?? 'sin resumen del servidor'}).${textoRecarga(outcome.recarga)}`,
    });
  }

  /**
   * Revert a revision from the audit trail. Everything it says is written to `avisoDeRollback` and `previewDeRollback`,
   * which are painted INSIDE the audit trail panel itself, next to the buttons that fired it: `notice`/`preview` live
   * inside the raw editor's `<details>`, and there an outcome goes unread.
   */
  async function rollback(revisionId: string, dryRun: boolean) {
    if (motivoDeSoloLectura) {
      setPreviewDeRollback(undefined);
      setAvisoDeRollback({
        tone: 'error',
        text: `Rollback bloqueado. ${motivoDeSoloLectura}`,
      });
      return;
    }
    setBusy(true);
    setAvisoDeRollback(undefined);
    try {
      const result = await api.rollbackConfiguration(revisionId, {
        dryRun,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      if (!exactConfigurationReceipt(result, dryRun, undefined, Number(revisionId))) {
        setPreviewDeRollback(undefined);
        const recarga = dryRun ? undefined : await releer();
        setAvisoDeRollback({
          tone: 'error',
          text: dryRun
            ? `El servidor devolvió un 2xx sin el recibo exacto del preview de rollback ${revisionId}; no se acredita.`
            : `El servidor devolvió un 2xx sin el recibo durable exacto del rollback ${revisionId}. Puede haberse aplicado; verificá la relectura antes de repetirlo.${textoRecarga(recarga)}`,
        });
        return;
      }
      if (dryRun) {
        setPreviewDeRollback(JSON.stringify(result, null, 2));
        // A dry-run that says nothing is indistinguishable from a button that did nothing: the `<pre>` appears below, but the phrase is what gets read first.
        setAvisoDeRollback({
          tone: 'success',
          text: `Preview del rollback de la revisión ${revisionId} aceptado por el servidor: `
            + 'no se escribió nada todavía, revisá el resultado de abajo.',
        });
        return;
      }
      setPreviewDeRollback(undefined);
      if (typeof result.revision === 'number') setChainedRevision(result.revision);
      const recarga = await releer();
      setAvisoDeRollback({
        tone: recarga.releido ? 'success' : 'parcial',
        text: `Rollback atómico de la revisión ${revisionId} aplicado: revisión `
          + `${String(result.revision ?? 'UNKNOWN')}.${textoRecarga(recarga)}`,
      });
    } catch (error) {
      // `rollback`: this path does not preview before applying, so a 409 cannot redirect to "back to preview"—it redirects to picking the revision again over the new state.
      const described = describeConfigError(error, 'Rollback rechazado: UNKNOWN', 'rollback');
      if (!described.conflict) {
        setAvisoDeRollback({ text: described.message, tone: 'error' });
        return;
      }
      setChainedRevision(undefined);
      setPreviewDeRollback(undefined);
      const recarga = await releer();
      setAvisoDeRollback({ text: described.message + textoRecarga(recarga), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  if (config.loading && !config.data) return <LoadingState label="Leyendo configuración versionada…" />;
  // A 403 is NOT a crash: the GET was refused for lack of `read`. See `esNegativaDePermiso` and `SinPermisoDeLectura`.
  if (config.error && !config.data) {
    return esNegativaDePermiso(config.error)
      ? <SinPermisoDeLectura detalle={config.error.message} />
      : <ErrorState error={config.error} onRetry={config.reload} />;
  }

  return <div className="config-pagina">
    <header className="config-encabezado">
      <div>
        <h1>Ajustes y altas</h1>
        <p className="config-intro">
          Cada colección es una tabla y cada permiso un interruptor que se aplica al pulsarlo.
        </p>
      </div>
      <RefreshButton onClick={config.reload} loading={config.loading} />
    </header>

    {/* Without permission, NOTHING is hidden: the tables look the same and the buttons stay inert with the reason
        written out. An absent panel does not distinguish "I don't have permission" from "this does not exist". The
        reason goes INSIDE the permission line, not on a separate notice below: those were two stacked notices saying
        the same thing in different words, and two notices in a row that say the same thing train people to skip both. */}
    <PermisoDeEscritura access={access.data} estado={estadoPermisoDeEscritura} />

    {/* `useResource` keeps the last good data when a reread fails: without this notice, a failing GET went unnoticed anywhere, and the screen kept showing stale data with a fresh look. */}
    {config.error ? <p className="notice error" role="alert">
      La última relectura de la configuración falló ({config.error.message}): lo que ves es la
      ÚLTIMA lectura buena, no lo que el servidor tiene ahora.
    </p> : null}

    {/* The tabs are real buttons with `role="tab"`, not anchors or `<details>`: the keyboard and the screen reader must
        be able to tell which one is open. The list comes from `areas.ts`, which derives it from the snapshot—a new
        collection from the server falls under "Others" and shows the same way, instead of staying invisible behind a
        console allowlist. */}
    <div className="config-tabs" role="tablist" aria-label="Áreas de configuración">
      {areas.map(({ area: entrada }) => <button
        key={entrada.id}
        type="button"
        role="tab"
        aria-selected={entrada.id === areaVisible}
        className="config-tab"
        onClick={() => { irAArea(entrada.id); }}
      >{entrada.label}</button>)}
    </div>

    {/* The area description goes open, not in a tooltip: it is the first thing to read upon entering, and hiding
        behind a question mark exactly what orients you would repeat the defect this change is meant to fix.

        Open goes ONE sentence. The rest—what explains why the tab matters—goes folded: the operator who enters
        twenty times a day already knows it and was paying for the scroll twenty times. It is a `<details>` on purpose,
        not a tooltip: the folded content can be read with the keyboard, can be copied, and does not depend on the mouse. */}
    {activa ? <>
      <p className="config-area-descripcion">{activa.area.descripcion}</p>
      <details className="config-detalle">
        <summary>Qué es exactamente «{activa.area.label}»</summary>
        <p>{activa.area.detalle}</p>
      </details>
    </> : null}

    <div className="config-area" role="tabpanel" aria-label={activa?.area.label ?? 'Configuración'}>
      {areaVisible === 'espacios'
        ? <AltaDeEspacios soloLectura={soloLectura} busy={busy} onChange={change} />
        : null}

      {/* Before the bot registry, and not below it: the table is precisely what induces the error this panel
          corrects—a "Harness" column with a value written in appears to pick the program the bot runs, and does not
          pick it—. Placed after, it would read as a footnote to something the operator has already misinterpreted. */}
      {areaVisible === 'agentes' ? <ArnesesPanel /> : null}

      {(activa?.colecciones ?? []).map((coleccion) => {
        const pedido = pendiente?.coleccion === coleccion.key ? pendiente : undefined;
        // A pending confirmation is valid for the revision on which it was requested. If the snapshot moved
        // underneath—"Refresh", or another write—the row the operator read in the `<pre>` is no longer the one there:
        // the confirmation is canceled and announced, instead of being sent anyway against the new revision.
        const vigente = pedido !== undefined && pedido.revision === snapshotRevision;
        const vencida = pedido !== undefined && !vigente;
        // Same criterion for the outcome notice: it is valid for the state that produced it, and as soon as that state changes, it stops being shown instead of continuing to assert it.
        const propio = avisoDeAccion?.coleccion === coleccion.key
          && avisoDeAccion.revision === snapshotRevision
          ? { text: avisoDeAccion.text, tone: avisoDeAccion.tone }
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
          politicasDeRol={politicasDeRol}
          soloLectura={soloLectura}
          busy={busy}
          control={interruptores}
          {...(vigente ? { pendiente: pedido } : {})}
          {...(aviso ? { aviso } : {})}
          onPedir={(siguiente) => {
            setAvisoDeAccion(undefined);
            setPendiente({ ...siguiente, revision: snapshotRevision });
          }}
          onConfirmar={() => void confirmarAccion()}
          onCancelar={() => { setPendiente(undefined); }}
        />;
      })}

      {areaVisible === 'historial' ? <>
    <Panel title="Audit trail de configuración" subtitle="Rollback crea una nueva revisión; el historial nunca se reescribe.">
      {/* The `oldValue` the store keeps as the inverse is the WHOLE ROW that was there before, not the field that was
          touched, even if the mutation that was sent was partial. The operator cannot deduce that from a button labeled
          "Rollback", and the difference could cost them a teammate's change. */}
      <p className="notice" role="note">
        Deshacer restituye la FILA COMPLETA que había antes de esa revisión, no sólo el campo que se
        tocó: si otro operador cambió otro campo de la misma fila después, ese cambio también se
        revierte.
      </p>

      {/* The rollback outcome is painted HERE, above the table and in plain sight without opening anything: it is the
          only spot the operator is looking at when they press one of these buttons. */}
      {avisoDeRollback ? <p
        className={avisoDeRollback.tone === 'error' ? 'notice error' : avisoDeRollback.tone === 'parcial' ? 'notice parcial' : 'notice success'}
        role={avisoDeRollback.tone === 'success' ? 'status' : 'alert'}
      >{avisoDeRollback.text}</p> : null}
      {previewDeRollback ? <pre className="config-preview" aria-label="Preview del rollback">{previewDeRollback}</pre> : null}

      {!config.data?.revisions?.length ? <EmptyState>No hay revisiones.</EmptyState> : <div className="table-wrap config-audit"><table><thead><tr><th>Rev</th><th>Actor</th><th>Resumen</th><th>Fecha</th><th>Rollback</th></tr></thead><tbody>
        {config.data.revisions.map((revision, index) => <tr key={revision.id ?? index}><td><Badge tone="info"><Unknown value={revision.id} /></Badge></td><td><Unknown value={`${revision.actor_tenant ?? 'UNKNOWN'}:${revision.actor_alias ?? 'UNKNOWN'}`} /></td><td><Unknown value={revision.summary} /></td><td><Time value={revision.created_at} /></td><td>{revision.id ? <span className="config-actions"><button className="button small" disabled={soloLectura || busy} onClick={() => { if (revision.id) void rollback(revision.id, true); }}>Preview</button><button className="button small" disabled={soloLectura || busy} onClick={() => { if (revision.id) void rollback(revision.id, false); }}><RotateCcw size={14} />Rollback</button></span> : <Unknown value={null} />}</td></tr>)}
      </tbody></table></div>}
    </Panel>

    {/* The escape hatch: still alive and whole for everything that has no form (harness, role_policy, chain_policy,
        egress, and the four registry resources), but no longer the first thing the operator sees. */}
    <details className="config-editor">
      <summary><Braces size={14} aria-hidden="true" /> Editor de mutaciones JSON — válvula de escape para lo que no tiene formulario</summary>
      <Panel title="Mutation editor" subtitle={`Revisión esperada: ${String(expectedRevision ?? 'UNKNOWN')}`}>
        <form className="config-form" onSubmit={(event) => void submit(event, false)}>
          <label>Resource<select disabled={soloLectura || busy} value={resource} onChange={(event) => { selectTemplate(event.target.value as ConfigResource, action); }}>{Object.keys(templates).map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Action<select disabled={soloLectura || busy} value={action} onChange={(event) => { selectTemplate(resource, event.target.value as ConfigAction); }}>{actionsFor(resource).map((item) => <option key={item}>{item}</option>)}</select></label>
          <label className="config-json">Mutación JSON<textarea aria-label="Mutación JSON" disabled={soloLectura || busy} rows={12} value={editor} onChange={(event) => { editarMutacion(event.target.value); }} spellCheck={false} /></label>
          <div className="config-actions">
            <button className="button secondary" type="button" disabled={soloLectura || busy} onClick={(event) => void submit(event, true)}><SearchCheck size={16} />Preview / dry-run</button>
            <button className="button primary" type="submit" disabled={soloLectura || busy}><Save size={16} />Aplicar atómico</button>
          </div>
        </form>
        {preview ? <pre className="config-preview" aria-label="Resultado de preview">{preview}</pre> : null}
        {notice ? <p className={notice.tone === 'error' ? 'notice error' : notice.tone === 'parcial' ? 'notice parcial' : 'notice success'} role={notice.tone === 'success' ? 'status' : 'alert'}>{notice.text}</p> : null}
      </Panel>
    </details>
      </> : null}
    </div>
  </div>;
}

  /**
   * The write permission, stated in plain language.
   *
   * The first thing you used to read in `/config` was `RBAC config.write ALLOW Roles: operator`: four jargons in a
   * row, at 11.52px, above everything else. That does not answer the operator's only question on entry—"can I touch
   * this?"—and on top of that takes the place of the answer.
   *
   * The raw identifier is NOT discarded: it is what you need to cite to request the permission from whoever
   * administers it, and hiding it would leave the person who needs it with nothing to take to them. It goes after the
   * sentence and on a secondary tier.
   *
   * `unknown`—the RBAC could not be attested—preserves reading and navigation, but leaves each mutation inert. The
   * backend remains the authority; the UI must not use it as a substitute for a permission decision it could not obtain.
   */
function PermisoDeEscritura({
  access, estado,
}: {
  access?: ConsoleAccess;
  estado: ReturnType<typeof permissionState>;
}) {
  const texto = estado === 'allowed'
    ? 'Podés cambiar la configuración; todo cambio se deshace desde «Historial y JSON».'
    : estado === 'denied'
      // The EXACT wording from the sidebar (`CONFIG_SIN_CONTROL_REASON`): two different wordings for the same denial would lead the operator to believe they are two different problems.
      ? `Solo lectura: ${CONFIG_SIN_CONTROL_REASON} Los datos se muestran igual; lo que está `
        + 'apagado es todo lo que escribe.'
      : `Solo lectura: ${CONFIG_WRITE_NO_ACREDITADO_REASON}`;
  const roles = access?.roles?.length ? access.roles.join(', ') : 'UNKNOWN';
  return <p className="config-permiso" data-estado={estado} role="note">
    {texto}
    <span className="config-permiso-jerga">RBAC config.write · roles {roles}</span>
  </p>;
}

  /**
   * What someone arriving at `/config` via a bookmark without `read` permission sees.
   *
   * It names the READ permission, which is the one the refused GET requires; the sidebar's `control` wording belongs
   * to writing and would send the operator to ask for a permission that does not open this view. There is no "Retry"
   * button—repeating the request cannot grant a permission, and offering it is promising an exit that does not
   * exist—but there is a real exit to the homepage.
   *
   * The raw server message is shown the same, in the background: it is what you need to cite to request the
   * permission, and hiding it would leave the operator with nothing to take to whoever administers it.
   */
function SinPermisoDeLectura({ detalle }: { detalle: string }) {
  return (
    <div className="state-card" role="note">
      <ShieldOff aria-hidden="true" />
      <div>
        <strong>«Ajustes y altas» necesita permiso de lectura</strong>
        <p>{CONFIG_SIN_LECTURA_REASON}</p>
        <p className="muted">
          El servidor contestó 403: <span className="mono">{detalle || 'sin mensaje'}</span>. Reintentar
          no cambia nada: falta el permiso, no se cayó Cauce.
        </p>
      </div>
      <a className="button secondary" href="/" onClick={(event) => { onNavClick(event, '/'); }}>Ir a la portada</a>
    </div>
  );
}
