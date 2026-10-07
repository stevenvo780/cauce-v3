import { http, HttpResponse } from 'msw';

/** A published PTY inventory that declares exactly these `[tenant, alias]` destinations. */
export function declaredPtyTargets(...agents: [string, string][]) {
  return http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
    observed_at: new Date().toISOString(),
    items: agents.map(([tenant_id, alias]) => ({
      tenant_id, alias, container: 'ws-test', runtime_user: 'dev', harness: 'claude-code', shares_container_with: [],
      modes: ['shell'], writable_modes: ['shell'], pty_state: 'online', last_seen: new Date().toISOString(), authorized: true, reason: 'Destino de prueba.',
    })),
  }));
}
