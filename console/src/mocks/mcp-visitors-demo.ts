import { http, HttpResponse } from 'msw';

const connection = (label: string, seed: string, lastPublicationAt: string | null) => ({
  connection_ref: seed.repeat(64), client_id: `cauce-dcr-demo-${label.toLowerCase()}`,
  created_at: '2026-10-08T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', revoked: false,
  binding_id: `${seed.repeat(8)}-${seed.repeat(4)}-4${seed.repeat(3)}-a${seed.repeat(3)}-${seed.repeat(12)}`,
  label, display_label: `${label} por cuenta de Steven`, basis: 'owner_declared_grant', instance: 'unknown',
  last_publication_at: lastPublicationAt, last_use_at: null, last_use_observed: false,
  mailbox: { tenant_id: 'Steven', alias: `mbx-${seed.repeat(48)}` },
});

/** Two declared MCP clients so the office shows its visitors in the demo. */
export const mcpVisitorsDemoHandlers = [
  http.get('*/v3/console/mcp/client-delegations', () => HttpResponse.json({ truncated: false, items: [
    connection('Dots', 'd', new Date(Date.now() - 4 * 60_000).toISOString()),
    connection('GPT', 'e', null),
  ] })),
];
