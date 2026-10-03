import { describe, expect, it, vi } from 'vitest';
import { ConsolePublishTelemetry } from './console-publish-telemetry.js';
import { confirmConsolePublishOperation, prepareConsolePublishOperation } from './console-publish-operation.js';
import { actor, fixture, input } from './publish-operation.fixtures.js';
import { consolePublishOperatorScope } from './routes/shared.js';

const nonce = '10000000-0000-4000-8000-000000000001';
const preparedBody = {
  intent_nonce: nonce, room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
  body: { text: 'hello bearer abcdef1234567890XYZ' },
};

describe('shared console journal operations', () => {
  it('binds nonce, redaction, priority and operator scope before the durable reservation', async () => {
    const { repository } = fixture();
    const telemetry = new ConsolePublishTelemetry();
    await prepareConsolePublishOperation(repository, {
      ...input(), body: preparedBody, interactiveHumanEntry: true,
    }, telemetry);
    expect(repository.prepareConsolePublishIntent).toHaveBeenCalledOnce();
    const [command, scope] = vi.mocked(repository.prepareConsolePublishIntent).mock.calls[0] ?? [];
    expect(command).toMatchObject({
      tenant_id: actor.tenant_id, actor_alias: actor.alias, intent_nonce: nonce,
      authenticated_context: { session_id: actor.session_id, channel: actor.channel },
    });
    expect(JSON.stringify(command)).not.toContain('abcdef1234567890XYZ');
    expect(scope).toBe(consolePublishOperatorScope(actor));
    expect(telemetry.snapshot()['prepare:prepared']).toBe(1);
  });

  it('uses a server-selected UUID scope consistently for prepare and confirmation', async () => {
    const { repository } = fixture();
    const telemetry = new ConsolePublishTelemetry();
    const scope = 'a'.repeat(64);
    const prepared = await prepareConsolePublishOperation(repository, {
      ...input(), body: preparedBody, interactiveHumanEntry: true, consoleIntentOperatorScope: scope,
    }, telemetry);
    const confirmation = {
      idempotency_key: prepared.idempotency_key,
      message_id: '20000000-0000-4000-8000-000000000002', causal_hash: 'b'.repeat(64),
    };
    await confirmConsolePublishOperation(repository, { actor, body: confirmation, consoleIntentOperatorScope: scope }, telemetry);
    expect(repository.prepareConsolePublishIntent).toHaveBeenCalledWith(expect.anything(), scope);
    expect(repository.confirmConsolePublishIntent).toHaveBeenCalledWith(actor.tenant_id, actor.alias, scope, confirmation);
    expect(telemetry.snapshot()['confirm:confirmed']).toBe(1);
  });

  it('rejects caller-selected scope and human authority before reserving an intent', async () => {
    const { repository } = fixture();
    const telemetry = new ConsolePublishTelemetry();
    await expect(prepareConsolePublishOperation(repository, {
      ...input(), body: { ...preparedBody, consoleIntentOperatorScope: 'a'.repeat(64), tenant_id: 'Pablo' },
      interactiveHumanEntry: true,
    }, telemetry)).rejects.toThrow();
    expect(repository.prepareConsolePublishIntent).not.toHaveBeenCalled();
    expect(telemetry.snapshot()['prepare:error']).toBe(1);
  });

  it('checks live local route authority before either journal mutation', async () => {
    const { repository } = fixture();
    const telemetry = new ConsolePublishTelemetry();
    const reader = { ...actor, roles: [] as const, permissions: ['read'] as const };
    await expect(prepareConsolePublishOperation(repository, {
      ...input(), actor: reader, body: preparedBody, interactiveHumanEntry: true,
    }, telemetry)).rejects.toThrow('route permission');
    await expect(confirmConsolePublishOperation(repository, { actor: reader, body: {} }, telemetry)).rejects.toThrow('route permission');
    expect(repository.prepareConsolePublishIntent).not.toHaveBeenCalled();
    expect(repository.confirmConsolePublishIntent).not.toHaveBeenCalled();
    expect(telemetry.snapshot()['prepare:error']).toBe(1);
    expect(telemetry.snapshot()['confirm:error']).toBe(1);
  });
});
