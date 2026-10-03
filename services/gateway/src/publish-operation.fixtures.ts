import { vi } from 'vitest';
import { buildPublishReceipt, type PublishMessage } from '@cauce/protocol';
import type { PublishOptions } from '@cauce/store';
import { DevOnlyAuthProvider, type Principal } from './auth.js';
import { buildTestGateway, fakePool, fakeRepository } from './test-support/gateway-doubles.js';
import type { PublishOperationInput } from './publish-operation.js';

export const actor: Principal = {
  tenant_id: 'Steven', alias: 'kant', session_id: 'fixture-session', channel: 'console',
  roles: ['operator'], permissions: ['route', 'read'], operator_id: 'fixture@example.invalid',
  operator_profile: { id: 'console:11111111-1111-4111-8111-111111111111', display_name: 'Fixture Human' },
};
export const payload = {
  room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
  body: { text: 'publish operation fixture' }, idempotency_key: 'operation-fixture-key',
  lane: 'interactive', priority: 10,
};
export function input(overrides: Partial<PublishOperationInput> = {}): PublishOperationInput {
  return {
    actor, body: payload, entry: 'direct', authMechanism: 'development',
    logRedaction: vi.fn(), priorityLog: { info: vi.fn(), warn: vi.fn() }, ...overrides,
  };
}
export function fixture(options: { duplicate?: boolean; verify?: boolean } = {}) {
  const calls: { command: PublishMessage; options?: PublishOptions }[] = [];
  const publish = vi.fn(async (command: PublishMessage, publishOptions?: PublishOptions) => {
      calls.push({ command, ...(publishOptions === undefined ? {} : { options: publishOptions }) });
      return buildPublishReceipt(command, {
        message_id: '11111111-1111-4111-8111-111111111111',
        delivery_ids: ['22222222-2222-4222-8222-222222222222'],
        duplicate: options.duplicate ?? false,
        request_id: options.duplicate ? '33333333-3333-4333-8333-333333333333' : command.request_id,
        trace_id: options.duplicate ? 'trace-original' : command.trace_id,
      });
    });
  const verify = vi.fn(async () => options.verify ?? true);
  const repository = fakeRepository({ publish, verifyPublishReceipt: verify });
  return { repository, calls, publish, verify };
}
export async function httpGateway(repository: ReturnType<typeof fakeRepository>) {
  const authProvider = DevOnlyAuthProvider.forTests();
  vi.spyOn(authProvider, 'authenticateHttp').mockResolvedValue(actor);
  return buildTestGateway({ pool: fakePool({ ssl: true }), authProvider, repository });
}
