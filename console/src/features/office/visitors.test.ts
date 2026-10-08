import { describe, expect, it } from 'vitest';
import { clientConnectionsResponse } from '../../api/client/client-delegations-client';
import { isMailboxAlias, visitorsOf } from './visitors';

const alias = `mbx-${'a'.repeat(48)}`;
const row = (extra: Record<string, unknown>) => ({
  connection_ref: 'f'.repeat(64), client_id: 'cauce-dcr-x', created_at: '2026-10-08T00:00:00Z', expires_at: '2026-10-09T00:00:00Z',
  revoked: false, binding_id: null, label: null, display_label: null, basis: 'owner_declared_grant', instance: 'unknown',
  last_publication_at: null, last_use_at: null, last_use_observed: false, ...extra,
});

describe('MCP visitors', () => {
  it('only declared connections with a mailbox become visitors', () => {
    const page = clientConnectionsResponse({ truncated: false, items: [
      row({ binding_id: '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b', label: 'Dots', mailbox: { tenant_id: 'Steven', alias } }),
      row({ mailbox: null }),
      row({}),
    ] });
    expect(visitorsOf(page.items)).toEqual([{ id: `Steven/${alias}`, tenantId: 'Steven', alias, label: 'Dots', lastPublicationAt: null }]);
    expect(isMailboxAlias(alias)).toBe(true);
    expect(isMailboxAlias('kratos')).toBe(false);
  });

  it('rejects a mailbox that is not a mailbox address', () => {
    expect(() => clientConnectionsResponse({ truncated: false, items: [row({ mailbox: { tenant_id: 'Steven', alias: 'kratos' } })] })).toThrow();
  });
});
