import { delay, http, HttpResponse } from 'msw';
import {
  adapters, agentAccountBindings, audit, mockActivity, mockJobs, mockMessages, mockQueues,
  mockQuotas, mockStatus, originRelays, providerAccounts, registryAgents, routingCeiling, topology,
} from './data';

export const handlers = [
  http.get('*/v3/auth/session', () => HttpResponse.json({
    authenticated: true,
    subject: 'Steven:kant',
    roles: ['operator'],
    permissions: ['route', 'read', 'control'],
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    csrf_token: 'mock-csrf-token',
  })),
  http.post('*/v3/auth/logout', () => new HttpResponse(null, { status: 204 })),
  http.get('*/v3/status', async () => {
    await delay(120);
    return HttpResponse.json(mockStatus());
  }),
  http.get('*/v3/console/access', () => HttpResponse.json({
    subject: 'Steven:kant', roles: ['operator'],
    permissions: ['message.publish', 'delivery.replay', 'delivery.cancel', 'job.create', 'config.write', 'config.rollback', 'ultimate-terminal.connect'],
  })),
  http.get('*/v3/console/topology', () => HttpResponse.json(topology)),
  http.get('*/v3/console/activity', () => HttpResponse.json(mockActivity())),
  http.get('*/v3/console/quotas', () => HttpResponse.json(mockQuotas())),
  http.get('*/v3/console/messages', () => HttpResponse.json(mockMessages())),
  http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as { body?: { text?: string } };
    if (!input.body?.text) return HttpResponse.json({ error: 'invalid_request', message: 'text is required' }, { status: 422 });
    return HttpResponse.json({ message_id: crypto.randomUUID(), delivery_ids: [crypto.randomUUID()], duplicate: false, request_id: crypto.randomUUID(), trace_id: `trace-${crypto.randomUUID()}` }, { status: 202 });
  }),
  http.get('*/v3/console/queues', () => HttpResponse.json(mockQueues())),
  http.post('*/v3/console/deliveries/:deliveryId/replay', ({ params }) => HttpResponse.json({ delivery_id: params.deliveryId, state: 'pending', replayed: true }, { status: 202 })),
  http.post('*/v3/console/deliveries/:deliveryId/cancel', ({ params }) => HttpResponse.json({ delivery_id: params.deliveryId, state: 'dead', cancelled: true, cancelled_from_state: 'started', parent_notice: 'returned', origin_relayed: true, replayable: true }, { status: 200 })),
  http.get('*/v3/console/jobs', () => HttpResponse.json(mockJobs())),
  http.post('*/v3/console/jobs', () => HttpResponse.json({ job_id: crypto.randomUUID() }, { status: 202 })),
  http.get('*/v3/console/adapters', () => HttpResponse.json(adapters)),
  http.get('*/v3/console/audit', () => HttpResponse.json(audit)),
  http.get('*/v3/console/origin-relays', () => HttpResponse.json(originRelays)),
  http.get('*/v3/console/config', () => HttpResponse.json({
    revision: 1, observed_at: new Date().toISOString(), tenants: topology.tenants, rooms: [],
    memberships: [], acl_edges: topology.acl_edges, harness_definitions: adapters.items,
    role_policies: [{ role: 'operator', allow_route: true, allow_read: true, allow_control: true }],
    agents: registryAgents, provider_accounts: providerAccounts,
    alias_routing_ceiling: routingCeiling, agent_account_bindings: agentAccountBindings,
    revisions: []
  })),
  http.post('*/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as { dry_run?: boolean; mutation?: Record<string, unknown> };
    return HttpResponse.json({ applied: input.dry_run !== true, dry_run: input.dry_run === true, revision: input.dry_run ? 1 : 2, mutation: input.mutation, summary: 'mock configuration validation' }, { status: input.dry_run ? 200 : 201 });
  }),
  http.post('*/v3/console/config/revisions/:revisionId/rollback', ({ params }) => HttpResponse.json({ applied: true, dry_run: false, revision: Number(params.revisionId) + 1 }, { status: 201 })),
  http.get('*/v3/console/observability', () => HttpResponse.json({
    observed_at: new Date().toISOString(), status: mockStatus(), queues: mockQueues(),
    jobs: mockJobs(), origin_relays: originRelays
  })),
  http.get('*/v3/console/terminal/capability', () => HttpResponse.json({ available: false, reason: 'Backend PTY no instalado en este entorno' })),
];
