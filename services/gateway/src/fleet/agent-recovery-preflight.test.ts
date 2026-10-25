import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@cauce/store';
import { FleetErrorSchema } from '@cauce/protocol';
import { FleetRecoveryPreviewSchema } from '@cauce/protocol/fleet-recovery';
import { RecoveryPreflightBroker, RecoveryPreflightEventSchema, RecoveryPreflightPayloadSchema } from './agent-recovery-preflight.js';
import { fleetExecutionFailure } from './recovery-host-command.js';
import * as recoveryCommands from './recovery-host-command.js';
import { AgentProviderAuthHost } from './agent-provider-auth-host.js';
import type { QuotaHostChannel } from './quota-executor.js';

const target = { tenant_id: 'Steven', alias: 'one', runtime_key: 'physical-one' };
const payload = { ...target, agent: { ...target, host_id: 'north', company_id: 'company-one' }, trusted_accounts: [] };
const host = { host_id: 'north', company_id: 'company-one' };
const client = {} as DatabaseClient;
const result = { status: 'update_required' as const, reason_code: 'runtime_mounts_differ' as const,
  reason: 'Actualiza la ejecución para aplicar la política vigente.', next_action: 'update' as const };
const brokers: RecoveryPreflightBroker[] = [];
function broker() { const value = new RecoveryPreflightBroker(); brokers.push(value); return value; }
afterEach(() => { vi.restoreAllMocks(); for (const value of brokers.splice(0)) value.shutdown(); });

describe('read-only recovery preflight', () => {
  it('rejects operation authority, private hints and inconsistent target coordinates', () => {
    expect(RecoveryPreflightPayloadSchema.parse(payload)).toEqual(payload);
    for (const value of [{ ...payload, operation_id: '71000000-0000-4000-8000-000000000001' },
      { ...payload, agent: { ...payload.agent, alias: 'foreign' } }, { ...payload, agent: { ...payload.agent, _placement: {} } }]) {
      expect(RecoveryPreflightPayloadSchema.safeParse(value).success).toBe(false);
    }
  });
  it('uses the signed host exchange and resolves only after the enclosing transaction accepts', async () => {
    const value = broker(); const verify = vi.fn(async () => undefined); let settled = false;
    const waiting = value.request(host, payload, verify, new AbortController().signal).then(reply => { settled = true; return reply; });
    const first = await value.exchange(client, host, []);
    expect(first.commands).toHaveLength(1); const command = first.commands[0];
    if (!command) throw new Error('Preflight command absent');
    expect(command.payload).toEqual(payload); expect(command).not.toHaveProperty('operation_id'); expect(command).not.toHaveProperty('fence');
    const reply = await value.exchange(client, host, [{ id: command.id, target, ok: true, result }]);
    expect(settled).toBe(false); expect(reply.commands).toEqual([]);
    reply.accept(); expect(await waiting).toEqual(result); expect(verify).toHaveBeenCalledTimes(2);
  });
  it('rejects another company, host, agent, runtime or duplicate response before accepting any result', async () => {
    const value = broker(); const waiting = value.request(host, payload, async () => undefined, new AbortController().signal);
    const command = (await value.exchange(client, host, [])).commands[0];
    if (!command) throw new Error('Preflight command absent');
    const event = { id: command.id, target, ok: true as const, result };
    for (const foreign of [{ ...host, company_id: 'foreign-company' }, { ...host, host_id: 'south' }]) {
      await expect(value.exchange(client, foreign, [event])).rejects.toThrow();
    }
    for (const foreign of [{ ...target, tenant_id: 'Other' }, { ...target, alias: 'other' }, { ...target, runtime_key: 'other-key' }]) {
      await expect(value.exchange(client, host, [{ ...event, target: foreign }])).rejects.toThrow();
    }
    await expect(value.exchange(client, host, [event, event])).rejects.toThrow();
    (await value.exchange(client, host, [event])).accept(); expect(await waiting).toEqual(result);
  });
  it('rechecks current authority before dispatch and rejects an aborted request', async () => {
    const value = broker(); const verify = vi.fn(async () => { throw new Error('Revoked'); });
    const waiting = value.request(host, payload, verify, new AbortController().signal);
    const rejected = expect(waiting).rejects.toThrow();
    const exchange = await value.exchange(client, host, []); expect(exchange.commands).toEqual([]); exchange.accept(); await rejected;
    const abort = new AbortController(); const pending = value.request(host, payload, async () => undefined, abort.signal);
    const cancelled = expect(pending).rejects.toThrow(); abort.abort(); await cancelled;
    expect((await value.exchange(client, host, [])).commands).toEqual([]);
  });
  it('keeps the result union strict and legacy persisted failures compatible', () => {
    const base = { tenant_id: 'Steven', alias: 'one', transport: 'fleet', expected_revision: 0, in_flight: 0 };
    expect(FleetRecoveryPreviewSchema.parse({ ...base, ...result })).toMatchObject(result);
    expect(FleetRecoveryPreviewSchema.safeParse({ ...base, ...result, next_action: 'stop_start' }).success).toBe(false);
    expect(RecoveryPreflightEventSchema.safeParse({ id: crypto.randomUUID(), target, ok: true, result: { ...result, stderr: 'PRIVATE' } }).success).toBe(false);
    const legacy = { code: 'STEP_FAILED', step: 'runtime', retryable: true };
    expect(FleetErrorSchema.parse(legacy)).toEqual(legacy);
    expect(FleetErrorSchema.parse({ ...legacy, reason: 'runtime_mounts_differ' }).reason).toBe('runtime_mounts_differ');
    expect(FleetErrorSchema.safeParse({ ...legacy, reason: 'PRIVATE' }).success).toBe(false);
  });
  it('accepts one complete allowlisted failure marker and keeps arbitrary or truncated diagnostics private', () => {
    expect(fleetExecutionFailure('private text\nCAUCE_RECOVERY_FAILURE=runtime_mounts_differ\n')?.reason).toBe('runtime_mounts_differ');
    for (const raw of ['CAUCE_RECOVERY_FAILURE=runtime_mounts_differ', 'CAUCE_RECOVERY_FAILURE=runtime_mounts_differ PRIVATE\n',
      'CAUCE_RECOVERY_FAILURE=runtime_mounts_differ\nCAUCE_RECOVERY_FAILURE=shared_tui_disabled\n',
      'x'.repeat(4097) + '\nCAUCE_RECOVERY_FAILURE=runtime_mounts_differ\n']) expect(fleetExecutionFailure(raw)).toBeUndefined();
  });
  it('runs recovery and reconciliation without a provider-login policy while refusing login commands', async () => {
    const id = randomUUID(); const authId = randomUUID(); const events: Record<string, unknown>[] = [];
    let observed!: () => void; const received = new Promise<void>(resolve => { observed = resolve; }); let sent = false;
    const helper = vi.spyOn(recoveryCommands, 'recoveryHostPreflight').mockResolvedValue(result);
    const channel: QuotaHostChannel = { request: async (_method, _path, body) => {
      events.push(body);
      if (body.action === 'reconcile') return { cursor: null, inspections: [] };
      if (body.action !== 'exchange') throw new Error('Login context must not be requested without a policy');
      if (body.recovery_results !== undefined) observed();
      if (sent) return { commands: [], active_sessions: [] };
      sent = true;
      return { commands: [{ fence: { operation_id: randomUUID(), session_id: randomUUID(), operation_epoch: 1,
        prepared_revision: 1, scope_sha256: 'a'.repeat(64), expires_at: new Date(Date.now() + 20_000).toISOString() }, command: { id: authId, type: 'open' } }],
      active_sessions: [], recovery_previews: [{ id, expires_at: Date.now() + 20_000, payload }] };
    } };
    const runtime = new AgentProviderAuthHost(channel, { hostConfig: { host: host.host_id,
      command: { python: '/usr/bin/python3', executable: '/executor.py', policyFile: '/executor-policy.json' } },
    projectRoot: '/', companyId: host.company_id });
    try {
      runtime.start(); await received;
      expect(helper).toHaveBeenCalledOnce();
      expect(events.some(event => event.action === 'reconcile')).toBe(true);
      const exchange = events.find(event => event.recovery_results !== undefined);
      expect(exchange).toMatchObject({ recovery_results: [{ id, target, ok: true, result }],
        events: [{ id: authId, ok: false, error: 'HOST_UNAVAILABLE' }] });
      expect(events.some(event => event.action === 'context')).toBe(false);
    } finally { await runtime.shutdown(); }
  });
});
