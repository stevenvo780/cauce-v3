import { http, HttpResponse } from 'msw';

export const v4Handlers = [
  http.get('*/v3/console/fleet/hosts/enrollments', () => HttpResponse.json({ enrollments: [] })),
  http.get('*/v3/console/context/agents/:tenant/:alias', () => HttpResponse.json({ version: 0, files: [], desired_version: 0,
    applied_version: null, application: { state: 'pending', last_error: null },
    sync: { state: 'pending', git_commit: null, pushed_at: null, last_error: null } })),
  http.get('*/v3/console/context/agents/:tenant/:alias/history', () => HttpResponse.json({ entries: [], next_cursor: null })),
  http.get('*/v3/console/companies', () => HttpResponse.json({ home_company: 'humanizar', acting_company: 'humanizar',
    role: 'company_owner', scope: 'company', platform_override: false,
    companies: [{ id: 'humanizar', name: 'Humanizar (demo)', state: 'enabled', version: 1 }] })),
  http.get('*/v3/console/preferences', () => HttpResponse.json({ version: 0, pinned_quota_accounts: [] })),
  http.get('*/v3/console/office/layout', () => HttpResponse.json({ company_id: 'humanizar', version: 0, rooms: [] })),
  http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'humanizar', observed_at: new Date().toISOString(), accounts: [] })),
  http.get('*/v3/console/quota-environments', () => HttpResponse.json({ company_id: 'humanizar', environments: [], operations: [],
    capabilities: { available: false, providers: ['claude', 'codex', 'gemini', 'grok'], hosts: [], actions: [] } })),
];
