import { loadFixtures } from './mobile-views-fixtures.mjs';

const COMPANY = 'humanizar';
const OBSERVED_AT = '2026-10-12T10:00:00.000Z';
const PREVIOUS_AT = '2026-10-11T10:00:00.000Z';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const ACTIONS = ['create', 'authenticate', 'query', 'update_cli', 'delete'];
const PERMISSIONS = ['message.publish', 'delivery.replay', 'delivery.cancel', 'job.create', 'config.write',
  'config.rollback', 'dlq.resolve', 'ultimate-terminal.connect'];

const people = [
  { id: OWNER_ID, email: 'steven@example.test', display_name: 'Steven (QA)', role: 'operator',
    tenant_id: 'Steven', alias: 'kant', active: true, revision: '1791799200000001' },
  { id: ADMIN_ID, email: 'andrea@example.test', display_name: 'Andrea (QA)', role: 'operator',
    tenant_id: 'Steven', alias: 'jarvis', active: true, revision: '1791799200000002' },
  { id: '33333333-3333-4333-8333-333333333333', email: 'miguel@example.test', display_name: 'Miguel (QA)',
    role: 'reader', tenant_id: 'Miguel', alias: 'janus', active: false, revision: '1791799200000003' },
];

const hosts = [
  { host_id: 'humanizar-kratos', display_name: 'Torre principal', notes: 'Estación de coordinación y consultas',
    enabled: true, status: 'reachable', status_source: 'controller', last_seen_at: OBSERVED_AT,
    registered: true, approved: true, version: 2,
    agents: [{ tenant_id: 'Steven', alias: 'kant', enabled: true, online: true },
      { tenant_id: 'Steven', alias: 'jarvis', enabled: true, online: true }] },
  { host_id: 'humanizar-portatil', display_name: 'Portátil Fedora', notes: 'Identidad enrolada; preparación pendiente',
    enabled: true, status: 'unreachable', status_source: 'controller', last_seen_at: PREVIOUS_AT,
    registered: true, approved: false, version: 1,
    agents: [{ tenant_id: 'Miguel', alias: 'janus', enabled: true, online: false }] },
];

const SCENARIOS = ['company', 'platform', 'retired', 'register', 'reader', 'quota-error', 'empty-office'];

function authority(scenario) {
  return { role: scenario === 'retired' ? 'none' : scenario === 'platform' ? 'platform_admin' : scenario === 'reader' ? 'reader' : 'company_owner',
    scope: scenario === 'platform' ? 'platform' : scenario === 'reader' ? 'tenant' : 'company', home_company: COMPANY,
    acting_company: COMPANY, platform_override: scenario === 'platform' };
}

function quotaAccount(id, provider, label, agents, remaining, minutes, windowLabel) {
  return { id, provider, label, enabled: true, version: 2, payer_tenant_id: 'Steven',
    shared: agents.length > 1, agent_count: agents.length, agents: agents.map(alias => ({ tenant_id: 'Steven', alias, enabled: true })),
    paused_until: null, paused_reason: null, observation_status: 'ok', remaining_percent: remaining, note: null,
    windows: [{ group_key: 'primary', window_key: minutes === 10080 ? 'weekly' : 'five-hours', model: null,
      label: windowLabel, host: hosts[0].host_id, used_percent: 100 - remaining, remaining_percent: remaining,
      window_minutes: minutes, captured_at: OBSERVED_AT, received_at: OBSERVED_AT,
      reset_at: minutes === 10080 ? '2026-10-19T10:00:00.000Z' : '2026-10-12T15:00:00.000Z', observation_status: 'ok' }] };
}

const accounts = [
  quotaAccount('codex-steven', 'codex', 'Codex compartida', ['kant', 'jarvis'], 56, 10080, 'Semanal'),
  quotaAccount('claude-steven', 'claude', 'Claude de coordinación', ['zeus'], 82, 300, 'Cinco horas'),
];

const environments = accounts.map((account, index) => ({ id: `quota-environment-${index + 1}`, company_id: COMPANY,
  account_id: account.id, host_id: hosts[0].host_id, provider: account.provider, label: `Consulta ${account.provider} en Kratos`,
  status: 'ready', version: 1, created_at: PREVIOUS_AT, updated_at: OBSERVED_AT }));

const contextFiles = [
  { path: 'context/directivas.md', content: '# Coordinación\n\nComprueba el efecto y conserva la evidencia de cada tarea.\n' },
  { path: 'context/notes/seguimiento.md', content: '# Seguimiento\n\nLa portátil conserva su identidad; falta preparar su ejecutor.\n' },
];

function contextHistory() {
  return { entries: [
    { version: 2, source: 'ui', restored_from: null, created_at: OBSERVED_AT,
      actor_human_id: OWNER_ID, actor_name: 'Steven (QA)', actor_alias: 'Steven (QA)', digest: 'b'.repeat(64) },
    { version: 1, source: 'native', restored_from: null, created_at: PREVIOUS_AT,
      actor_human_id: null, actor_alias: 'jarvis', digest: 'a'.repeat(64) },
  ], next_cursor: null };
}

function profileHistory(tenant, alias) {
  const fields = { purpose: 'Coordinar las tareas pendientes de la flota.', role_summary: 'Coordinación y seguimiento.',
    human_brief: 'Presenta resultados comprobados con sus límites.', responsibilities: ['Coordinar', 'Conservar evidencia'],
    restrictions: ['No publicar secretos'], tools: ['Terminal de Cauce'], operating_rules: ['Comprobar el efecto'] };
  return { observed_at: OBSERVED_AT, tenant_id: tenant, alias, entries: [
    { ...fields, id: 'profile-revision-2', tenant_id: tenant, alias, revision: 2, operation: 'update',
      actor_tenant: 'Steven', actor_alias: 'kant', changed_at: OBSERVED_AT },
    { ...fields, id: 'profile-revision-1', tenant_id: tenant, alias, revision: 1, operation: 'insert',
      responsibilities: ['Coordinar'], actor_tenant: 'Steven', actor_alias: 'zeus', changed_at: PREVIOUS_AT },
  ] };
}

export async function loadV4Fixtures() {
  const fallback = await loadFixtures();
  const topologyResponse = await fallback('http://localhost/v3/console/topology');
  if (!topologyResponse?.ok) throw new Error('V4 layout fixtures require the demonstration topology');
  const topology = await topologyResponse.json();
  const rooms = (topology.tenants ?? []).flatMap(tenant => (tenant.rooms ?? []).map(room => ({
    tenant_id: tenant.id, room_id: room.id,
  })));
  const office = { company_id: COMPANY, version: 2, available: rooms,
    rooms: rooms.map((room, index) => ({ ...room, x: index % 3 * 330, y: Math.floor(index / 3) * 290,
      width: 300, height: 260, parts: [{ id: `part-${index + 1}`, label: 'Mesa de coordinación',
        x: 16, y: 180, width: 220, height: 60 }] })) };

  return async (url, method = 'GET', scenario = 'company') => {
    const { pathname: path } = new URL(url);
    if (method !== 'GET') throw new Error(`Mutation blocked: ${method} ${path}`);
    if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown V4 layout scenario: ${scenario}`);
    const access = authority(scenario);
    if (path === '/v3/auth/session') return Response.json(scenario === 'register'
      ? { authenticated: false, login_mode: 'password' }
      : { authenticated: true, login_mode: 'password', subject: 'Steven:kant', home_tenant: 'Steven', name: 'Steven (QA)',
        roles: ['operator'], permissions: PERMISSIONS, expires_at: '2099-01-01T00:00:00.000Z',
        csrf_token: 'layout-qa-csrf', authority: access });
    if (path === '/v3/console/access') return Response.json({ subject: 'Steven:kant', human_subject: OWNER_ID,
      roles: ['operator'], permissions: PERMISSIONS, observed_at: OBSERVED_AT });
    if (path === '/v3/console/mcp/client-delegations') return Response.json({ items: [], truncated: false });
    if (path === '/v3/console/config') {
      const response = await fallback(url);
      if (!response?.ok) return response;
      const configuration = await response.json();
      return Response.json({ ...configuration, observed_at: OBSERVED_AT, capabilities: {
        actor: { tenant_id: 'Steven', alias: 'kant', is_hub: true, can_control: true, role: access.role,
          scope: access.scope, company_id: COMPANY, platform_override: access.platform_override },
        resources: ['tenant', 'room', 'membership', 'agent', 'agent_profile', 'fleet_host'].map(resource => ({
          resource, actions: ['create', 'update', 'delete', 'retire', 'restore'], scope: access.scope,
        })),
      } });
    }
    // The error state answers like the gateway does: a stable code and a concrete reason the console must keep.
    if (path === '/v3/console/quota-accounts' && scenario === 'quota-error') return Response.json(
      { error: 'forbidden', message: 'La cuenta de cuota pertenece a otra empresa.' }, { status: 403 });
    if (path === '/v3/console/quota-accounts') return Response.json({ company_id: COMPANY, observed_at: OBSERVED_AT, accounts });
    if (path === '/v3/console/preferences') return Response.json({ version: 1, pinned_quota_accounts: ['codex-steven'] });
    if (path === '/v3/console/quota-environments') return Response.json({ company_id: COMPANY, environments, operations: [],
      capabilities: { available: true, providers: ['claude', 'codex'], actions: ACTIONS,
        hosts: [{ host_id: hosts[0].host_id, display_name: hosts[0].display_name, providers: ['claude', 'codex'],
          provider_actions: { claude: ACTIONS, codex: ACTIONS } }] } });
    if (path === '/v3/console/office/layout') return Response.json(scenario === 'empty-office'
      ? { company_id: COMPANY, version: 0, available: [], rooms: [] } : office);
    if (path === '/v3/console/fleet/hosts') return Response.json({ hosts });
    if (path === '/v3/console/fleet/hosts/enrollments') return Response.json({ setup_signer_fingerprint: 'c'.repeat(64),
      enrollments: hosts.map((host, index) => ({ enrollment_id: `layout-enrollment-${index + 1}`, company_id: COMPANY,
        host_id: host.host_id, display_name: host.display_name, state: 'enrolled',
        expires_at: '2026-10-19T10:00:00.000Z', enrolled_at: PREVIOUS_AT, executor_ready: host.approved })) });
    if (path === '/v3/console/companies') return Response.json({ ...access,
      companies: [{ id: COMPANY, name: 'Humanizar (demo)', state: 'enabled', version: 2 },
        ...scenario === 'platform' ? [{ id: 'praxis', name: 'Praxis (demo)', state: 'disabled', version: 1 }] : []] });
    if (path === `/v3/console/companies/${COMPANY}/admins`) return Response.json({ company_id: COMPANY,
      items: people.filter(person => person.active).map((person, index) => ({ user_id: person.id, email: person.email,
        display_name: person.display_name, role: index === 0 ? 'owner' : 'admin', version: 1 })),
      capabilities: { grant_admin: true, grant_owner: true, revoke: true } });
    if (path === '/v3/console/companies/praxis/admins') return Response.json({ company_id: 'praxis', items: [],
      capabilities: { grant_admin: true, grant_owner: true, revoke: true } });
    if (path === '/v3/console/people') return Response.json({ items: people,
      capabilities: { create: true, update: true, retire: true, restore: true, purge: true } });
    const context = /^\/v3\/console\/context\/agents\/([^/]+)\/([^/]+)(\/history|\/diff)?$/u.exec(path);
    if (/^\/v3\/console\/spaces\/[^/]+\/[^/]+\/backups$/u.test(path)) return Response.json({ backups: [] });
    if (context?.[3] === '/history') return Response.json(contextHistory());
    if (context?.[3] === '/diff') return Response.json({ from: 1, to: 2, files: [{ path: contextFiles[0].path,
      before: '# Coordinación\n', after: contextFiles[0].content, change: 'modified' }] });
    if (context) return Response.json({ version: 2, files: contextFiles, desired_version: 2, applied_version: 2,
      application: { state: 'applied', last_error: null }, sync: { state: 'synced', git_commit: 'a'.repeat(40),
        pushed_at: OBSERVED_AT, last_error: null } });
    const journal = /^\/v3\/console\/tenants\/([^/]+)\/agents\/([^/]+)\/perfil\/revisions$/u.exec(path);
    if (journal) return Response.json(profileHistory(decodeURIComponent(journal[1]), decodeURIComponent(journal[2])));
    const documents = /^\/v3\/console\/tenants\/([^/]+)\/agents\/([^/]+)\/documents\/([^/]+)\/revisions$/u.exec(path);
    if (documents) return Response.json({ observed_at: OBSERVED_AT, tenant_id: decodeURIComponent(documents[1]),
      alias: decodeURIComponent(documents[2]), kind: decodeURIComponent(documents[3]), entries: [{ id: 'document-revision-1',
        path: '/home/dev/CLAUDE.md', sha256: 'd'.repeat(64), bytes: 300,
        actor_tenant: 'Steven', actor_alias: 'kant', written_at: OBSERVED_AT }] });
    return fallback(url, method);
  };
}
