import type {
  AdapterPage,
  AuditPage,
  JobPage,
  MessagePage,
  OriginRelayPage,
  QueueSnapshot,
  SystemStatus,
  TopologySnapshot,
} from '../api/types';

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

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

export const topology: TopologySnapshot = {
  observed_at: '2026-07-22T16:12:08.000Z',
  tenants: [
    { id: 'Steven', label: 'Steven', rooms: [{ id: 'grp.steven', label: 'grp.steven', members: [{ alias: 'kant', enabled: true }, { alias: 'argos', enabled: true }, { alias: 'socrates', enabled: true }, { alias: 'jarvis', enabled: true }] }] },
    { id: 'Miguel', label: 'Miguel', rooms: [{ id: 'grp.miguel', label: 'grp.miguel', members: [{ alias: 'kratos', enabled: true }, { alias: 'janus', enabled: true }] }] },
    { id: 'Isa', label: 'Isa', rooms: [{ id: 'grp.isa', label: 'grp.isa', members: [{ alias: 'salva', enabled: true }] }] },
    { id: 'Jhon', label: 'Jhon', rooms: [{ id: 'grp.jhon', label: 'grp.jhon', members: [{ alias: 'hegel', enabled: true }] }] },
    { id: 'Pablo', label: 'Pablo', rooms: [{ id: 'grp.pablo', label: 'grp.pablo', members: [{ alias: 'dedalo', enabled: true }, { alias: 'midas', enabled: true }, { alias: 'seneca', enabled: true }, { alias: 'vulcano', enabled: false }] }] },
  ],
  acl_edges: [
    { from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true, allow_route: true, allow_read: true, allow_control: true, policy: 'explicit-cross-tenant' },
    { from_tenant: 'Miguel', to_tenant: 'Steven', enabled: true, allow_route: true, allow_read: true, allow_control: true, policy: 'explicit-cross-tenant' },
    { from_tenant: 'Miguel', to_tenant: 'Pablo', enabled: false, allow_route: false, allow_read: false, allow_control: false, policy: 'default-deny' },
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
