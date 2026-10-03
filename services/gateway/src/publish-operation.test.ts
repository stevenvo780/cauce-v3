import { describe, expect, it, vi } from 'vitest';
import { AGENT_PRIORITY_CEILING, HUMAN_CHAT_PRIORITY, publishRequestHash } from '@cauce/protocol';
import { StoreError } from '@cauce/store';
import { AuthorizationError } from './auth.js';
import { consoleMessageAuthor } from './console-message-author.js';
import { consolePublishOperatorScope } from './routes/shared.js';
import { publishOperation } from './publish-operation.js';
import { actor, fixture, httpGateway, input, payload } from './publish-operation.fixtures.js';

describe('publish operation without HTTP', () => {
  it.each(['direct', 'console'] as const)('preserves HTTP semantics and options for %s entry', async (entry) => {
    const direct = fixture();
    const receipt = await publishOperation(direct.repository, input({ entry }));
    const routed = fixture();
    const app = await httpGateway(routed.repository);
    try {
      const response = await app.inject({
        method: 'POST', url: entry === 'console' ? '/v3/console/messages' : '/v3/messages',
        headers: { origin: 'http://localhost' }, payload,
      });
      expect(response.statusCode).toBe(202);
      expect(response.json<{ request_hash: string }>().request_hash).toBe(receipt.request_hash);
      expect(routed.calls[0]?.options).toEqual(direct.calls[0]?.options);
      const routedCall = routed.calls[0];
      const directCall = direct.calls[0];
      if (routedCall === undefined || directCall === undefined) throw new Error('missing publish call');
      expect(publishRequestHash(routedCall.command)).toBe(publishRequestHash(directCall.command));
    } finally { await app.close(); }
  });

  it.each([
    ['console', 'interactive', true, HUMAN_CHAT_PRIORITY],
    ['direct', 'interactive', true, AGENT_PRIORITY_CEILING],
    ['console', 'batch', true, AGENT_PRIORITY_CEILING],
    ['console', 'interactive', false, AGENT_PRIORITY_CEILING],
  ] as const)('limits human authority by entry/lane/verified attribution: %s %s %s', async (entry, lane, attributed, expected) => {
    const { operator_id: _operatorId, operator_profile: _profile, ...machine } = actor;
    const { repository, calls } = fixture();
    await publishOperation(repository, input({
      entry, actor: attributed ? actor : machine, body: { ...payload, lane, priority: attributed && entry === 'console' && lane === 'interactive' ? 10 : 100 },
    }));
    expect(calls[0]?.command.priority).toBe(expected);
  });

  it('keeps legacy console scope, author and prepared-intent requirement', async () => {
    const { repository, calls } = fixture();
    await publishOperation(repository, input({ entry: 'console' }));
    expect(calls[0]?.options).toEqual({
      requirePreparedConsoleIntent: true, consoleAuthor: consoleMessageAuthor(actor),
      consoleIntentOperatorScope: consolePublishOperatorScope(actor),
    });
  });

  it('never calls the store without permission or for caller-supplied identity', async () => {
    const { repository, calls } = fixture();
    await expect(publishOperation(repository, input({ actor: { ...actor, permissions: ['read'] } })))
      .rejects.toBeInstanceOf(AuthorizationError);
    for (const identity of [{ tenant_id: 'Pablo' }, { actor_alias: 'other' }, { entry: 'console' }, { authMechanism: 'mtls' }]) {
      await expect(publishOperation(repository, input({ body: { ...payload, ...identity } }))).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });

  it('redacts before semantics/hash/store and logs only redaction metadata', async () => {
    const { repository, calls } = fixture();
    const request = input({ body: { ...payload, body: { text: 'bearer abcdef1234567890XYZ' } } });
    await publishOperation(repository, request);
    expect(JSON.stringify(calls[0]?.command.body)).not.toContain('abcdef1234567890XYZ');
    expect(request.logRedaction).toHaveBeenCalledOnce();
  });

  it('retains agentRoot only for an unprivileged agent', async () => {
    const { operator_id: _operatorId, operator_profile: _profile, ...machine } = actor;
    const { repository, calls } = fixture();
    await publishOperation(repository, input({ actor: { ...machine, roles: ['agent'] } }));
    expect(calls[0]?.options?.agentRoot).toBe(true);
  });

  it('accepts verified idempotent receipts with the original transport pair', async () => {
    const { repository, verify } = fixture({ duplicate: true });
    const receipt = await publishOperation(repository, input());
    expect(receipt.duplicate).toBe(true);
    expect(receipt.trace_id).toBe('trace-original');
    expect(verify).toHaveBeenCalledOnce();
  });

  it('rejects malformed or non-durable receipts with the same conflict errors', async () => {
    const invalid = fixture();
    vi.spyOn(invalid.repository, 'publish').mockResolvedValue({} as never);
    await expect(publishOperation(invalid.repository, input())).rejects.toMatchObject({
      code: 'conflict', message: 'publish did not return an exact durable receipt',
    });
    expect(invalid.verify).not.toHaveBeenCalled();
    const nonDurable = fixture({ verify: false });
    await expect(publishOperation(nonDurable.repository, input())).rejects.toMatchObject({
      code: 'conflict', message: 'publish receipt does not match its durable effect',
    });
  });

  it('requires the exact dedicated mTLS gate identity and canonical probe body', async () => {
    const gateActor = { ...actor, alias: 'gate-probe', session_id: 'gate-probe', channel: 'gate', roles: ['agent'] as const };
    const nonce = '0123456789abcdef0123456789abcdef';
    const gateBody = { ...payload, body: { type: 'system.gate.probe', nonce, timeout_ms: 5_000 },
      priority: -100, idempotency_key: `gate:Steven:jarvis:${nonce}` };
    const { repository, calls } = fixture();
    const gate = input({ actor: gateActor, body: gateBody, authMechanism: 'mtls' });
    await publishOperation(repository, gate);
    expect(calls[0]?.command.actor_alias).toBe('kant');
    expect(calls[0]?.command.authenticated_context).toEqual({ session_id: 'gate-probe', channel: 'gate' });
    expect(calls[0]?.options?.agentRoot).toBeUndefined();
    for (const forged of [
      { ...gate, authMechanism: 'development' },
      { ...gate, actor: { ...gateActor, channel: 'adapter' } },
      { ...gate, actor: { ...gateActor, alias: 'kant' } },
      { ...gate, actor: { ...gateActor, roles: ['agent', 'operator'] as const } },
      { ...gate, body: { ...gateBody, priority: 0 } },
      { ...gate, body: { ...gateBody, idempotency_key: 'forged' } },
    ]) await expect(publishOperation(repository, forged)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('propagates store errors without transport translation or retry', async () => {
    const { repository } = fixture();
    const error = new StoreError('forbidden', 'fixture policy denial');
    const publish = vi.spyOn(repository, 'publish').mockRejectedValue(error);
    await expect(publishOperation(repository, input())).rejects.toBe(error);
    expect(publish).toHaveBeenCalledOnce();
  });
});
