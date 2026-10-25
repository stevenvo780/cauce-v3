import { expect, it } from 'vitest';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import type { QuotaEnvironmentsSnapshot } from '../../api/client/my-quotas-client';
import { placementHosts, quotaOnlyHostIds } from './quota-only-hosts';

const host = (host_id: string, agents: FleetHost['agents'] = []): FleetHost => ({ host_id, display_name: host_id, notes: '', enabled: true,
  status: 'unknown', status_source: 'none', last_seen_at: null, registered: true, approved: true, version: 1, agents });
const quota = { company_id: 'one', environments: [], operations: [], capabilities: { available: true, providers: ['codex'], actions: [],
  hosts: [{ host_id: 'consulta', display_name: 'consulta', providers: ['codex'], provider_actions: {} }, { host_id: 'mixto', display_name: 'mixto', providers: ['codex'], provider_actions: {} },
    { host_id: 'mixto2', display_name: 'mixto2', providers: ['codex'], provider_actions: {} }] } } as QuotaEnvironmentsSnapshot;
const enrollment = (host_id: string) => ({ enrollment_id: host_id, company_id: 'one', host_id, display_name: host_id, state: 'enrolled' as const,
  expires_at: '2026-10-25T00:00:00Z', enrolled_at: null, executor_ready: true });

it('oculta solo el ordenador que ejecuta cuotas y no ofrece plantillas ni tiene agentes', () => {
  const hosts = [host('consulta'), host('mixto'), host('mixto2', [{ tenant_id: 'a', alias: 'b', enabled: true, online: true }]), host('agentes')];
  const hidden = quotaOnlyHostIds(hosts, quota, { enrollments: [enrollment('mixto')] });
  expect([...hidden]).toEqual(['consulta']);
  expect(placementHosts(hosts, hidden).map(item => item.host_id)).toEqual(['mixto', 'mixto2', 'agentes']);
  expect(placementHosts(hosts, hidden, 'consulta')).toHaveLength(4);
});
it('sin lectura de cuotas no oculta nada', () => {
  expect(quotaOnlyHostIds([host('consulta')], undefined, undefined).size).toBe(0);
});
