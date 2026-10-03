import type { MessagePage, QueueSnapshot } from '../api/types';
import { mockStatus, mockActivity, topology } from '../mocks/data';

export function mobileChatFixtures(state = 'seeded') {
  const status = mockStatus();
  status.presence = status.presence?.map((agent) => ({ ...agent, online: true, lease_expires_at: '2099-01-01T00:00:00.000Z' }));
  const activity = mockActivity();
  activity.agents = activity.agents?.map((agent) => ({ ...agent, queued: 0, in_flight: 0, retrying: 0, in_flight_items: [] }));
  const texts = [
    '¿Podés revisar cómo quedó la conversación?',
    'Sí. El historial está visible y los controles están en el menú.',
    'Dejá los detalles de entrega disponibles cuando los necesite.',
    'Cada mensaje conserva su estado y su detalle. No se ocultan los errores.',
    '¿Y si cambio de agente mientras escribo?',
    'El borrador queda con su agente y su destino. Podés volver y seguir.',
    'Perfecto, revisemos también la vista del teléfono.',
    'Acá está la conversación. Podés leer los mensajes y escribir abajo.',
  ];
  const messages: MessagePage = { items: state === 'empty' ? [] : texts.map((body_preview, index) => ({
    message_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    trace_id: `qa-trace-${String(index)}`, tenant_id: 'Steven', room_id: 'grp.steven',
    actor_alias: index % 2 ? 'kant' : 'argos', body_preview, lane: 'interactive',
    created_at: new Date(Date.UTC(2026, 9, 3, 1, index)).toISOString(),
    deliveries: index % 2 ? [] : [{
      delivery_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      recipient_tenant: 'Steven', recipient_alias: 'kant', status: state === 'attention' && index === 6 ? 'failed' : 'done',
      attempt: 1, timeline: [],
    }],
  })) };
  const queues: QueueSnapshot = { observed_at: '2026-10-03T01:10:00Z', items: state === 'attention' ? [{
    delivery_id: '10000000-0000-4000-8000-000000000007', tenant_id: 'Steven', recipient_alias: 'kant', state: 'dead',
  }] : [] };
  return {
    '/v3/auth/session': { authenticated: true, subject: 'Steven:argos', name: 'Steven', roles: ['operator'], permissions: ['route', 'read', 'control'], expires_at: '2099-01-01T00:00:00.000Z', csrf_token: 'qa-only' },
    '/v3/console/access': { subject: 'Steven:argos', roles: ['operator'], permissions: ['message.publish', 'config.write', 'ultimate-terminal.connect'] },
    '/v3/status': status,
    '/v3/console/topology': topology,
    '/v3/console/activity': activity,
    '/v3/console/messages': messages,
    '/v3/console/queues': queues,
    '/v3/console/terminal/capability': { available: false, reason: 'Fixture de conversación, sin terminal real.' },
  };
}

export const LONG_MOBILE_AGENT = 'coordinador-supervisor-de-operaciones-internacionales';

export function mobileChatFailureFixtures(publishPermission: boolean) {
  const fixtures = JSON.parse(JSON.stringify(mobileChatFixtures()).replaceAll('kant', LONG_MOBILE_AGENT)) as ReturnType<typeof mobileChatFixtures>;
  for (const presence of fixtures['/v3/status'].presence ?? []) {
    if (presence.alias !== LONG_MOBILE_AGENT) continue;
    presence.online = false;
    presence.lease_expires_at = '2000-01-01T00:00:00Z';
  }
  if (!publishPermission) fixtures['/v3/console/access'].permissions = [];
  return fixtures;
}
