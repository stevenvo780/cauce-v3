import { describe, expect, it } from 'vitest';
import { browserDeliveryFailure } from './browser-delivery-diagnostics.js';

const id = '2a780070-006a-4091-9110-6476ed6c03fe';
function input() {
  const calls: { text: string; values: unknown[]; query_timeout: number }[] = [];
  return {
    calls,
    pool: { query: async (config: typeof calls[number]): Promise<{ rows: Record<string, unknown>[] }> => {
      calls.push(config);
      return { rows: [{ delivery_id: id, status: 'pending', attempt: 0, payload: 'FakeSECRET', claim_token: 'FakeSECRET' }] };
    } },
    tenant: { tenant: 'Isa', target: 'agentisa', room: 'isa-room' }, instanceId: 'own-instance',
    selector: { kind: 'text' as const, value: 'FakeSECRET' }, stdout: '', stderr: '', child: undefined,
  };
}

describe('browser failure diagnostics', () => {
  it('preserves assertion identity, SELECT-only own scope and partial admission observations', async () => {
    const fixture = input();
    const cause = new Error('original assertion');
    const result = await browserDeliveryFailure(cause, fixture);
    expect(result.cause).toBe(cause);
    expect(fixture.calls).toHaveLength(6);
    for (const call of fixture.calls) {
      expect(call.text.trim()).toMatch(/^(?:SELECT|WITH) /u);
      expect(call.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|SET)\b/u);
      expect(call.values).toContain(call.text.includes('pg_locks') ? 'agent-context-reconcile:Isa:agentisa' : 'Isa');
      expect(call.query_timeout).toBe(1500);
      const placeholders = new Set([...call.text.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1])));
      expect([...placeholders].sort((a, b) => a - b)).toEqual(call.values.map((_, index) => index + 1));
    }
    expect(result.message).toContain('PARTIAL_OBSERVATIONS_NOT_ADMISSION_PROOF');
    expect(result.message).toContain('"status":"pending","attempt":0');
    expect(result.message).not.toContain('FakeSECRET');
  });

  it('filters structured SDK events without emitting prompts, error messages or arbitrary codes', async () => {
    const fixture = input();
    fixture.stderr = [
      'FakeSECRET',
      JSON.stringify({ event: 'profile_seed', alias: 'agentisa', reason: 'FakeSECRET', profile: 'FakeSECRET' }),
      JSON.stringify({ event: 'internal_error', delivery_id: id, attempt: 1, error_code: 'ECONNRESET', error_message: 'FakeSECRET' }),
      JSON.stringify({ event: 'FakeSECRET', alias: 'agentisa' }),
      JSON.stringify({ event: 'exit', error_code: 'FakeSECRET', alias: 'foreign-secret' }),
    ].join('\n');
    const result = await browserDeliveryFailure(new Error('assertion'), fixture);
    expect(result.message).toContain('"event":"profile_seed","alias":"agentisa"');
    expect(result.message).toContain('"error_code":"ECONNRESET"');
    expect(result.message).toContain('"error_code":"UNKNOWN"');
    expect(result.message).not.toContain('FakeSECRET');
    expect(result.message).not.toContain('foreign-secret');
  });

  it('keeps SQL diagnostic errors UNKNOWN without replacing or logging the original cause', async () => {
    const fixture = input();
    fixture.pool.query = async () => { throw Object.assign(new Error('FakeSECRET'), { code: '55P03' }); };
    const cause = new Error('assertion');
    const result = await browserDeliveryFailure(cause, fixture);
    expect(result.cause).toBe(cause);
    expect(result.message).toContain('"status":"UNKNOWN","errorCode":"55P03"');
    expect(result.message).not.toContain('FakeSECRET');
    expect(result.message).toContain('"child":{"status":"UNKNOWN"}');
  });

  it('records child exit fields without treating killed or a missing exit as liveness evidence', async () => {
    const result = await browserDeliveryFailure(new Error('assertion'), {
      ...input(), child: { pid: 123, exitCode: null, signalCode: 'SIGTERM', killed: true },
    });
    expect(result.message).toContain('"pid":123,"exitCode":null,"signalCode":"SIGTERM","killed":true');
    expect(result.message).toContain('EXIT_FIELDS_ONLY_NOT_LIVENESS_PROOF');
  });

  it('bounds retained rows and events and rejects malformed structured input', async () => {
    const fixture = input();
    fixture.pool.query = async () => ({ rows: Array.from({ length: 20 }, () => ({ status: 'pending' })) });
    fixture.stdout = Array.from({ length: 20 }, () => JSON.stringify({ event: 'spawn' })).join('\n');
    fixture.stderr = '{"event":';
    const result = await browserDeliveryFailure(new Error('assertion'), fixture);
    const parsed = JSON.parse(result.message.split('diagnostic=')[1] ?? '') as {
      sql: Record<string, { rows: unknown[] }>; sdk: { stdout: unknown[]; stderr: unknown[] };
    };
    expect(Object.values(parsed.sql).every((value) => value.rows.length === 8)).toBe(true);
    expect(parsed.sdk.stdout).toHaveLength(16);
    expect(parsed.sdk.stderr).toEqual([]);
  });

  it('preserves SDK liveness reasons, lifecycle phases and frame rejection codes without free text', async () => {
    const fixture = input();
    const timestamp = '2026-10-06T10:00:00.000Z';
    fixture.stderr = [
      ...['HELLO_ACK_TIMEOUT', 'HEARTBEAT_ACK_TIMEOUT', 'CONNECTION_LEASE_EXPIRED'].map((reason) =>
        JSON.stringify({ event: 'connection_error', timestamp, reason, error_message: 'FakeSECRET' })),
      JSON.stringify({ event: 'connection_degraded', ts: timestamp, reason: 'PROFILE_SEED_FAILED' }),
      JSON.stringify({ event: 'delivery_start', timestamp, delivery_id: id, attempt: 1 }),
      JSON.stringify({ event: 'delivery_state', timestamp, delivery_id: id, phase: 'accepted' }),
      JSON.stringify({ event: 'delivery_end', timestamp, delivery_id: id, phase: 'failed', error_code: 'EXECUTION_INTENT_CONFIRMATION_FAILED' }),
      JSON.stringify({ event: 'inbound_frame_invalid', timestamp, reason: 'frame_dropped', error_code: 'INBOUND_FRAME_SCHEMA' }),
      JSON.stringify({ event: 'outbound_frame_invalid', timestamp, reason: 'outbox_entry_quarantined', error_code: 'OUTBOX_ENTRY_QUARANTINED' }),
      JSON.stringify({ event: 'connection_error', timestamp: 'FakeSECRET', ts: 'FakeSECRET', reason: 'HELLO_ACK_TIMEOUT FakeSECRET', error_code: 'FakeSECRET' }),
    ].join('\n');
    const result = await browserDeliveryFailure(new Error('assertion'), fixture);
    const parsed = JSON.parse(result.message.split('diagnostic=')[1] ?? '') as { sdk: { stderr: Record<string, unknown>[] } };
    expect(parsed.sdk.stderr).toHaveLength(10);
    for (const reason of ['HELLO_ACK_TIMEOUT', 'HEARTBEAT_ACK_TIMEOUT', 'CONNECTION_LEASE_EXPIRED', 'PROFILE_SEED_FAILED', 'frame_dropped', 'outbox_entry_quarantined']) {
      expect(parsed.sdk.stderr.some((event) => event.reason === reason)).toBe(true);
    }
    expect(parsed.sdk.stderr[0]?.timestamp).toBe(timestamp);
    expect(parsed.sdk.stderr[3]?.ts).toBe(timestamp);
    expect(parsed.sdk.stderr[5]?.phase).toBe('accepted');
    expect(parsed.sdk.stderr[6]?.error_code).toBe('EXECUTION_INTENT_CONFIRMATION_FAILED');
    expect(parsed.sdk.stderr[7]?.error_code).toBe('INBOUND_FRAME_SCHEMA');
    expect(parsed.sdk.stderr[8]?.error_code).toBe('OUTBOX_ENTRY_QUARANTINED');
    expect(parsed.sdk.stderr[9]).toEqual({ event: 'connection_error', reason: 'UNKNOWN', error_code: 'UNKNOWN' });
    expect(result.message).not.toContain('FakeSECRET');
  });

  it('retains literal attachment, context and harness failures without permitting arbitrary error text', async () => {
    const fixture = input();
    const codes = ['INVALID_ATTACHMENT', 'INVALID_DELIVERY', 'EXECUTION_FAILED', 'SHARED_TUI_UNAVAILABLE',
      'NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED', 'UNSUPPORTED_HUMAN_ISOLATION', 'MUSE_PROTOCOL_FAILED',
      'MUSE_MCP_UNAVAILABLE', 'MUSE_OUTPUT_TRUNCATED'];
    fixture.stderr = [...codes.map((error_code) => JSON.stringify({ event: 'delivery_end', phase: 'failed', error_code })),
      JSON.stringify({ event: 'delivery_end', phase: 'failed', error_code: 'INVALID_ATTACHMENT FakeSECRET' }),
    ].join('\n');
    const result = await browserDeliveryFailure(new Error('assertion'), fixture);
    const parsed = JSON.parse(result.message.split('diagnostic=')[1] ?? '') as { sdk: { stderr: Record<string, unknown>[] } };
    expect(parsed.sdk.stderr.map((event) => event.error_code)).toEqual([...codes, 'UNKNOWN']);
    expect(result.message).not.toContain('FakeSECRET');
  });

});
