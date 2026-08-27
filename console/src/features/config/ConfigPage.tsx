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
  CONFIG_SIN_CONTROL_REASON, CONFIG_WRITE_NO_ACREDITADO_REASON, onNavClick,
} from '../../navigation';
import { AltaDeEspacios } from './AltaDeEspacios';
import { AREA_POR_DEFECTO, agruparPorArea, type ConfigAreaId } from './areas';
import { ArnesesPanel } from './ArnesesPanel';
import { CollectionTable, type AccionPendiente, type AvisoDeColeccion } from './CollectionTable';
import { configCollections } from './collections';
import {
  describeConfigError, esNegativaDeControl, textoRecarga,
  type CaminoDeCambio, type ConfigChangeOutcome, type EstadoRecarga,
} from './config-change';
import { exactConfigurationReceipt } from './config-receipt';
import { RolesPanel } from './RolesPanel';
import { useInterruptores } from './use-interruptores';
import './config.css';

const templates: Record<ConfigResource, ConfigMutation> = {
  tenant: { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', is_hub: false, enabled: true } },
  room: { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
  membership: { resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'agent', value: { role: 'agent', enabled: true } },
  acl_edge: { resource: 'acl_edge', action: 'create', from_tenant: 'Acme', to_tenant: 'Steven', value: { enabled: true, allow_route: false, allow_read: false, allow_control: false } },
  // Sin `command`, igual que el paso de harness del wizard: la columna se guarda y no la lee ningún
  // camino de ejecución (ver `campos-inertes.ts`). El esquema la sigue aceptando —quien la necesite
  // la escribe a mano acá mismo, que para eso es la válvula de escape—, pero la plantilla ya no la
  // ofrece rellena: una plantilla es una sugerencia, y no se sugiere lo que no hace nada.
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
 * `chain_policy` es un singleton: `ChainPolicyConfigMutationSchema` sólo acepta `update` sobre el id
 * `default`. Ofrecer create/delete sería mandar al operador a un 400 seguro.
 */
const actionsByResource: Partial<Record<ConfigResource, readonly ConfigAction[]>> = {
  chain_policy: ['update'],
};
const allActions: readonly ConfigAction[] = ['create', 'update', 'delete'];

function actionsFor(resource: ConfigResource): readonly ConfigAction[] {
  return actionsByResource[resource] ?? allActions;
}

/**
 * Todo lo que `ConfigMutationSchema` acepta en el servidor, incluidos los recursos del registro que
 * tienen su propia pantalla. La consola no debe ser un segundo allowlist que se queda atrás del
 * protocolo: acá sólo se descarta lo que el servidor rechazaría igual, y la autoridad sigue siendo
 * el zod del gateway más el RBAC de `authorizeMutation`.
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
 * Aviso de una acción de tabla, atado a la colección donde el operador hizo clic Y a la revisión
 * del snapshot bajo la que es verdad. Sin la revisión el cartel sobrevivía a lo que lo desmiente:
 * seguía afirmando «las tablas están en la revisión 2» después de que otra escritura —el alta, el
 * wizard, el editor crudo, un rollback— las movió a la 3.
 */
interface AvisoDeAccion extends AvisoDeColeccion {
  coleccion: string;
  revision: number | undefined;
}

/**
 * La acción que espera confirmación MÁS la revisión sobre la que se pidió. Una confirmación
 * pendiente describe la fila TAL COMO ESTABA: si el snapshot se movió debajo (otro operador, o el
 * propio botón «Actualizar»), lo que el operador leyó en el `<pre>` ya no es lo que hay, y mandarlo
 * igual con la revisión nueva aplica una mutación que nadie firmó.
 */
interface AccionPendienteVigente extends AccionPendiente {
  revision: number | undefined;
}

/**
 * La revisión que el snapshot tiene DESPUÉS de una escritura. Si la relectura llegó, la revisión
 * que trajo es la que la pantalla está pintando; si no llegó, el snapshot se quedó donde estaba.
 */
function revisionTrasEscribir(recarga: EstadoRecarga | undefined, actual: number | undefined): number | undefined {
  if (recarga && recarga.releido) return recarga.revision;
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
  // El audit trail tiene sus PROPIOS avisos y su propio preview. Antes `rollback()` escribía en
  // `notice`/`preview`, que se pintan dentro del `<details>` del editor crudo —cerrado por
  // defecto—: el POST viajaba, el servidor contestaba 201, y la pantalla no decía absolutamente
  // nada. Un rollback que falla se veía EXACTAMENTE igual que uno que funciona. El desenlace de
  // una escritura se pinta junto al control que la disparó y sin abrir nada.
  const [avisoDeRollback, setAvisoDeRollback] = useState<{ text: string; tone: 'success' | 'error' | 'parcial' }>();
  const [previewDeRollback, setPreviewDeRollback] = useState<string>();
  // La pestaña abierta. `/config` era UN scroll con dieciséis paneles seguidos —el alta, el wizard,
  // el editor crudo, doce tablas y el audit trail— y para tocar una arista de ACL había que pasar
  // por delante del pool de suscripciones de IA. Lo que cambia es el ORDEN, no el alcance: no se
  // esconde ninguna colección, cada una tiene su pestaña y las desconocidas caen en «Otros».
  const [area, setArea] = useState<ConfigAreaId>(AREA_POR_DEFECTO);
  // Navegar y leer siguen disponibles con RBAC `unknown`, pero escribir falla cerrado. Un error de
  // recarga invalida también un ALLOW anterior: conservarlo habilitaría mutaciones justo cuando ya
  // no se puede acreditar que `config.write` siga vigente.
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
  // El wizard encadena mutaciones y la recarga del snapshot es asíncrona: hasta que ésta alcanza
  // la revisión que devolvió el último apply, esa revisión es la única esperada verdadera.
  const expectedRevision = chainedRevision !== undefined
    && (snapshotRevision === undefined || snapshotRevision < chainedRevision)
    ? chainedRevision
    : snapshotRevision;
  const groups = useMemo(() => configCollections(config.data), [config.data]);
  const areas = useMemo(() => agruparPorArea(groups), [groups]);
  // Una pestaña que el snapshot dejó de justificar («Otros», al desaparecer la colección
  // desconocida) no debe dejar la pantalla en blanco: se cae a la de por defecto.
  const areaVisible = areas.some((entrada) => entrada.area.id === area) ? area : AREA_POR_DEFECTO;
  const activa = areas.find((entrada) => entrada.area.id === areaVisible);
  const politicasDeRol = config.data?.role_policies ?? undefined;
  /**
   * Los interruptores de las tablas. Escriben por el MISMO `change()` que el editor crudo, el
   * wizard y el alta —o sea, `POST /v3/console/config/changes` con `expected_revision`—, así que no
   * hay un segundo camino de escritura que pueda quedarse atrás del primero. Lo que el hook agrega
   * es el comportamiento optimista y, sobre todo, la REVERSIÓN cuando el servidor rechaza.
   *
   * `camino: 'directo'`: un interruptor no previsualiza nada, así que un 409 no puede mandar a
   * «volver a previsualizar».
   */
  const interruptores = useInterruptores(
    (mutation) => change(mutation, false, 'directo'),
    snapshotRevision,
  );

  /**
   * Cambiar de pestaña anula la confirmación pendiente y borra los carteles de desenlace.
   *
   * Una confirmación describe UNA fila de UNA tabla y se pinta junto a ella; si el operador se va a
   * otra pestaña, el `<pre>` que estaba leyendo deja de estar a la vista y volver más tarde le
   * mostraría un «Confirmar» cuyo contenido ya no recuerda. Lo mismo con los verdes: valen para la
   * pantalla que los produjo.
   */
  function irAArea(siguiente: ConfigAreaId) {
    setArea(siguiente);
    setPendiente(undefined);
    setAvisoDeAccion(undefined);
    interruptores.limpiar();
  }

  function selectTemplate(nextResource: ConfigResource, nextAction: ConfigAction) {
    // Cambiar de recurso puede dejar la acción fuera de lo que ese recurso admite (chain_policy
    // sólo acepta update): se cae a la primera acción válida en vez de armar una mutación imposible.
    const actions = actionsFor(nextResource);
    const validAction = actions.includes(nextAction) ? nextAction : actions[0];
    setResource(nextResource);
    setAction(validAction);
    setEditor(mutationText(nextResource, validAction));
    // El preview y el aviso valían para la mutación ANTERIOR. Dejar el verde de «aplicado» debajo
    // de un JSON distinto lo convierte en una afirmación sobre algo que el servidor nunca vio.
    setPreview(undefined);
    setNotice(undefined);
  }

  /** Tocar el JSON invalida lo que se dijo del JSON anterior: mismo motivo que `selectTemplate`. */
  function editarMutacion(texto: string) {
    setEditor(texto);
    setPreview(undefined);
    setNotice(undefined);
  }

  /**
   * Relee el snapshot y ESPERA el dato. Se llama después de toda escritura y después de todo
   * conflicto de revisión: sin esperarla, la pantalla afirmaría «se recargó» sin haberlo
   * comprobado, y en el caso del 409 seguiría mandando la revisión vencida en cada reintento —un
   * bucle del que el operador no puede salir.
   */
  async function releer(): Promise<EstadoRecarga> {
    const resultado = await config.reload();
    if (resultado.error) return { releido: false, motivo: resultado.error.message };
    const revision = typeof resultado.data.revision === 'number' ? resultado.data.revision : undefined;
    return { releido: true, ...(revision === undefined ? {} : { revision }) };
  }

  /** Único camino de escritura: lo comparten el editor crudo, el wizard, el alta y las tablas. */
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
      // Un dry-run no escribe nada, así que no hay snapshot que releer ni relectura que contar.
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
      text: `Cambio atómico aplicado en revisión ${outcome.result.revision ?? 'UNKNOWN'}: `
        + `${outcome.result.summary ?? 'UNKNOWN'}.${textoRecarga(outcome.recarga)}`,
    });
  }

  /**
   * Aplica la acción de tabla que el operador acaba de confirmar. El verde sale con la respuesta
   * del servidor —nunca antes de mandar— y dice además si la relectura llegó: sin eso, la fila
   * podría quedar mostrando el valor viejo con cara de recién guardado.
   */
  async function confirmarAccion() {
    if (!pendiente) return;
    const { coleccion, accion } = pendiente;
    // Cinturón además del tirante: la confirmación ni siquiera se pinta cuando el snapshot se movió
    // debajo, pero si llegara acá igual NO se manda. Lo que el operador leyó describía otra fila.
    if (pendiente.revision !== snapshotRevision) {
      setPendiente(undefined);
      return;
    }
    setAvisoDeAccion(undefined);
    // `directo`: estos botones no previsualizan nada, así que el 409 no puede mandar a «volver a
    // previsualizar».
    const outcome = await change(accion.mutation, false, 'directo');
    // La mutación confirmada ya viajó (o fue rechazada): en cualquier caso deja de estar pendiente.
    // Reintentarla tal cual después de un 409 volvería a chocar contra la revisión vencida.
    setPendiente(undefined);
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
      text: `${accion.descripcion}: aplicado en la revisión ${outcome.result.revision ?? 'UNKNOWN'} `
        + `(${outcome.result.summary ?? 'sin resumen del servidor'}).${textoRecarga(outcome.recarga)}`,
    });
  }

  /**
   * Deshacer una revisión desde el audit trail. Todo lo que dice se escribe en `avisoDeRollback` y
   * `previewDeRollback`, que se pintan DENTRO del propio panel del audit trail, junto a los botones
   * que lo dispararon: `notice`/`preview` viven dentro del `<details>` del editor crudo y ahí un
   * desenlace no lo lee nadie.
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
        // Un dry-run que no dice nada no se distingue de un botón que no hizo nada: el `<pre>` sale
        // debajo, pero la frase es lo que se lee primero.
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
          + `${result.revision ?? 'UNKNOWN'}.${textoRecarga(recarga)}`,
      });
    } catch (error) {
      // `rollback`: este camino no previsualiza para aplicar, así que el 409 no puede mandar a
      // «volver a previsualizar» — manda a volver a elegir la revisión sobre el estado nuevo.
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
  // Un 403 NO es una caída: es el mismo permiso que la barra lateral ya explica. Ver
  // `esNegativaDeControl` y `SinPermisoDeControl`.
  if (config.error && !config.data) {
    return esNegativaDeControl(config.error)
      ? <SinPermisoDeControl detalle={config.error.message} />
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

    {/* Sin permiso NO se esconde nada: las tablas se ven igual y los botones quedan inertes con el
        motivo escrito. Un panel ausente no distingue «no tengo permiso» de «esto no existe».
        El motivo va DENTRO de la línea del permiso y no en un cartel aparte debajo: eran dos
        avisos apilados diciendo lo mismo con distintas palabras, y dos carteles seguidos que dicen
        lo mismo enseñan a saltarse los dos. */}
    <PermisoDeEscritura access={access.data} estado={estadoPermisoDeEscritura} />

    {/* `useResource` conserva el último dato bueno cuando una relectura falla: sin este cartel, un
        GET caído no se notaba en ningún sitio y la pantalla seguía mostrando datos viejos con cara
        de actuales. */}
    {config.error ? <p className="notice error" role="alert">
      La última relectura de la configuración falló ({config.error.message}): lo que ves es la
      ÚLTIMA lectura buena, no lo que el servidor tiene ahora.
    </p> : null}

    {/* Las pestañas son botones de verdad con `role="tab"`, no anclas ni `<details>`: el teclado y
        el lector de pantalla tienen que poder decir cuál está abierta. La lista sale de `areas.ts`,
        que la deriva del snapshot — una colección nueva del servidor cae en «Otros» y se ve igual,
        en vez de quedar invisible detrás de un allowlist de la consola. */}
    <div className="config-tabs" role="tablist" aria-label="Áreas de configuración">
      {areas.map(({ area: entrada }) => <button
        key={entrada.id}
        type="button"
        role="tab"
        aria-selected={entrada.id === areaVisible}
        className="config-tab"
        onClick={() => irAArea(entrada.id)}
      >{entrada.label}</button>)}
    </div>

    {/* La descripción del área va abierta, no en un tooltip: es lo primero que hay que leer al
        entrar, y esconder detrás de un signo de interrogación justo lo que orienta sería repetir el
        defecto que este cambio corrige.

        Abierta va UNA frase. El resto —lo que explica por qué la pestaña importa— va plegado: el
        operador que entra veinte veces al día ya lo sabe y pagaba el scroll veinte veces. Es un
        `<details>` y no un tooltip a propósito: lo plegado se puede leer con el teclado, se puede
        copiar y no depende del ratón. */}
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

      {/* Antes del registro de bots, y no debajo: la tabla es justo lo que induce el error que este
          panel corrige —una columna «Harness» con un valor escrito parece elegir el programa que
          corre el bot, y no lo elige—. Puesto después, se leería como una nota al pie de algo que
          el operador ya interpretó mal. */}
      {areaVisible === 'agentes' ? <ArnesesPanel /> : null}

      {areaVisible === 'roles' ? <>
        <RolesPanel
          {...(config.data ? { snapshot: config.data } : {})}
        />
      </> : null}

      {(activa?.colecciones ?? []).map((coleccion) => {
        const pedido = pendiente?.coleccion === coleccion.key ? pendiente : undefined;
        // Una confirmación pendiente vale para la revisión sobre la que se pidió. Si el snapshot se
        // movió debajo —«Actualizar», u otra escritura— la fila que el operador leyó en el `<pre>`
        // ya no es la que hay: la confirmación se anula y se dice, en vez de mandarla igual contra
        // la revisión nueva.
        const vigente = pedido !== undefined && pedido.revision === snapshotRevision;
        const vencida = pedido !== undefined && !vigente;
        // Mismo criterio para el cartel del desenlace: vale para el estado que lo produjo, y en
        // cuanto ese estado cambia deja de mostrarse en vez de seguir afirmándolo.
        const propio = avisoDeAccion?.coleccion === coleccion.key
          && avisoDeAccion.revision === snapshotRevision
          ? { text: avisoDeAccion.text, tone: avisoDeAccion.tone }
          : undefined;
        const aviso: AvisoDeColeccion | undefined = vencida && pedido
          ? {
            tone: 'error',
            text: `La confirmación de «${pedido.accion.descripcion}» se anuló sola: la configuración `
              + `pasó a la revisión ${snapshotRevision ?? 'UNKNOWN'} mientras estaba pendiente, así `
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
          {...(vigente && pedido ? { pendiente: pedido } : {})}
          {...(aviso ? { aviso } : {})}
          onPedir={(siguiente) => {
            setAvisoDeAccion(undefined);
            setPendiente({ ...siguiente, revision: snapshotRevision });
          }}
          onConfirmar={() => void confirmarAccion()}
          onCancelar={() => setPendiente(undefined)}
        />;
      })}

      {areaVisible === 'historial' ? <>
    <Panel title="Audit trail de configuración" subtitle="Rollback crea una nueva revisión; el historial nunca se reescribe.">
      {/* El `oldValue` que el store guarda como inversa es la FILA ENTERA que había antes, no el
          campo que se tocó, aunque la mutación que se mandó fuera parcial. El operador no puede
          deducir eso de un botón que dice «Rollback», y la diferencia le puede costar el cambio de
          un compañero. */}
      <p className="notice" role="note">
        Deshacer restituye la FILA COMPLETA que había antes de esa revisión, no sólo el campo que se
        tocó: si otro operador cambió otro campo de la misma fila después, ese cambio también se
        revierte.
      </p>

      {/* El desenlace del rollback se pinta ACÁ, encima de la tabla y a la vista sin abrir nada:
          es el único sitio donde el operador está mirando cuando aprieta uno de estos botones. */}
      {avisoDeRollback ? <p
        className={avisoDeRollback.tone === 'error' ? 'notice error' : avisoDeRollback.tone === 'parcial' ? 'notice parcial' : 'notice success'}
        role={avisoDeRollback.tone === 'success' ? 'status' : 'alert'}
      >{avisoDeRollback.text}</p> : null}
      {previewDeRollback ? <pre className="config-preview" aria-label="Preview del rollback">{previewDeRollback}</pre> : null}

      {!config.data?.revisions?.length ? <EmptyState>No hay revisiones.</EmptyState> : <div className="table-wrap config-audit"><table><thead><tr><th>Rev</th><th>Actor</th><th>Resumen</th><th>Fecha</th><th>Rollback</th></tr></thead><tbody>
        {config.data.revisions.map((revision, index) => <tr key={revision.id ?? index}><td><Badge tone="info"><Unknown value={revision.id} /></Badge></td><td><Unknown value={`${revision.actor_tenant ?? 'UNKNOWN'}:${revision.actor_alias ?? 'UNKNOWN'}`} /></td><td><Unknown value={revision.summary} /></td><td><Time value={revision.created_at} /></td><td>{revision.id ? <span className="config-actions"><button className="button small" disabled={soloLectura || busy} onClick={() => void rollback(revision.id!, true)}>Preview</button><button className="button small" disabled={soloLectura || busy} onClick={() => void rollback(revision.id!, false)}><RotateCcw size={14} />Rollback</button></span> : <Unknown value={null} />}</td></tr>)}
      </tbody></table></div>}
    </Panel>

    {/* La válvula de escape: sigue viva y entera para todo lo que no tiene formulario (harness,
        role_policy, chain_policy, egress y los cuatro recursos del registro), pero ya no es lo
        primero que ve el operador. */}
    <details className="config-editor">
      <summary><Braces size={14} aria-hidden="true" /> Editor de mutaciones JSON — válvula de escape para lo que no tiene formulario</summary>
      <Panel title="Mutation editor" subtitle={`Revisión esperada: ${expectedRevision ?? 'UNKNOWN'}`}>
        <form className="config-form" onSubmit={(event) => void submit(event, false)}>
          <label>Resource<select disabled={soloLectura || busy} value={resource} onChange={(event) => selectTemplate(event.target.value as ConfigResource, action)}>{Object.keys(templates).map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Action<select disabled={soloLectura || busy} value={action} onChange={(event) => selectTemplate(resource, event.target.value as ConfigAction)}>{actionsFor(resource).map((item) => <option key={item}>{item}</option>)}</select></label>
          <label className="config-json">Mutación JSON<textarea aria-label="Mutación JSON" disabled={soloLectura || busy} rows={12} value={editor} onChange={(event) => editarMutacion(event.target.value)} spellCheck={false} /></label>
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
 * El permiso de escritura, dicho en castellano.
 *
 * Lo primero que se leía en `/config` era `RBAC config.write ALLOW Roles: operator`: cuatro jergas
 * seguidas, a 11,52 px, encima de todo lo demás. Eso no le contesta al operador la única pregunta
 * que tiene al entrar —«¿puedo tocar esto?»— y encima ocupa el sitio de la respuesta.
 *
 * El identificador crudo NO se tira: es lo que hay que citar para pedir el permiso a quien
 * administra, y esconderlo dejaría a quien lo necesita sin nada que llevar. Va detrás de la frase
 * y en un escalón secundario.
 *
 * `unknown` —no se pudo acreditar el RBAC— conserva lectura y navegación, pero deja cada mutación
 * inerte. El backend sigue siendo la autoridad; la UI no debe usarlo como sustituto de una decisión
 * de permiso que ella no pudo obtener.
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
      // La frase EXACTA de la barra lateral (`CONFIG_SIN_CONTROL_REASON`): dos redacciones
      // distintas para la misma negativa le harían creer al operador que son dos problemas.
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
 * Lo que ve quien llega a `/config` por un marcador sin permiso `control`.
 *
 * Dice **exactamente** `CONFIG_SIN_CONTROL_REASON`, la misma frase que la barra lateral pone en la
 * entrada inerte: dos redacciones distintas para la misma negativa le harían creer al operador que
 * son dos problemas. No hay botón «Reintentar» —repetir la petición no puede conceder un permiso, y
 * ofrecerlo es prometer una salida que no existe— y sí hay una salida real hacia la portada.
 *
 * El mensaje crudo del servidor se muestra igual, en segundo plano: es lo que hay que citar para
 * pedir el permiso, y esconderlo dejaría al operador sin nada que llevarle a quien administra.
 */
function SinPermisoDeControl({ detalle }: { detalle: string }) {
  return (
    <div className="state-card" role="note">
      <ShieldOff aria-hidden="true" />
      <div>
        <strong>«Ajustes y altas» necesita permiso de control</strong>
        <p>{CONFIG_SIN_CONTROL_REASON}</p>
        <p className="muted">
          El servidor contestó 403: <span className="mono">{detalle || 'sin mensaje'}</span>. Reintentar
          no cambia nada: falta el permiso, no se cayó Cauce.
        </p>
      </div>
      <a className="button secondary" href="/" onClick={(event) => onNavClick(event, '/')}>Ir a la portada</a>
    </div>
  );
}
