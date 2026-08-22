import type {
  AdapterPage,
  AuditPage,
  FleetActivityItem,
  FleetActivitySnapshot,
  FleetDelegationEdge,
  JobPage,
  MessagePage,
  OriginRelayPage,
  QueueSnapshot,
  QuotaSnapshot,
  SystemStatus,
  TopologySnapshot,
} from '../api/types';

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const secondsAgo = (seconds: number) => iso(-seconds * 1_000);

/**
 * Una entrega en vuelo, escrita en la forma en que se la lee.
 *
 * `desde` es **quién mandó la entrega** (`tenant/alias`), y es el único dato del que sale una
 * flecha en el hipergrafo vivo: `delegationEdges()` deriva la arista `desde → agente que la tiene`
 * de `from_tenant`/`from_alias`. Un ítem sin ese par existe igual —el trabajo está en vuelo— pero
 * no se sabe quién delegó, así que no se dibuja nada. Por eso acá es obligatorio y no opcional:
 * un fixture con entregas anónimas produce una sala de máquinas sin una sola flecha, que es
 * exactamente la pregunta que el panel existe para responder.
 *
 * `segundos` es la antigüedad en vuelo. Por encima de `stall_after_seconds` (300 en este snapshot)
 * la flecha se pinta en ámbar: no es decoración, es la señal de "esto lleva demasiado", el fallo
 * que se ve como un agente que tarda y no como un error.
 */
function enVuelo(id: string, desde: string, segundos: number, extra: Partial<FleetActivityItem> = {}): FleetActivityItem {
  const corte = desde.indexOf('/');
  return {
    delivery_id: id,
    message_id: `msg-${id}`,
    trace_id: `trace-${id}`,
    from_tenant: desde.slice(0, corte),
    from_alias: desde.slice(corte + 1),
    lane: 'interactive',
    origin_adapter: 'bus',
    published_at: secondsAgo(segundos + 2),
    status: 'started',
    attempt: 1,
    claimed_at: secondsAgo(segundos),
    // El deadline se mide contra el ACK, no contra el reloj de la entrega: una entrega vieja con
    // ACKs frescos sigue viva. Se vence sólo cuando pasó el doble de la ventana de estancamiento.
    ack_deadline_at: iso((600 - segundos) * 1_000),
    seconds_in_flight: segundos,
    last_ack_at: secondsAgo(Math.min(segundos, 25)),
    last_ack_status: 'started',
    ...extra,
  };
}

export function mockStatus(): SystemStatus {
  return {
    version: '3.0',
    auth_provider: 'http-only-session',
    online: 99,
    queued: 7,
    dead_letters: 1,
    outbox_pending: 2,
    presence: [
      { tenant_id: 'Steven', alias: 'kant', instance_id: 'kant-7f4a', epoch: 14, capabilities: ['messages', 'jobs', 'ack'], last_heartbeat_at: iso(-4_000), lease_expires_at: iso(26_000), online: false },
      { tenant_id: 'Steven', alias: 'argos', instance_id: 'argos-4e22', epoch: 11, capabilities: ['messages', 'ack.timeline'], last_heartbeat_at: iso(-7_000), lease_expires_at: iso(23_000) },
      { tenant_id: 'Steven', alias: 'socrates', instance_id: 'socrates-29ce', epoch: 6, capabilities: ['messages'], last_heartbeat_at: iso(-9_000), lease_expires_at: iso(21_000) },
      { tenant_id: 'Steven', alias: 'jarvis', instance_id: 'jarvis-b711', epoch: 18, capabilities: ['messages', 'jobs', 'ack'], last_heartbeat_at: iso(-3_000), lease_expires_at: iso(27_000) },
      { tenant_id: 'Miguel', alias: 'kratos', instance_id: 'kratos-0b31', epoch: 8, capabilities: ['messages', 'ack'], last_heartbeat_at: iso(-74_000), lease_expires_at: iso(-44_000), online: true },
      { tenant_id: 'Miguel', alias: 'janus', instance_id: 'janus-29ad', epoch: 5, capabilities: ['messages', 'ack'], last_heartbeat_at: iso(-11_000), lease_expires_at: iso(19_000) },
      { tenant_id: 'Isa', alias: 'salva', instance_id: 'salva-87b0', epoch: 3, capabilities: ['messages'], last_heartbeat_at: iso(-8_000), lease_expires_at: iso(22_000) },
      { tenant_id: 'Jhon', alias: 'hegel', instance_id: 'hegel-122f', epoch: 9, capabilities: ['messages', 'jobs'], last_heartbeat_at: iso(-6_000), lease_expires_at: iso(24_000) },
      { tenant_id: 'Pablo', alias: 'dedalo', instance_id: 'dedalo-9d2c', epoch: 7, capabilities: ['messages', 'ack'], last_heartbeat_at: iso(-12_000), lease_expires_at: iso(18_000) },
      { tenant_id: 'Pablo', alias: 'midas', instance_id: 'midas-0d14', epoch: 4, capabilities: ['messages'], last_heartbeat_at: iso(-18_000), lease_expires_at: iso(12_000) },
      { tenant_id: 'Pablo', alias: 'seneca', capabilities: null, epoch: null, lease_expires_at: null },
      { tenant_id: 'Pablo', alias: 'vulcano', instance_id: 'vulcano-e832', epoch: 2, capabilities: ['messages'], last_heartbeat_at: iso(-130_000), lease_expires_at: iso(-100_000) },
    ],
  };
}

/**
 * Topología de demostración, calcada de la flota real: 5 tenants y 15 alias.
 *
 * Está escrita para que se vea lo que un hipergrafo tiene de distinto a un grafo: hay tenants con
 * MÁS DE UNA room y alias que pertenecen a dos rooms a la vez —los puentes—. Un alias así se
 * dibuja una sola vez y las dos regiones se solapan sobre él; con una room por tenant ese
 * solapamiento no existe y el dibujo degenera en cinco islas sueltas.
 *
 * Los puentes son SIEMPRE dentro del mismo tenant, y no por comodidad: en esta respuesta el
 * miembro de una room es un alias suelto, sin tenant propio, así que el alias `kant` metido en una
 * room de Miguel no significa "el kant de Steven entra a la sala de Miguel" — significa que existe
 * un agente `Miguel:kant`, que es falso. El resto de la consola lee esta misma estructura y crea
 * el agente (`terminal/fleet.ts` indexa por `tenant:alias`), así que el atajo no quedaría en el
 * dibujo: inventaría destinos de terminal que no existen. El cruce entre tenants se declara donde
 * el modelo sí lo admite y donde el backend realmente lo resuelve: las aristas ACL de abajo.
 */
export const topology: TopologySnapshot = {
  observed_at: '2026-07-22T16:12:08.000Z',
  tenants: [
    {
      id: 'Steven', label: 'Steven', rooms: [
        // La sala del hub tiene a los cinco: es donde el operador comparte room con todos los suyos.
        { id: 'grp.steven', label: 'grp.steven', members: [{ alias: 'zeus', enabled: true }, { alias: 'kant', enabled: true }, { alias: 'socrates', enabled: true }, { alias: 'jarvis', enabled: true }, { alias: 'argos', enabled: true }] },
        // Sala de infraestructura: el médico de la flota y el PMO. Está contenida en la anterior, y
        // ese anidamiento también es información: `zeus` y `argos` son los puentes entre las dos.
        { id: 'ops.infra', label: 'ops.infra', members: [{ alias: 'zeus', enabled: true }, { alias: 'argos', enabled: true }] },
      ],
    },
    {
      id: 'Miguel', label: 'Miguel', rooms: [
        { id: 'grp.miguel', label: 'grp.miguel', members: [{ alias: 'janus', enabled: true }, { alias: 'kratos', enabled: true }, { alias: 'iza', enabled: true }] },
        // `atlas` es el caso real de un alias con trabajo encolado que nadie dio de alta.
        { id: 'ops.miguel', label: 'ops.miguel', members: [{ alias: 'kratos', enabled: true }, { alias: 'atlas', enabled: false }] },
      ],
    },
    {
      id: 'Pablo', label: 'Pablo', rooms: [
        { id: 'grp.pablo', label: 'grp.pablo', members: [{ alias: 'dedalo', enabled: true }, { alias: 'midas', enabled: true }, { alias: 'seneca', enabled: true }] },
        { id: 'marcas.pablo', label: 'marcas.pablo', members: [{ alias: 'midas', enabled: true }, { alias: 'vulcano', enabled: false }] },
      ],
    },
    { id: 'Isa', label: 'Isa', rooms: [{ id: 'grp.isa', label: 'grp.isa', members: [{ alias: 'salva', enabled: true }] }] },
    { id: 'Jhon', label: 'Jhon', rooms: [{ id: 'grp.jhon', label: 'grp.jhon', members: [{ alias: 'hegel', enabled: true }] }] },
  ],
  acl_edges: [
    { from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true, allow_route: true, allow_read: true, allow_control: true, policy: 'explicit-cross-tenant' },
    { from_tenant: 'Miguel', to_tenant: 'Steven', enabled: true, allow_route: true, allow_read: true, allow_control: false, policy: 'explicit-cross-tenant' },
    { from_tenant: 'Steven', to_tenant: 'Pablo', enabled: true, allow_route: true, allow_read: true, allow_control: true, policy: 'explicit-cross-tenant' },
    { from_tenant: 'Pablo', to_tenant: 'Steven', enabled: true, allow_route: true, allow_read: true, allow_control: false, policy: 'explicit-cross-tenant' },
    { from_tenant: 'Steven', to_tenant: 'Jhon', enabled: true, allow_route: true, allow_read: true, allow_control: true, policy: 'explicit-cross-tenant' },
    // Entre tenants cliente no hay canal: lo impide un constraint del backend, no un olvido.
    { from_tenant: 'Miguel', to_tenant: 'Pablo', enabled: false, allow_route: false, allow_read: false, allow_control: false, policy: 'default-deny' },
    // Isa NO tiene arista desde Steven a propósito, y no es un olvido del fixture: el cruce que
    // nadie declaró queda denegado por default en el backend, y esa es justamente la fila que la
    // consola tiene que saber mostrar (destino bloqueado con su motivo, no un botón muerto).
  ],
};

export function mockMessages(): MessagePage {
  return {
    items: [
      {
        message_id: '8eac0520-6e1e-47e8-b7da-554e4bf850b4', request_id: '1a4fe8f5-aed0-45b2-8fe7-59cdd3c09be2', trace_id: 'trace-fleet-00042', tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant', body_preview: 'Verificar estado del adapter Hermes', lane: 'interactive', created_at: iso(-95_000),
        deliveries: [{ delivery_id: '4b981ddd-f311-494e-887c-83fd5e11be90', recipient_tenant: 'Steven', recipient_alias: 'argos', status: 'done', attempt: 1, timeline: [
          { status: 'published', at: iso(-95_000), attempt: 1 }, { status: 'accepted', at: iso(-93_000), attempt: 1 }, { status: 'started', at: iso(-89_000), attempt: 1 }, { status: 'done', at: iso(-51_000), attempt: 1 },
        ] }],
      },
      {
        message_id: '78bd581e-039f-4020-b096-b8eed7e20f3e', request_id: '51d7cf3f-08cf-4d2a-82fc-4385e18bcbae', trace_id: 'trace-batch-00108', tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: null, body_preview: 'Indexar reporte operativo', lane: 'batch', created_at: iso(-240_000),
        deliveries: [{ delivery_id: 'fdca3315-aa17-409e-827a-065d5780243e', recipient_tenant: 'Miguel', recipient_alias: 'kratos', status: 'failed', attempt: 3, timeline: [
          { status: 'published', at: iso(-240_000), attempt: 1 }, { status: 'accepted', at: iso(-210_000), attempt: 3 }, { status: 'started', at: iso(-201_000), attempt: 3 }, { status: 'failed', at: iso(-180_000), attempt: 3, detail: 'adapter timeout' },
        ] }],
      },
    ],
  };
}

export function mockQueues(): QueueSnapshot {
  return {
    observed_at: iso(0), pending: 4, retrying: 2, dead: 1,
    items: [
      { delivery_id: '15aa7f4c-d11f-4ec0-819c-3f6c61b177b0', message_id: '581cc4da-77c6-4498-8ed5-991dfbc430e9', tenant_id: 'Steven', recipient_alias: 'socrates', lane: 'interactive', state: 'pending', attempts: 0, max_attempts: 5, available_at: iso(-1_000), last_error: null },
      { delivery_id: 'd15402e4-1813-4be5-b950-a1737b5d2e46', message_id: '8957fabf-e2fc-488c-9c93-66eb9b998d29', tenant_id: 'Pablo', recipient_alias: 'dedalo', lane: 'batch', state: 'retry', attempts: 2, max_attempts: 5, available_at: iso(12_000), last_error: 'ACK timeout' },
      { delivery_id: '72b24438-693d-4ae7-8746-6338cdaf1f46', message_id: '353bc0f7-3413-49fc-bfdb-f63ad7680fd0', tenant_id: 'Miguel', recipient_alias: 'kratos', lane: 'interactive', state: 'dead', attempts: 5, max_attempts: 5, available_at: iso(-420_000), last_error: 'max attempts exhausted' },
    ],
  };
}

export function mockJobs(): JobPage {
  return { items: [
    { job_id: '0e4c4ea7-aa3b-4f45-89f3-536243676bbf', tenant_id: 'Steven', lane: 'interactive', kind: 'agent.task', status: 'running', priority: 10, attempts: 1, claimed_by: 'dispatcher-a', created_at: iso(-32_000) },
    { job_id: 'fc4836f6-af2c-4c38-b11e-92329ffdd671', tenant_id: 'Pablo', lane: 'batch', kind: 'report.index', status: 'queued', priority: 0, attempts: 0, claimed_by: null, created_at: iso(-190_000) },
  ] };
}

export const adapters: AdapterPage = { items: [
  { id: 'hermes', label: 'Hermes', state: 'available', protocol_version: '3.0', capabilities: ['messages.receive', 'ack.timeline', 'origin.relay'], last_seen_at: '2026-07-22T16:12:04.000Z', detail: 'Adapter de runtime registrado por Cauce.' },
  { id: 'opencode', label: 'OpenCode', state: 'available', protocol_version: '3.0', capabilities: ['messages.receive', 'jobs.interactive', 'jobs.batch'], last_seen_at: '2026-07-22T16:12:00.000Z', detail: 'Ejecución expuesta por adapter, no por el navegador.' },
  { id: 'claude-code', label: 'Claude Code', state: 'degraded', protocol_version: '3.0', capabilities: ['messages.receive', 'jobs.interactive'], last_seen_at: '2026-07-22T16:09:01.000Z', detail: 'Batch no declarado en el último manifest.' },
  { id: 'codex', label: 'Codex', state: 'unknown', protocol_version: null, capabilities: null, last_seen_at: null, detail: null },
] };

export const audit: AuditPage = { items: [
  { event_id: 'aud-1003', at: '2026-07-22T16:12:01.000Z', tenant_id: 'Steven', actor_alias: 'kant', action: 'message.publish', decision: 'allow', request_id: '1a4fe8f5-aed0-45b2-8fe7-59cdd3c09be2', trace_id: 'trace-fleet-00042', summary: '1 delivery creada para argos' },
  { event_id: 'aud-1002', at: '2026-07-22T16:10:32.000Z', tenant_id: 'Miguel', actor_alias: 'janus', action: 'message.publish', decision: 'deny', request_id: '5d866642-b8a4-4a0f-843a-cd75b0756c35', trace_id: 'trace-denied-2', summary: 'Cruce tenant→tenant denegado por default' },
  { event_id: 'aud-1001', at: '2026-07-22T16:08:07.000Z', tenant_id: 'Pablo', actor_alias: null, action: 'delivery.ack', decision: 'allow', request_id: null, trace_id: 'trace-ack-81', summary: 'ACK terminal done aplicado en epoch 4' },
] };

/**
 * Registro de agentes y pool de suscripciones, con la MISMA forma que devuelve
 * `GET /v3/console/config` (packages/store/src/configuration.ts): `credential_ref` no aparece nunca,
 * y en una cuenta que paga otro tenant el servidor anula `external_account_id` y
 * `credential_ref_kind` — acá se mantienen como `null` explícitos, no como claves ausentes.
 */
export const registryAgents: Array<Record<string, unknown>> = [
  { tenant_id: 'Steven', alias: 'kant', harness_id: 'claude-code', display_name: 'Kant', enabled: true, container_name: 'ws-kant', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/var/lib/kant', created_at: '2026-07-20T10:00:00.000Z', updated_at: '2026-07-22T10:00:00.000Z' },
  { tenant_id: 'Miguel', alias: 'iza', harness_id: 'hermes', display_name: 'Iza', enabled: false, container_name: 'ws-humanizar', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/var/lib/iza', created_at: '2026-07-23T10:00:00.000Z', updated_at: '2026-07-23T10:00:00.000Z' },
  { tenant_id: 'Pablo', alias: 'midas', harness_id: 'openclaw', display_name: null, enabled: true, container_name: 'ws-midas', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/var/lib/midas', created_at: '2026-07-19T10:00:00.000Z', updated_at: '2026-07-21T10:00:00.000Z' },
];

export const providerAccounts: Array<Record<string, unknown>> = [
  { id: 'codex-steven', provider: 'codex', payer_tenant_id: 'Steven', label: 'Codex del hub', shared_with_pool: true, enabled: true, external_account_id: 'org-steven-9f21', credential_ref_kind: 'env_path', created_at: '2026-07-18T10:00:00.000Z', updated_at: '2026-07-22T10:00:00.000Z' },
  { id: 'gemini-steven', provider: 'gemini', payer_tenant_id: 'Steven', label: 'Antigravity', shared_with_pool: false, enabled: true, external_account_id: 'antigravity-4410', credential_ref_kind: 'file', created_at: '2026-07-18T11:00:00.000Z', updated_at: '2026-07-18T11:00:00.000Z' },
  // Cuenta de otro pagador: el servidor anuló los dos campos del pagador.
  { id: 'minimax-pablo', provider: 'minimax', payer_tenant_id: 'Pablo', label: 'MiniMax de Pablo', shared_with_pool: true, enabled: true, external_account_id: null, credential_ref_kind: null, created_at: '2026-07-17T10:00:00.000Z', updated_at: '2026-07-20T10:00:00.000Z' },
];

export const routingCeiling: Array<Record<string, unknown>> = [
  { tenant_id: 'Steven', alias: 'kant', account_id: 'codex-steven', account_payer_tenant: 'Steven', created_by_tenant: 'Steven', created_at: '2026-07-20T12:00:00.000Z' },
  { tenant_id: 'Steven', alias: 'kant', account_id: 'minimax-pablo', account_payer_tenant: 'Pablo', created_by_tenant: 'Steven', created_at: '2026-07-20T12:05:00.000Z' },
  { tenant_id: 'Miguel', alias: 'iza', account_id: 'codex-steven', account_payer_tenant: 'Steven', created_by_tenant: 'Miguel', created_at: '2026-07-23T12:00:00.000Z' },
];

export const agentAccountBindings: Array<Record<string, unknown>> = [
  { tenant_id: 'Steven', agent_alias: 'kant', account_id: 'codex-steven', priority: 10, enabled: true, created_at: '2026-07-20T12:01:00.000Z', updated_at: '2026-07-20T12:01:00.000Z' },
  { tenant_id: 'Steven', agent_alias: 'kant', account_id: 'minimax-pablo', priority: 50, enabled: true, created_at: '2026-07-20T12:06:00.000Z', updated_at: '2026-07-20T12:06:00.000Z' },
  { tenant_id: 'Miguel', agent_alias: 'iza', account_id: 'codex-steven', priority: 100, enabled: false, created_at: '2026-07-23T12:01:00.000Z', updated_at: '2026-07-23T12:01:00.000Z' },
];

export const originRelays: OriginRelayPage = { items: [
  { id: 'relay-1', tenant_id: 'Steven', adapter: 'telegram', delivery_id: '4b981ddd-f311-494e-887c-83fd5e11be90', status: 'sent', attempts: 1, created_at: iso(-50_000), sent_at: iso(-49_000) },
  { id: 'relay-2', tenant_id: 'Steven', adapter: 'telegram', delivery_id: 'fdca3315-aa17-409e-827a-065d5780243e', status: 'failed', attempts: 3, created_at: iso(-180_000), sent_at: null },
] };

/**
 * GET /v3/console/activity. Cubre a propósito los casos que motivaron el panel y los que casi
 * se esconden si no se los busca: un agente saturado sano (jarvis), el incidente real (midas:
 * saturado + colgado + lease vencido + reintentando), un alias que nadie registró (atlas), y dos
 * variantes del null en seconds_since_last_ack — inactivo-sin-historia (vulcano) vs. colgado con
 * trabajo real pendiente (hegel) — porque son diagnósticos distintos y el mismo null los cubre a los dos.
 *
 * Cubre además —y esto es nuevo— **los 15 alias de la topología**, cada uno con sus entregas en
 * vuelo y con el emisor declarado. De ahí salen las flechas de la sala de máquinas: sin
 * `from_tenant`/`from_alias` la entrega existe pero es anónima, y el panel "quién le habla a
 * quién" queda mudo, con los muñecos en su sala y ni una sola delegación dibujada.
 */
export function mockActivity(): FleetActivitySnapshot {
  // `enriquecer` añade lo que el backend sumará en su fase: salas, cerradas en 24 h y aristas
  // agregadas por par. Va como envoltorio y no a mano en cada agente para que un alias nuevo en el
  // fixture no se quede sin los campos y produzca un falso "el servidor no lo informa".
  return enriquecer({
    observed_at: iso(0),
    thresholds: {
      saturation_in_flight: 8,
      stall_after_seconds: 300,
      ack_recent_seconds: 300,
      ack_lookback_seconds: 3600,
      items_per_agent: 10,
    },
    // Los 15 alias de la topología, no un subconjunto. Un agente que la topología declara y la
    // actividad calla no se dibuja como sano: sale apagado y marcado UNKNOWN. Eso es correcto
    // como comportamiento, pero como *demostración* no muestra nada: la pregunta de Steven es
    // "cómo están trabajando TODOS", y para responderla la actividad tiene que cubrirlos a todos.
    totals: {
      agents: 15,
      by_state: { idle: 3, queued: 1, working: 8, saturated: 1, stalled: 2 },
      flagged: {
        saturated: 2, ack_stalled: 2, overdue_acks: 1, lease_expired: 2,
        never_connected: 1, unregistered: 1, queued_without_consumer: 1,
      },
      in_flight: 63,
      queued: 29,
      retrying: 3,
      overdue_in_flight: 41,
    },
    agents: [
      {
        // El orquestador residente. Es el que más delega, así que casi todas las flechas nacen
        // acá; lo único que RECIBE es el informe de vuelta de socrates.
        tenant_id: 'Steven', alias: 'zeus', display_name: 'Zeus', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'zeus-3d81c7f0', epoch: 204, last_heartbeat_at: secondsAgo(4), lease_until: iso(26_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 2, queued_ready: 2, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(45), oldest_in_flight_seconds: 45,
        nearest_ack_deadline_at: iso(555_000), max_attempt: 1,
        last_ack_at: secondsAgo(8), seconds_since_last_ack: 8, acks_recent: 21,
        in_flight_items_truncated: false,
        in_flight_items: [enVuelo('1c0ffee0-0001-4000-8000-a1b2c3d4e5f6', 'Steven/socrates', 45)],
      },
      {
        tenant_id: 'Steven', alias: 'socrates', display_name: 'Sócrates', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'socrates-29ce4b11', epoch: 37, last_heartbeat_at: secondsAgo(9), lease_until: iso(21_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(210), oldest_in_flight_seconds: 210,
        nearest_ack_deadline_at: iso(390_000), max_attempt: 1,
        last_ack_at: secondsAgo(25), seconds_since_last_ack: 25, acks_recent: 4,
        in_flight_items_truncated: false,
        // Cruce Miguel→Steven: la arista ACL existe y está habilitada, así que esta flecha cruza
        // de una región de tenant a otra. Es el caso que un dibujo por tenant aislado esconde.
        in_flight_items: [enVuelo('1c0ffee0-0002-4000-8000-a1b2c3d4e5f6', 'Miguel/janus', 210)],
      },
      {
        tenant_id: 'Steven', alias: 'argos', display_name: 'Argos', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'argos-4e22a9c3', epoch: 88, last_heartbeat_at: secondsAgo(7), lease_until: iso(23_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 1, queued_ready: 1, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(70), oldest_in_flight_seconds: 70,
        nearest_ack_deadline_at: iso(530_000), max_attempt: 1,
        last_ack_at: secondsAgo(15), seconds_since_last_ack: 15, acks_recent: 6,
        in_flight_items_truncated: false,
        in_flight_items: [enVuelo('1c0ffee0-0003-4000-8000-a1b2c3d4e5f6', 'Steven/kant', 70)],
      },
      {
        tenant_id: 'Miguel', alias: 'janus', display_name: 'Janus', harness_id: 'openclaw',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'janus-29ad5f02', epoch: 51, last_heartbeat_at: secondsAgo(11), lease_until: iso(19_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(330), oldest_in_flight_seconds: 330,
        nearest_ack_deadline_at: iso(270_000), max_attempt: 1,
        last_ack_at: secondsAgo(25), seconds_since_last_ack: 25, acks_recent: 3,
        in_flight_items_truncated: false,
        // Pasó de los 300 s de stall_after_seconds: la flecha sale ámbar aunque el agente esté
        // sano. El ámbar habla de la ENTREGA, no del agente, y son cosas distintas.
        in_flight_items: [enVuelo('1c0ffee0-0004-4000-8000-a1b2c3d4e5f6', 'Steven/zeus', 330)],
      },
      {
        tenant_id: 'Miguel', alias: 'kratos', display_name: 'Kratos', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'kratos-0b31d7e4', epoch: 76, last_heartbeat_at: secondsAgo(5), lease_until: iso(25_000) },
        work_state: 'working', flags: [],
        in_flight: 2, started: 2, claimed_not_started: 0, queued: 3, queued_ready: 3, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(410), oldest_in_flight_seconds: 410,
        nearest_ack_deadline_at: iso(190_000), max_attempt: 1,
        last_ack_at: secondsAgo(18), seconds_since_last_ack: 18, acks_recent: 7,
        in_flight_items_truncated: false,
        in_flight_items: [
          enVuelo('1c0ffee0-0005-4000-8000-a1b2c3d4e5f6', 'Steven/zeus', 410, { lane: 'batch' }),
          enVuelo('1c0ffee0-0006-4000-8000-a1b2c3d4e5f6', 'Miguel/janus', 85),
        ],
      },
      {
        // Deshabilitada en el registro (`agent_enabled: false`) y sin trabajo: no recibe nada, y
        // por eso no le entra ninguna flecha. Que aparezca igual en el dibujo, apagada, es el
        // punto: un alias dado de baja sigue siendo parte de la sala hasta que alguien lo saque.
        tenant_id: 'Miguel', alias: 'iza', display_name: 'Iza', harness_id: 'hermes',
        registered: true, agent_enabled: false,
        presence: { online: false, instance_id: 'iza-77b2e410', epoch: 12, last_heartbeat_at: secondsAgo(2_100), lease_until: secondsAgo(2_070) },
        work_state: 'idle', flags: ['lease_expired'],
        in_flight: 0, started: 0, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: null, oldest_in_flight_seconds: null, nearest_ack_deadline_at: null, max_attempt: null,
        last_ack_at: secondsAgo(2_400), seconds_since_last_ack: 2_400, acks_recent: 0,
        in_flight_items_truncated: false, in_flight_items: [],
      },
      {
        tenant_id: 'Pablo', alias: 'dedalo', display_name: 'Dédalo', harness_id: 'openclaw',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'dedalo-9d2c1a75', epoch: 64, last_heartbeat_at: secondsAgo(12), lease_until: iso(18_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(150), oldest_in_flight_seconds: 150,
        nearest_ack_deadline_at: iso(450_000), max_attempt: 1,
        last_ack_at: secondsAgo(22), seconds_since_last_ack: 22, acks_recent: 5,
        in_flight_items_truncated: false,
        in_flight_items: [enVuelo('1c0ffee0-0007-4000-8000-a1b2c3d4e5f6', 'Steven/zeus', 150)],
      },
      {
        tenant_id: 'Pablo', alias: 'seneca', display_name: 'Séneca', harness_id: 'openclaw',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'seneca-5a90c3f8', epoch: 29, last_heartbeat_at: secondsAgo(14), lease_until: iso(16_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 2, queued_ready: 2, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(520), oldest_in_flight_seconds: 520,
        nearest_ack_deadline_at: iso(80_000), max_attempt: 1,
        last_ack_at: secondsAgo(25), seconds_since_last_ack: 25, acks_recent: 2,
        in_flight_items_truncated: false,
        // Se la mandó midas, que está colgado: la cadena de un incidente se lee siguiendo la
        // flecha hacia atrás, y por eso el emisor importa tanto como el receptor.
        in_flight_items: [enVuelo('1c0ffee0-0008-4000-8000-a1b2c3d4e5f6', 'Pablo/midas', 520, { lane: 'batch' })],
      },
      {
        tenant_id: 'Steven', alias: 'kant', display_name: 'Kant', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'kant-7f21c0d4', epoch: 118, last_heartbeat_at: secondsAgo(6), lease_until: iso(24_000) },
        work_state: 'working', flags: [],
        in_flight: 3, started: 3, claimed_not_started: 0, queued: 1, queued_ready: 1, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(259), oldest_in_flight_seconds: 259,
        nearest_ack_deadline_at: iso(41_000), max_attempt: 1,
        last_ack_at: secondsAgo(12), seconds_since_last_ack: 12, acks_recent: 9,
        in_flight_items_truncated: false,
        in_flight_items: [
          { delivery_id: '3f1a9b6e-2c47-4a0e-9d33-0b5c8e71a204', message_id: '8c5d2f10-7b3a-4e91-8f2c-6a41d09be557', trace_id: 'trace-2b7e4c19', from_tenant: 'Steven', from_alias: 'zeus', lane: 'interactive', origin_adapter: 'bus', published_at: secondsAgo(261), status: 'started', attempt: 1, claimed_at: secondsAgo(259), ack_deadline_at: iso(41_000), seconds_in_flight: 259, last_ack_at: secondsAgo(12), last_ack_status: 'started' },
          { delivery_id: 'aa02e7c5-91d6-4f38-b7e0-4c9a1d3f6b82', message_id: '1d94f7a2-3e58-4bb1-90c7-2f6e58a0dc39', trace_id: 'trace-9a1c33d7', from_tenant: 'Steven', from_alias: 'argos', lane: 'batch', origin_adapter: 'telegram', published_at: secondsAgo(180), status: 'started', attempt: 1, claimed_at: secondsAgo(178), ack_deadline_at: iso(120_000), seconds_in_flight: 178, last_ack_at: secondsAgo(30), last_ack_status: 'started' },
          { delivery_id: '6b18d0f9-4a72-4ee3-8c15-9d20e7f3ab41', message_id: 'b7e30c48-16d2-4a97-bf05-8e1c4d9027aa', trace_id: 'trace-5f22e19b', from_tenant: 'Steven', from_alias: 'zeus', lane: 'interactive', origin_adapter: 'bus', published_at: secondsAgo(96), status: 'leased', attempt: 1, claimed_at: secondsAgo(94), ack_deadline_at: iso(206_000), seconds_in_flight: 94, last_ack_at: null, last_ack_status: null },
        ],
      },
      {
        tenant_id: 'Steven', alias: 'jarvis', display_name: 'Jarvis', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'jarvis-b711e2a0', epoch: 42, last_heartbeat_at: secondsAgo(3), lease_until: iso(27_000) },
        // Saturado por volumen (>= 8 en vuelo) pero sano: acks_recent alto y ACK reciente. Distinto
        // de midas, que además está colgado — el badge tiene que poder mostrar uno sin el otro.
        work_state: 'saturated', flags: ['saturated'],
        in_flight: 9, started: 9, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(340), oldest_in_flight_seconds: 340,
        nearest_ack_deadline_at: iso(15_000), max_attempt: 1,
        last_ack_at: secondsAgo(20), seconds_since_last_ack: 20, acks_recent: 12,
        in_flight_items_truncated: false,
        // Las 9 entregas NO vienen todas del mismo emisor, y esa es justamente la razón por la
        // que está saturado: media flota le está pasando trabajo a la vez. Con un único emisor el
        // hipergrafo dibujaba nueve arcos calcados entre los mismos dos muñecos —una relación
        // repetida nueve veces, que informa lo mismo que una— en vez de la convergencia real.
        in_flight_items: ['kant', 'kant', 'zeus', 'kant', 'argos', 'zeus', 'socrates', 'argos', 'socrates']
          .map((emisor, index) => enVuelo(
            `9c9f9c9f-0000-4000-8000-00000000000${index}`,
            `Steven/${emisor}`,
            338 - index * 10,
            { lane: 'batch', ack_deadline_at: iso((15 + index * 10) * 1_000), last_ack_at: secondsAgo(20) },
          )),
      },
      {
        // El incidente real: 41 en vuelo, 0 ACKs recientes, deadline vencido y lease caído. Este
        // agente tiene que gritar desde la pantalla, no compartir fila con los sanos.
        tenant_id: 'Pablo', alias: 'midas', display_name: null, harness_id: 'openclaw',
        registered: true, agent_enabled: true,
        presence: { online: false, instance_id: 'midas-0a44be91', epoch: 41, last_heartbeat_at: secondsAgo(1_400), lease_until: secondsAgo(1_370) },
        work_state: 'stalled', flags: ['ack_stalled', 'saturated', 'overdue_acks', 'lease_expired'],
        in_flight: 41, started: 39, claimed_not_started: 2, queued: 12, queued_ready: 12, retrying: 3, overdue_in_flight: 41,
        oldest_claimed_at: secondsAgo(4_820), oldest_in_flight_seconds: 4_820,
        nearest_ack_deadline_at: secondsAgo(4_520), max_attempt: 2,
        last_ack_at: secondsAgo(1_268), seconds_since_last_ack: 1_268, acks_recent: 0,
        in_flight_items_truncated: true,
        in_flight_items: [
          { delivery_id: 'c9d47a02-5e18-4b63-97f1-3a0e8c25db76', message_id: '42a1e6b8-0c7d-4f52-b839-5e60a71cf204', trace_id: 'trace-77c1e05a', from_tenant: 'Pablo', from_alias: 'dedalo', lane: 'batch', origin_adapter: 'bus', published_at: secondsAgo(4_822), status: 'started', attempt: 1, claimed_at: secondsAgo(4_820), ack_deadline_at: secondsAgo(4_520), seconds_in_flight: 4_820, last_ack_at: secondsAgo(4_760), last_ack_status: 'started' },
          { delivery_id: '0e73b4f1-8a25-4d09-b6c3-71f0d5928ae4', message_id: '5c80917d-4e2b-41a6-9f38-b207ce4d1650', trace_id: 'trace-77c1e05a', from_tenant: 'Pablo', from_alias: 'dedalo', lane: 'batch', origin_adapter: 'bus', published_at: secondsAgo(4_710), status: 'leased', attempt: 2, claimed_at: secondsAgo(4_708), ack_deadline_at: secondsAgo(4_408), seconds_in_flight: 4_708, last_ack_at: null, last_ack_status: null },
        ],
      },
      {
        // Nadie lo dio de alta en el registro de agentes, pero tiene 8 mensajes esperando: es
        // exactamente el caso que la UNION con deliveries/leases existe para no ocultar.
        tenant_id: 'Miguel', alias: 'atlas', display_name: null, harness_id: null,
        registered: false, agent_enabled: null,
        presence: { online: false, instance_id: 'atlas-31c7f9a2', epoch: 9, last_heartbeat_at: secondsAgo(11_600), lease_until: secondsAgo(11_570) },
        work_state: 'queued', flags: ['lease_expired', 'queued_without_consumer', 'unregistered'],
        in_flight: 0, started: 0, claimed_not_started: 0, queued: 8, queued_ready: 8, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: null, oldest_in_flight_seconds: null, nearest_ack_deadline_at: null, max_attempt: null,
        last_ack_at: null, seconds_since_last_ack: null, acks_recent: 0,
        in_flight_items_truncated: false, in_flight_items: [],
      },
      {
        tenant_id: 'Isa', alias: 'salva', display_name: 'Salva', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'salva-be104d77', epoch: 63, last_heartbeat_at: secondsAgo(2), lease_until: iso(28_000) },
        work_state: 'idle', flags: [],
        in_flight: 0, started: 0, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: null, oldest_in_flight_seconds: null, nearest_ack_deadline_at: null, max_attempt: null,
        last_ack_at: secondsAgo(799), seconds_since_last_ack: 799, acks_recent: 0,
        in_flight_items_truncated: false, in_flight_items: [],
      },
      {
        // Registrado, presente, pero nunca tuvo un ACK aplicado dentro de la ventana de búsqueda:
        // seconds_since_last_ack null en un agente SIN trabajo pendiente (a diferencia de hegel).
        tenant_id: 'Pablo', alias: 'vulcano', display_name: 'Vulcano', harness_id: 'openclaw',
        registered: true, agent_enabled: false,
        presence: undefined,
        work_state: 'idle', flags: ['never_connected'],
        in_flight: 0, started: 0, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: null, oldest_in_flight_seconds: null, nearest_ack_deadline_at: null, max_attempt: null,
        last_ack_at: null, seconds_since_last_ack: null, acks_recent: 0,
        in_flight_items_truncated: false, in_flight_items: [],
      },
      {
        // Colgado sin estar saturado: sólo 2 en vuelo, pero ninguna aplicó un ACK jamás dentro de
        // la ventana. La precedencia stalled > saturated > working tiene que elegir COLGADO acá.
        tenant_id: 'Jhon', alias: 'hegel', display_name: 'Hegel', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'hegel-122f9a10', epoch: 9, last_heartbeat_at: secondsAgo(5), lease_until: iso(25_000) },
        work_state: 'stalled', flags: ['ack_stalled'],
        in_flight: 2, started: 1, claimed_not_started: 1, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(610), oldest_in_flight_seconds: 610,
        nearest_ack_deadline_at: secondsAgo(310), max_attempt: 1,
        last_ack_at: null, seconds_since_last_ack: null, acks_recent: 0,
        in_flight_items_truncated: false,
        in_flight_items: [
          // Delegación real desde el hub (Steven→Jhon está permitido por ACL) parada hace más de
          // diez minutos: la flecha tiene que salir EN ÁMBAR. Es el caso que se ve como "hegel
          // tarda" y en realidad es trabajo tomado que no avanza.
          enVuelo('e1a2b3c4-d5e6-4f70-8091-a2b3c4d5e6f7', 'Steven/argos', 610, {
            ack_deadline_at: secondsAgo(310), last_ack_at: null, last_ack_status: null,
          }),
          // Y una entrega que el propio alias publicó: es el dueño escribiéndole por Telegram, no
          // una delegación. `delegationEdges()` la descarta (from === to) y por eso NO dibuja un
          // lazo de hegel a sí mismo. Se deja en el fixture para que ese descarte esté ejercitado.
          enVuelo('7d0c9b8a-1e2f-4a3b-9c4d-5e6f7a8b9c0d', 'Jhon/hegel', 240, {
            origin_adapter: 'telegram', status: 'leased', last_ack_at: null, last_ack_status: null,
          }),
        ],
      },
    ],
  });
}

/**
 * GET /v3/console/quotas. Un host fresco (kratos) y uno viejo (ws-midas) para ejercitar
 * collectors[].stale; codex con dos grupos (uno agotado y pausado, otro sin cuenta atada) porque
 * es el caso que un solo número por proveedor esconde; antigravity con varias ventanas del mismo
 * family para ejercitar el colapso; opencode con unidades absolutas además del porcentaje.
 */
export function mockQuotas(): QuotaSnapshot {
  const bucket = (values: number[]) => ({
    bucket_seconds: 1_800,
    points: values.map((used_percent, index) => ({ at: iso((index - values.length) * 1_800_000), used_percent })),
  });
  return {
    observed_at: iso(0),
    thresholds: {
      stale_after_seconds: 900,
      warn_remaining_percent: 25,
      critical_remaining_percent: 10,
      history_window_seconds: 86_400,
      history_bucket_seconds: 1_800,
      history_max_points: 48,
    },
    collectors: [
      { host: 'kratos', collector_tenant: 'Steven', collector_alias: 'quota-collector', captured_at: secondsAgo(702), received_at: secondsAgo(701), age_seconds: 701, stale: false, schema_version: 2, app_version: '0.12.0', provider_count: 4, window_count: 15 },
      { host: 'ws-midas', collector_tenant: 'Pablo', collector_alias: 'quota-collector', captured_at: secondsAgo(5_400), received_at: secondsAgo(5_398), age_seconds: 5_398, stale: true, schema_version: 2, app_version: '0.11.4', provider_count: 2, window_count: 4 },
    ],
    providers: [
      {
        host: 'kratos', provider: 'claude', ok: true, available: true, kind: 'detected-percent', source: 'claude-cli', plan: null,
        note: 'Claude /usage detectado desde el CLI.', effective_remaining_percent: 14, observed_at: secondsAgo(741), age_seconds: 741,
        available_groups: [], limiting_groups: [], severity: 'warn',
        groups: [{
          group_key: 'default', limit_id: null, account_id: 'claude-steven-max', account_label: 'Claude Max (Steven)',
          account_provider: 'claude', payer_tenant_id: 'Steven', paused_until: null, paused_reason: null,
          min_remaining_percent: 14, severity: 'warn',
          windows: [
            { window_key: 'session', label: 'sesión', used_percent: 45, remaining_percent: 55, used_units: null, limit_units: null, window_minutes: null, reset_at: iso(3_469_000), reset_in_seconds: 3_469, status: null, family: null, model: null, severity: 'ok', history: bucket([0, 12, 29, 45]) },
            { window_key: 'week_all', label: 'semana', used_percent: 86, remaining_percent: 14, used_units: null, limit_units: null, window_minutes: null, reset_at: iso(83_209_000), reset_in_seconds: 83_209, status: null, family: null, model: null, severity: 'warn', history: bucket([78, 80, 83, 86]) },
            { window_key: 'week_fable', label: 'Fable', used_percent: 0, remaining_percent: 100, used_units: null, limit_units: null, window_minutes: null, reset_at: iso(83_269_000), reset_in_seconds: 83_269, status: null, family: null, model: null, severity: 'ok', history: bucket([0, 0]) },
          ],
        }],
      },
      {
        host: 'kratos', provider: 'codex', ok: true, available: true, kind: 'detected-percent', source: 'codex-app-server', plan: 'pro',
        note: 'Codex app-server (consulta oficial).', effective_remaining_percent: 100, observed_at: secondsAgo(703), age_seconds: 703,
        available_groups: ['codex_bengalfox'], limiting_groups: ['codex'], severity: 'exhausted',
        groups: [
          {
            group_key: 'codex', limit_id: 'codex', account_id: 'codex-pro-steven', account_label: 'Codex Pro (principal)',
            account_provider: 'codex', payer_tenant_id: 'Steven', paused_until: iso(447_970_000), paused_reason: 'quota_exhausted:codex/codex/codex_primary_10080',
            min_remaining_percent: 0, severity: 'exhausted',
            windows: [
              { window_key: 'codex_primary_10080', label: 'semana', used_percent: 100, remaining_percent: 0, used_units: null, limit_units: null, window_minutes: 10_080, reset_at: iso(447_970_000), reset_in_seconds: 447_970, status: 'rate-limited', family: null, model: null, severity: 'exhausted', history: bucket([94, 97, 100, 100]) },
            ],
          },
          {
            // Sin account_id: aparece también en unbound_groups[] más abajo. La UI no debe
            // ocultar esta fila; sólo debe dejar en claro que no puede pausar nada.
            group_key: 'codex_bengalfox', limit_id: 'codex_bengalfox', account_id: null, account_label: null,
            account_provider: null, payer_tenant_id: null, paused_until: null, paused_reason: null,
            min_remaining_percent: 100, severity: 'ok',
            windows: [
              { window_key: 'codex_bengalfox_primary_10080', label: 'semana', used_percent: 0, remaining_percent: 100, used_units: null, limit_units: null, window_minutes: 10_080, reset_at: iso(603_353_000), reset_in_seconds: 603_353, status: null, family: null, model: null, severity: 'ok', history: bucket([0, 0]) },
            ],
          },
        ],
      },
      {
        host: 'kratos', provider: 'antigravity', ok: true, available: true, kind: 'detected-percent', source: 'antigravity-api', plan: null,
        note: 'Antigravity (API real). 8 ventanas con cuota, 3 Claude/GPT ofrecidas con cuota desconocida.', effective_remaining_percent: 100,
        observed_at: secondsAgo(707), age_seconds: 707, available_groups: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview'], limiting_groups: [], severity: 'ok',
        groups: [{
          group_key: 'default', limit_id: null, account_id: 'antigravity-steven', account_label: 'Antigravity (Steven)',
          account_provider: 'antigravity', payer_tenant_id: 'Steven', paused_until: null, paused_reason: null,
          min_remaining_percent: 62, severity: 'warn',
          // Ocho ventanas del mismo family: exactamente el caso que hay que colapsar en una fila
          // y no ahogar con 8 filas la fila de claude/codex, que son las que realmente importan.
          windows: [
            { window_key: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro', used_percent: 0, remaining_percent: 100, used_units: null, limit_units: null, window_minutes: 1_440, reset_at: iso(85_693_000), reset_in_seconds: 85_693, status: null, family: 'gemini', model: 'gemini-3.1-pro-preview', severity: 'ok', history: bucket([0, 0]) },
            { window_key: 'gemini-3-flash-preview', label: 'gemini-3-flash', used_percent: 38, remaining_percent: 62, used_units: null, limit_units: null, window_minutes: 1_440, reset_at: iso(85_693_000), reset_in_seconds: 85_693, status: null, family: 'gemini', model: 'gemini-3-flash-preview', severity: 'warn', history: bucket([10, 20, 30, 38]) },
          ],
        }],
      },
      {
        host: 'kratos', provider: 'opencode', ok: true, available: true, kind: 'detected-percent', source: 'opencode-db', plan: null,
        note: 'Estimado local (opencode.db). Para valores exactos ve a opencode.ai/auth.', effective_remaining_percent: 100,
        observed_at: secondsAgo(717), age_seconds: 717, available_groups: [], limiting_groups: [], severity: 'ok',
        groups: [{
          group_key: 'default', limit_id: null, account_id: 'minimax-pool', account_label: 'MiniMax / OpenCode',
          account_provider: 'opencode', payer_tenant_id: 'Steven', paused_until: null, paused_reason: null,
          min_remaining_percent: 100, severity: 'ok',
          windows: [
            { window_key: '5h', label: '5 horas', used_percent: 0, remaining_percent: 100, used_units: 0, limit_units: 12, window_minutes: 300, reset_at: iso(17_283_000), reset_in_seconds: 17_283, status: null, family: null, model: null, severity: 'ok', history: bucket([0, 0]) },
            { window_key: 'week', label: 'semanal', used_percent: 0, remaining_percent: 100, used_units: 0, limit_units: 30, window_minutes: 10_080, reset_at: iso(551_269_000), reset_in_seconds: 551_269, status: null, family: null, model: null, severity: 'ok', history: { bucket_seconds: 1_800, points: [] } },
            { window_key: 'month', label: 'mensual', used_percent: 0, remaining_percent: 100, used_units: 0, limit_units: 60, window_minutes: 43_200, reset_at: iso(378_469_000), reset_in_seconds: 378_469, status: null, family: null, model: null, severity: 'ok', history: { bucket_seconds: 1_800, points: [] } },
          ],
        }],
      },
    ],
    unbound_groups: [
      { host: 'kratos', provider: 'codex', group_key: 'codex_bengalfox', window_count: 1, reason: 'no_account_id_supplied', detail: 'El recolector no mandó account_id para este grupo: la muestra se guarda pero no puede pausar ninguna suscripción.' },
    ],
    paused_accounts: [
      { account_id: 'codex-pro-steven', provider: 'codex', label: 'Codex Pro (principal)', payer_tenant_id: 'Steven', paused_until: iso(447_970_000), paused_reason: 'quota_exhausted:codex/codex/codex_primary_10080', automatic: true },
    ],
  };
}

/**
 * Trabajo cerrado en 24 h por alias, para poder ejercitar el TAMAÑO del muñeco.
 *
 * `midas` no está en la tabla a propósito, y no es un descuido del fixture: es el caso de un alias
 * del que el servidor no informa el cierre. La vista tiene que dibujarlo en el mínimo y quitarle el
 * pie del globo, nunca inventarle un cero — que en una pantalla donde el tamaño significa "cuánto
 * trabajó" sería una acusación falsa.
 */
const CERRADAS_24H: Record<string, number> = {
  'Steven/zeus': 27, 'Steven/kant': 41, 'Steven/socrates': 12, 'Steven/argos': 19, 'Steven/jarvis': 33,
  'Miguel/janus': 16, 'Miguel/kratos': 22, 'Miguel/iza': 0, 'Miguel/atlas': 0,
  'Pablo/dedalo': 9, 'Pablo/seneca': 6, 'Pablo/vulcano': 0,
  'Isa/salva': 3, 'Jhon/hegel': 1,
};

/** Salas por alias, derivadas de la MISMA topología de arriba: dos fixtures que se contradicen
 *  producen una vista que se contradice, y el defecto parece del código. */
function salasDe(tenantId: string, alias: string): string[] {
  const tenant = topology.tenants?.find((candidate) => candidate.id === tenantId);
  return (tenant?.rooms ?? [])
    .filter((room) => (room.members ?? []).some((member) => member.alias === alias))
    .map((room) => room.id ?? 'UNKNOWN');
}

/**
 * Agrega por par lo que el backend agregará algún día en SQL.
 *
 * Se separa la ida de la vuelta: `kratos → janus` y `janus → kratos` son sentidos distintos del
 * mismo par y contarlos juntos duplicaría cada conversación. El `total_window` se infla sobre el
 * "en vuelo" a propósito, para que el grosor de la flecha no sea idéntico al color y las dos
 * codificaciones se puedan distinguir en pantalla.
 */
function aristasDe(agents: FleetActivitySnapshot['agents']): FleetDelegationEdge[] {
  const conocidos = new Set((agents ?? []).map((agent) => `${agent.tenant_id}/${agent.alias}`));
  const acumulado = new Map<string, FleetDelegationEdge>();
  for (const agent of agents ?? []) {
    const destino = `${agent.tenant_id}/${agent.alias}`;
    for (const item of agent.in_flight_items ?? []) {
      if (!item.from_tenant || !item.from_alias) continue;
      const origen = `${item.from_tenant}/${item.from_alias}`;
      if (origen === destino || !conocidos.has(origen)) continue;
      const clave = `${origen}->${destino}`;
      const actual = acumulado.get(clave) ?? {
        from_tenant: item.from_tenant, from_alias: item.from_alias,
        to_tenant: agent.tenant_id, to_alias: agent.alias,
        in_flight: 0, total_window: 0, last_at: iso(0),
      };
      actual.in_flight = (actual.in_flight ?? 0) + 1;
      actual.total_window = (actual.total_window ?? 0) + 3;
      acumulado.set(clave, actual);
    }
  }
  return [...acumulado.values()];
}

function enriquecer(snapshot: FleetActivitySnapshot): FleetActivitySnapshot {
  const agents = (snapshot.agents ?? []).map((agent) => {
    const key = `${agent.tenant_id}/${agent.alias}`;
    const cerradas = CERRADAS_24H[key];
    return {
      ...agent,
      rooms: salasDe(agent.tenant_id, agent.alias),
      // `undefined` cuando el alias no está en la tabla: el campo AUSENTE es un caso distinto del
      // cero y la vista tiene que poder distinguirlos.
      ...(typeof cerradas === 'number' ? { closed_24h: cerradas, failed_24h: 0 } : {}),
    };
  });
  return { ...snapshot, agents, edges: aristasDe(agents) };
}

/**
 * El escenario que de verdad se ve casi siempre: **la flota en reposo**.
 *
 * Medido en producción: una entrega en vuelo en toda la base y cero en cola. El fixture normal de
 * arriba es un día de incendio —útil para ejercitar los siete estados de una vez, inútil para
 * comprobar lo que Steven ve el 95 % del tiempo—. Si la vista sólo se lee bien con quince agentes
 * trabajando a la vez, se lee mal casi siempre; y el riesgo concreto es que quince muñecos grises
 * sin una flecha se interpreten como una flota muerta.
 */
export function mockActivityEnReposo(): FleetActivitySnapshot {
  const base = mockActivity();
  const agents = (base.agents ?? []).map((agent) => ({
    ...agent,
    // Reposo significa que TODOS están de alta y conectados, sin nada entre manos. El fixture
    // normal trae a propósito dos alias dados de baja en el registro y uno sin registrar, que son
    // casos legítimos de "necesita atención" — pero mezclarlos acá haría imposible comprobar lo
    // único que este escenario existe para comprobar: que una flota sana no se lea como muerta.
    registered: true,
    agent_enabled: true,
    work_state: 'idle' as const,
    flags: [],
    in_flight: 0, started: 0, claimed_not_started: 0,
    queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
    oldest_claimed_at: null, oldest_in_flight_seconds: null, nearest_ack_deadline_at: null,
    in_flight_items: [], in_flight_items_truncated: false,
    presence: { online: true, instance_id: agent.presence?.instance_id ?? null, epoch: agent.presence?.epoch ?? null, last_heartbeat_at: secondsAgo(4), lease_until: iso(25_000) },
    last_ack_at: secondsAgo(120), seconds_since_last_ack: 120, acks_recent: 0,
  }));
  return {
    ...base,
    agents,
    edges: [],
    totals: {
      agents: agents.length,
      by_state: { idle: agents.length },
      flagged: {},
      in_flight: 0, queued: 0, retrying: 0, overdue_in_flight: 0,
    },
  };
}

/**
 * GET /v3/console/chains/:traceId, con la forma EXACTA de `repository.agentChain()`.
 *
 * Trae a propósito un extremo `redacted`: la cadena cruza a un cliente que este operador no puede
 * leer, y el store lo reduce a un id opaco estable en vez de borrar la arista. Un fixture que
 * mostrara todos los extremos visibles nunca ejercitaría el único camino donde la consola puede
 * filtrar datos de otro tenant por accidente.
 */
export function mockChain(traceId: string) {
  return {
    trace_id: traceId,
    observed_at: iso(0),
    truncated: false,
    nodes: [
      { tenant_id: 'Steven', alias: 'zeus', hop_count: 0, delegated: 2, received: 0, open_branches: 0 },
      { tenant_id: 'Steven', alias: 'socrates', hop_count: 1, delegated: 1, received: 1, open_branches: 1 },
      { tenant_id: 'Miguel', alias: 'janus', hop_count: 2, delegated: 0, received: 1, open_branches: 0 },
    ],
    edges: [
      {
        source: { tenant_id: 'Steven', alias: 'zeus', delivery_id: '1c0ffee0-0001-4000-8000-a1b2c3d4e5f6', attempt: 1, status: 'done' },
        target: { tenant_id: 'Steven', alias: 'socrates', delivery_id: '1c0ffee0-0002-4000-8000-a1b2c3d4e5f6', attempt: 1, status: 'started', terminal_at: null },
        output_index: 0, state: 'materialized', rejection_code: null,
        hop_count: 1, hop_budget: 6, visited_depth: 1, open: true,
        response: { decision: 'allow', reason: 'acl allow_route', outcome: 'delivered' },
        root_message_id: 'msg-root-1', created_at: secondsAgo(220),
      },
      {
        source: { tenant_id: 'Steven', alias: 'socrates', delivery_id: '1c0ffee0-0002-4000-8000-a1b2c3d4e5f6', attempt: 1, status: 'started' },
        target: { redacted: true as const, node_id: 'opaque-9f31c0a4b7' },
        output_index: 1, state: 'materialized', rejection_code: null,
        hop_count: 2, hop_budget: 6, visited_depth: 2, open: false,
        response: { decision: 'allow', reason: 'acl allow_route', outcome: 'delivered' },
        root_message_id: 'msg-root-1', created_at: secondsAgo(140),
      },
      {
        source: { tenant_id: 'Steven', alias: 'socrates', delivery_id: '1c0ffee0-0002-4000-8000-a1b2c3d4e5f6', attempt: 1, status: 'started' },
        target: null,
        output_index: 2, state: 'rejected', rejection_code: 'hop_budget_exhausted',
        hop_count: 6, hop_budget: 6, visited_depth: 6, open: false,
        response: null, root_message_id: 'msg-root-1', created_at: secondsAgo(90),
      },
    ],
    origin_relays: [],
    counters: { edges: 3, hidden_edges: 1, redacted_endpoints: 1, open_branches: 1, rejected_branches: 1 },
  };
}
