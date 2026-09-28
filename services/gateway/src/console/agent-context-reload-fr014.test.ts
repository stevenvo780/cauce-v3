import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import type { buildGateway } from '../app.js';
import { DevOnlyAuthProvider } from '../auth.js';
import { buildTestGateway, fakeRepository } from '../test-support/gateway-doubles.js';

/**
 * FR-014: an alias re-materializes its OWN context with its own certificate (accepted by
 * owner decision). The route mechanics already have unit coverage with stubbed gates; what
 * this file proves is the production wiring through a real gateway: the tenant-less form is
 * mounted, a certificate-bound alias identity (agent role, no operator, no attribution) passes
 * every gate with `read` alone, and the same form refuses anybody else.
 *
 * The scripted pool holds no saved profile, so the accepted call lands on `profile_absent`: a
 * post-gate outcome ("nothing saved yet") that still proves the gate decision was accept. A
 * rejection at the gate would be 403 `self_reload_only` / `writable_requires_attribution`.
 */

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

interface AuditCapture {
  readonly tenant_id: string;
  readonly actor_alias: string;
  readonly action: string;
  readonly decision: string;
  readonly metadata: Record<string, unknown>;
}

/** Empty durable state that still records every audit row the reload writes. */
function scriptedPool(audits: AuditCapture[]): DatabasePool {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    const text = String(sql);
    if (text.includes('INSERT INTO audit_events')) {
      const [tenant_id, actor_alias, action, decision, _trace, metadata] = params as [
        string, string, string, string, unknown, string,
      ];
      audits.push({
        tenant_id,
        actor_alias,
        action,
        decision,
        metadata: JSON.parse(metadata) as Record<string, unknown>,
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query } as unknown as DatabasePool;
}

async function gateway(audits: AuditCapture[], readOnly = false) {
  const app = await buildTestGateway({
    pool: scriptedPool(audits),
    authProvider: DevOnlyAuthProvider.forTests(readOnly
      ? { roles: ['agent'], permissions: ['read'] }
      : {}),
    repository: fakeRepository(),
  });
  apps.push(app);
  return app;
}

function headers(alias: string): Record<string, string> {
  return {
    'x-cauce-tenant': 'Steven',
    'x-cauce-alias': alias,
    // The console surface sits behind the same-origin hook, whatever the principal.
    origin: 'http://localhost',
  };
}

describe('FR-014: el alias recarga su propio contexto con su certificado', () => {
  it('accepts the alias itself with no operator, no attribution and no reason', async () => {
    const audits: AuditCapture[] = [];
    const app = await gateway(audits);
    // `argos` authenticates as a plain agent: roles ['agent'], permissions route+read, the same
    // shape an mTLS alias certificate yields. No operator role, no control, no operator_id.
    const response = await app.inject({
      method: 'POST', url: '/v3/console/agents/argos/context/reload', headers: headers('argos'),
    });

    // Past every gate: the 409 is the post-gate "no saved profile to re-materialize", not a
    // 403 self_reload_only and not a 403 writable_requires_attribution.
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('profile_absent');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenant_id: 'Steven',
      actor_alias: 'argos',
      metadata: {
        principal: 'alias_self',
        attributed: false,
        operator_id: null,
        operator_reason: null,
        reason: 'profile_absent',
      },
    });
  });

  it('needs only the read permission: the alias is repairing its own files', async () => {
    const audits: AuditCapture[] = [];
    const app = await gateway(audits, true);
    const response = await app.inject({
      method: 'POST', url: '/v3/console/agents/argos/context/reload', headers: headers('argos'),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('profile_absent');
    expect(audits[0]?.metadata.principal).toBe('alias_self');
  });

  it('refuses one alias healing another through the tenant-less form', async () => {
    const audits: AuditCapture[] = [];
    const app = await gateway(audits);
    const response = await app.inject({
      method: 'POST', url: '/v3/console/agents/argos/context/reload', headers: headers('zeus'),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden', reason: 'self_reload_only' });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenant_id: 'Steven',
      actor_alias: 'zeus',
      action: 'agent_document.denied',
      decision: 'deny',
      metadata: { principal: 'alias_self', reason: 'self_reload_only' },
    });
  });

  it('refuses a body: the self-heal call carries nothing to interpret', async () => {
    const audits: AuditCapture[] = [];
    const app = await gateway(audits);
    const response = await app.inject({
      method: 'POST',
      url: '/v3/console/agents/argos/context/reload',
      headers: headers('argos'),
      payload: { reason: 'no hay nada que interpretar aquí' },
    });

    expect(response.statusCode).toBe(400);
    expect(audits).toEqual([]);
  });
});
