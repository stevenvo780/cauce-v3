import { Braces, RotateCcw, Save, SearchCheck, ShieldOff } from 'lucide-react';
import { useMemo, useState, type SyntheticEvent } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import type {
  AnyConfigResource, ConfigAction, ConfigMutation, ConfigResource, ConsoleAccess,
} from '../../api/types';
import { useResource } from '../../api/use-resource';
import {
  Badge, Desplazable, EmptyState, ErrorState, LoadingState, Panel, RefreshButton, Time, Unknown,
  ViewTabs,
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
import { describeConfigError, esNegativaDePermiso, textoRecarga, type EstadoRecarga } from './config-change';
import { exactConfigurationReceipt } from './config-receipt';
import { useConfigMutation, useRevisionEncadenada, type ConfigMutationNotice } from './use-config-mutation';
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
   * Everything `ConfigMutationSchema` accepts on the server. `parseMutation` deliberately rejects the three account
   * registry resources after recognizing them: their typed and confirmed authority is `/accounts`, while `agent`
   * remains available here for fields that have no specialized editor.
   */
const RESOURCES: readonly AnyConfigResource[] = [
  'tenant', 'room', 'membership', 'acl_edge', 'harness', 'role_policy',
  'chain_policy', 'egress_destination',
  'agent', 'provider_account', 'alias_routing_ceiling', 'agent_account_binding',
];

const ACCOUNT_RESOURCES = new Set<AnyConfigResource>([
  'provider_account', 'alias_routing_ceiling', 'agent_account_binding',
]);

type RollbackPolicy =
  | { allowed: true }
  | { allowed: false; accountResource: boolean; message: string };

function rollbackPolicy(operation: unknown): RollbackPolicy {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    return {
      allowed: false,
      accountResource: false,
      message: 'Bloqueado: la revisión no publica una operación reconocible y no se puede acreditar que sea segura de revertir.',
    };
  }
  const candidate = operation as Record<string, unknown>;
  const resource = typeof candidate.resource === 'string' ? candidate.resource : undefined;
  if (resource && ACCOUNT_RESOURCES.has(resource as AnyConfigResource)) {
    return {
      allowed: false,
      accountResource: true,
      message: `Bloqueado: esta revisión modifica ${resource}; su única autoridad es Cuentas y cuotas.`,
    };
  }
  if (!resource || !RESOURCES.includes(resource as AnyConfigResource)
    || typeof candidate.action !== 'string'
    || !allActions.includes(candidate.action as ConfigAction)) {
    return {
      allowed: false,
      accountResource: false,
      message: 'Bloqueado: la revisión no publica una operación reconocible y no se puede acreditar que sea segura de revertir.',
    };
  }
  return { allowed: true };
}

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
  if (ACCOUNT_RESOURCES.has(String(mutation.resource) as AnyConfigResource)) {
    throw new Error(
      'Las cuentas, sus techos y sus bindings se modifican únicamente en «Cuentas y cuotas». '
      + 'Abrí /accounts para usar formularios tipados, confirmación y dry-run.',
    );
  }
  if (!allActions.includes(String(mutation.action) as ConfigAction)) throw new Error('action no reconocida.');
  const rawValue = (value as Record<string, unknown>).value;
  if (mutation.resource === 'agent' && rawValue !== null && typeof rawValue === 'object'
    && !Array.isArray(rawValue) && Object.hasOwn(rawValue, 'role_brief')) {
    throw new Error(
      '`agents.role_brief` es una proyección diagnóstica de sólo lectura. '
      + 'Modificá el contexto del agente en la pestaña única «Contexto» de «La flota ahora».',
    );
  }
  return mutation as ConfigMutation;
}

  /**
   * What a table-action notice is true for: the collection where the operator clicked AND the snapshot revision under
   * which it holds. Without the revision, the notice outlived what disproved it: it kept asserting "the tables are at
   * revision 2" after another write—the onboarding, the wizard, the raw editor, a rollback—moved them to 3.
   */
function alcanceDeAccion(coleccion: string, revision: number | undefined): string {
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

const PANEL_DE_AREA = 'config-area-panel';

  /**
   * The outcome of a write, in the channel that produced it. Each control painting its OWN slot is what keeps the raw
   * editor's notice from being read as a row action's; `data-canal` only names the channel the slot belongs to.
   */
function Aviso({ aviso, canal }: { aviso?: ConfigMutationNotice; canal: string }) {
  if (!aviso) return null;
  return <p
    className={aviso.tone === 'error' ? 'notice error' : aviso.tone === 'parcial' ? 'notice parcial' : 'notice success'}
    role={aviso.tone === 'success' ? 'status' : 'alert'}
    data-canal={canal}
  >{aviso.text}</p>;
}

export function ConfigPage() {
  return <ConsoleAccessBoundary><ConfigPageContent /></ConsoleAccessBoundary>;
}

function ConfigPageContent() {
  const api = useApi();
  const config = useResource('configuration', () => api.getConfiguration());
  const access = useConsoleAccess();
  const [resource, setResource] = useState<ConfigResource>('acl_edge');
  const [action, setAction] = useState<ConfigAction>('create');
  const [editor, setEditor] = useState(() => mutationText('acl_edge', 'create'));
  const [pendiente, setPendiente] = useState<AccionPendienteVigente>();
  // The open tab. `/config` used to be one scroll with onboarding, wizard, raw editor, every table, and audit trail.
  // General configuration stays grouped here; the account registry is intentionally absent because `/accounts` is
  // its typed authority. Unknown collections still fall under "Others".
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
    (mutation) => canalAccion.change(mutation, false, 'directo'),
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
          Topología y permisos: el contexto de cada agente se modifica sólo en «La flota ahora» → «Contexto».
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

    {/* The one tab strip of the console: `aria-controls`, roving tabIndex and arrow keys come with it. The list comes
        from `areas.ts`, which derives it from the snapshot—a new collection from the server falls under "Others" and
        shows the same way, instead of staying invisible behind a console allowlist. */}
    <ViewTabs
      variant="page"
      label="Áreas de configuración"
      panelId={PANEL_DE_AREA}
      tabs={areas.map(({ area: entrada }) => ({ id: entrada.id, label: entrada.label }))}
      active={areaVisible}
      onSelect={irAArea}
    />

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

    <div className="config-area" id={PANEL_DE_AREA} role="tabpanel" aria-label={activa?.area.label ?? 'Configuración'}>
      {areaVisible === 'espacios'
        ? <AltaDeEspacios soloLectura={soloLectura} busy={busy} onChange={canalEditor.change} />
        : null}

      {/* Before the bot registry, and not below it: the table is precisely what induces the error this panel
          corrects—a "Harness" column with a value written in appears to pick the program the bot runs, and does not
          pick it—. Placed after, it would read as a footnote to something the operator has already misinterpreted. */}
      {areaVisible === 'agentes' ? <ArnesesPanel /> : null}

      {areaVisible === 'agentes' ? <Panel
        title="Cuentas y ruteo de suscripciones"
        subtitle="El inventario de provider_account, los techos y los bindings tienen una única autoridad de lectura y escritura."
      >
        <p>Se administran junto con su consumo y su orden de fallback en «Cuentas y cuotas»; estas tablas no se repiten en Ajustes.</p>
        <a className="button secondary" href="/accounts" onClick={(event) => { onNavClick(event, '/accounts'); }}>
          Ir a Cuentas y cuotas
        </a>
      </Panel> : null}

      {(activa?.colecciones ?? []).map((coleccion) => {
        const pedido = pendiente?.coleccion === coleccion.key ? pendiente : undefined;
        // A pending confirmation is valid for the revision on which it was requested. If the snapshot moved
        // underneath—"Refresh", or another write—the row the operator read in the `<pre>` is no longer the one there:
        // the confirmation is canceled and announced, instead of being sent anyway against the new revision.
        const vigente = pedido !== undefined && pedido.revision === snapshotRevision;
        const vencida = pedido !== undefined && !vigente;
        // Same criterion for the outcome notice: it is valid for the state that produced it, and as soon as that state changes, it stops being shown instead of continuing to assert it.
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
          politicasDeRol={politicasDeRol}
          soloLectura={soloLectura}
          busy={busy}
          control={interruptores}
          {...(vigente ? { pendiente: pedido } : {})}
          {...(aviso ? { aviso } : {})}
          onPedir={(siguiente) => {
            canalAccion.informar(undefined);
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
      <Aviso aviso={canalRollback.notice} canal={canalRollback.canal} />
      {canalRollback.preview ? <pre className="config-preview" aria-label="Preview del rollback">{canalRollback.preview}</pre> : null}

      {!config.data?.revisions?.length ? <EmptyState>No hay revisiones.</EmptyState> : <Desplazable etiqueta="Historial de revisiones de configuración" className="table-wrap config-audit"><table><thead><tr><th>Rev</th><th>Actor</th><th>Resumen</th><th>Fecha</th><th>Rollback</th></tr></thead><tbody>
        {config.data.revisions.map((revision, index) => {
          const policy = rollbackPolicy(revision.operation);
          return <tr key={revision.id ?? index}><td><Badge tone="info"><Unknown value={revision.id} /></Badge></td><td><Unknown value={`${revision.actor_tenant ?? 'UNKNOWN'}:${revision.actor_alias ?? 'UNKNOWN'}`} /></td><td><Unknown value={revision.summary} /></td><td><Time value={revision.created_at} /></td><td>{revision.id && policy.allowed ? <span className="config-actions"><button className="button small" disabled={soloLectura || busy} onClick={() => { if (revision.id) void rollback(revision.id, revision.operation, true); }}>Preview</button><button className="button small" disabled={soloLectura || busy} onClick={() => { if (revision.id) void rollback(revision.id, revision.operation, false); }}><RotateCcw size={14} />Rollback</button></span> : revision.id && !policy.allowed ? <span>{policy.message}{policy.accountResource ? <> <a href="/accounts" onClick={(event) => { onNavClick(event, '/accounts'); }}>Abrir Cuentas y cuotas</a>.</> : null}</span> : <Unknown value={null} />}</td></tr>;
        })}
      </tbody></table></Desplazable>}
    </Panel>

    {/* The escape hatch remains for resources without forms. Account registry mutations are rejected here because
        their sole authority is /accounts; `agent` remains available, except for its read-only role_brief projection. */}
    <details className="config-editor">
      <summary><Braces size={14} aria-hidden="true" /> Editor de mutaciones JSON — válvula de escape para lo que no tiene formulario</summary>
      <Panel title="Mutation editor" subtitle={`Revisión esperada: ${String(canalEditor.expectedRevision ?? 'UNKNOWN')}`}>
        <form className="config-form" onSubmit={(event) => void submit(event, false)}>
          <label>Resource<select disabled={soloLectura || busy} value={resource} onChange={(event) => { selectTemplate(event.target.value as ConfigResource, action); }}>{Object.keys(templates).map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Action<select disabled={soloLectura || busy} value={action} onChange={(event) => { selectTemplate(resource, event.target.value as ConfigAction); }}>{actionsFor(resource).map((item) => <option key={item}>{item}</option>)}</select></label>
          <label className="config-json">Mutación JSON<textarea aria-label="Mutación JSON" disabled={soloLectura || busy} rows={12} value={editor} onChange={(event) => { editarMutacion(event.target.value); }} spellCheck={false} /></label>
          <div className="config-actions">
            <button className="button secondary" type="button" disabled={soloLectura || busy} onClick={(event) => void submit(event, true)}><SearchCheck size={16} />Preview / dry-run</button>
            <button className="button primary" type="submit" disabled={soloLectura || busy}><Save size={16} />Aplicar atómico</button>
          </div>
        </form>
        {canalEditor.preview ? <pre className="config-preview" aria-label="Resultado de preview">{canalEditor.preview}</pre> : null}
        <Aviso aviso={canalEditor.notice} canal={canalEditor.canal} />
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
