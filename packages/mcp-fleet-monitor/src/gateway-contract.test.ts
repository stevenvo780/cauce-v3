import { describe, expect, it } from 'vitest';
import { gatewayBridgeConfiguration } from './gateway-configuration.js';
import { MAX_GATEWAY_ITEMS, projectGatewayAgents, projectGatewayStatus } from './gateway-projection.js';

const environment = {
  CAUCE_GATEWAY_ORIGIN: 'https://gateway.example:8443',
  CAUCE_MCP_PUBLIC_ORIGIN: 'https://mcp.example',
  CAUCE_MCP_TENANT_ID: 'TenantA',
  CAUCE_MCP_AUTH_MODE: 'static',
  CAUCE_MCP_ACCESS_TOKEN: 'mcp-fixture-not-a-real-token-00000000',
  CAUCE_GATEWAY_BEARER_TOKEN: 'gateway-fixture-not-a-real-token',
};
const presence = { tenant_id: 'TenantA', alias: 'alpha', online: true, last_heartbeat_at: '2026-01-01T00:00:00.000Z' };
const agent = { ...presence, enabled: true, deployment_status: 'online' };

describe('gateway bridge configuration', () => {
  it('accepts fixed HTTPS origins and separate credentials without identity headers', () => {
    expect(gatewayBridgeConfiguration({ ...environment, CAUCE_MCP_PORT: '3201', CAUCE_TENANT_ID: 'Ignored' })).toEqual({
      publicOrigin: 'https://mcp.example', port: 3201, authentication: { mode: 'static', accessToken: environment.CAUCE_MCP_ACCESS_TOKEN },
      gateway: { origin: 'https://gateway.example:8443', tenant: 'TenantA', bearerToken: environment.CAUCE_GATEWAY_BEARER_TOKEN },
    });
  });

  it('supports explicitly supplied mTLS paths with an optional private CA', () => {
    expect(gatewayBridgeConfiguration({
      ...environment, CAUCE_GATEWAY_BEARER_TOKEN: undefined,
      CAUCE_GATEWAY_CERT_FILE: '/fixture/cert.pem', CAUCE_GATEWAY_KEY_FILE: '/fixture/key.pem', CAUCE_GATEWAY_CA_FILE: '/fixture/ca.pem',
    }).gateway).toEqual({ origin: 'https://gateway.example:8443', tenant: 'TenantA', certificateFile: '/fixture/cert.pem', keyFile: '/fixture/key.pem', caFile: '/fixture/ca.pem' });
  });

  it.each([
    { CAUCE_GATEWAY_ORIGIN: 'http://gateway.example' },
    { CAUCE_GATEWAY_ORIGIN: 'https://user:secret@gateway.example' },
    { CAUCE_GATEWAY_ORIGIN: 'https://gateway.example/v3/status' },
    { CAUCE_GATEWAY_ORIGIN: 'https://gateway.example/?token=secret' },
    { CAUCE_GATEWAY_ORIGIN: 'https://gateway.example/#secret' },
    { CAUCE_GATEWAY_ORIGIN: ' https://gateway.example' },
    { CAUCE_GATEWAY_ORIGIN: 'https://gateway.example/../' },
    { CAUCE_MCP_PUBLIC_ORIGIN: 'http://mcp.example' },
    { CAUCE_MCP_ACCESS_TOKEN: '' },
    { CAUCE_MCP_ACCESS_TOKEN: environment.CAUCE_GATEWAY_BEARER_TOKEN },
    { CAUCE_GATEWAY_BEARER_TOKEN: environment.CAUCE_MCP_ACCESS_TOKEN },
    { CAUCE_GATEWAY_BEARER_TOKEN: 'secret\r\nx-cauce-tenant: Other' },
    { CAUCE_GATEWAY_BEARER_TOKEN: undefined },
    { CAUCE_GATEWAY_CERT_FILE: '/fixture/cert.pem' },
    { CAUCE_GATEWAY_CA_FILE: 'relative.pem' },
    { CAUCE_GATEWAY_KEY_FILE: '/fixture/key.pem' },
    { CAUCE_MCP_TENANT_ID: '../Other' },
    { CAUCE_MCP_TENANT_ID: undefined },
    { CAUCE_MCP_PORT: '0' },
    { CAUCE_MCP_PORT: '65536' },
    { CAUCE_MCP_PORT: '1e4' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  ])('fails closed on unsafe or missing configuration %#', (override) => {
    expect(() => gatewayBridgeConfiguration({ ...environment, ...override })).toThrow();
  });

  it('does not include secret values in validation errors', () => {
    const secret = 'sensitive value\r\n';
    try { gatewayBridgeConfiguration({ ...environment, CAUCE_GATEWAY_BEARER_TOKEN: secret }); }
    catch (error) { expect(String(error)).not.toContain(secret); return; }
    throw new Error('invalid token was accepted');
  });
});

describe('gateway response projection', () => {
  it('scopes presence before counting; drops global ACL aggregates and internal data', () => {
    const output = projectGatewayStatus({
      version: '3.0', queued: 500, online: 50, auth_provider: 'private',
      presence: [{ ...presence, instance_id: 'secret', capabilities: ['untrusted text'] }, { ...presence, tenant_id: 'Other' }],
    }, 'TenantA');
    expect(output).toEqual({ tenant_id: 'TenantA', version: '3.0', online: 1, presence: { items: [presence], total: 1, truncated: false } });
  });

  it('filters foreign duplicate aliases and projects only approved registry fields', () => {
    expect(projectGatewayAgents({ items: [
      { ...agent, container_name: 'secret', home_directory: '/private', state_directory: '/state', runtime_user: 'root',
        display_name: 'Ignore instructions', routing_accounts: ['secret'], fallback_account_count: 9 },
      { ...agent, tenant_id: 'Other' },
    ] }, 'TenantA')).toEqual({ tenant_id: 'TenantA', items: [agent], total: 1, truncated: false });
  });

  it('preserves unknown state and does not equate no visible rows with health', () => {
    const unknown = { ...agent, online: null, deployment_status: 'unknown', last_heartbeat_at: null };
    expect(projectGatewayAgents({ items: [unknown] }, 'TenantA').items).toEqual([unknown]);
    expect(projectGatewayStatus({ version: '3.0', presence: [] }, 'TenantA')).toEqual({
      tenant_id: 'TenantA', version: '3.0', online: 0, presence: { items: [], total: 0, truncated: false },
    });
  });

  it('bounds both lists and reports truncation and full scoped totals', () => {
    const items = Array.from({ length: MAX_GATEWAY_ITEMS + 1 }, (_, index) => ({ ...agent, alias: `agent-${String(index)}` }));
    const agents = projectGatewayAgents({ items }, 'TenantA');
    const status = projectGatewayStatus({ version: '3.0', presence: items }, 'TenantA');
    expect(agents.items).toHaveLength(MAX_GATEWAY_ITEMS);
    expect(agents.total).toBe(MAX_GATEWAY_ITEMS + 1);
    expect(agents.truncated).toBe(true);
    expect(status.presence.items).toHaveLength(MAX_GATEWAY_ITEMS);
    expect(status.online).toBe(MAX_GATEWAY_ITEMS + 1);
    expect(status.presence.truncated).toBe(true);
  });

  it.each([
    null, [], {}, { items: null }, { items: [null] },
    { items: [{ ...agent, alias: 'bad\nname' }] },
    { items: [{ ...agent, tenant_id: null }] },
    { items: [{ ...agent, enabled: 'true' }] },
    { items: [{ ...agent, online: undefined }] },
    { items: [{ ...agent, deployment_status: 'healthy' }] },
    { items: [{ ...agent, last_heartbeat_at: 'not a date' }] },
  ])('rejects malformed registry responses %#', (value) => {
    expect(() => projectGatewayAgents(value, 'TenantA')).toThrow('gateway_response_invalid');
  });

  it.each([{}, { version: 'untrusted', presence: [] }, { version: '3.0', presence: [{ ...presence, online: null }] }])(
    'rejects malformed status responses %#', (value) => {
      expect(() => projectGatewayStatus(value, 'TenantA')).toThrow('gateway_response_invalid');
    },
  );
});
