import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Tenant } from '@cauce/protocol';
import { AdapterEngine } from '../../../packages/adapter-sdk/src/sdk/engine.js';
import { DurableStore } from '../../../packages/adapter-sdk/src/sdk/durable-store.js';
import { emissionGateway } from '../../../packages/adapter-sdk/src/sdk/mcp-emission/gateway.js';
import type { EmissionGateway } from '../../../packages/adapter-sdk/src/sdk/mcp-emission/tools.js';
import { HarnessAdapter, fakeDefinition } from '../../../packages/adapter-sdk/src/harnesses/index.js';
import { ControlledRunner, delivery, originless } from '../../../packages/adapter-sdk/test/engine-fixtures.js';
import type { NotificationFixture } from './fixture.js';
import { CONVERSATION } from './fixture.js';

type EngineOptions = ConstructorParameters<typeof AdapterEngine>[0];
type ReceiptSource = EngineOptions extends { egressReceipts?: infer Source } ? Source : unknown;
interface SourceModule {
  HttpEgressReceiptSource: new (gateway: EmissionGateway, identity: { tenant_id: Tenant; alias: string }) => ReceiptSource;
}

export function requireConvergedSource(): void {
  const cwd = fileURLToPath(new URL('../../../', import.meta.url));
  const chain = ['d374e476', '7a435600', '9b96569d', 'HEAD'];
  for (let index = 0; index < chain.length - 1; index++) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', chain[index] ?? '', chain[index + 1] ?? ''],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : String(error);
      throw new Error(`Required notify source chain is unavailable: ${stderr}`);
    }
  }
}

export async function runConsumer(
  httpUrl: string, fixtures: readonly NotificationFixture[],
  options: { tenant?: Tenant; alias?: string; conversation?: string; replyTo?: string; attempt?: number } = {},
): Promise<string> {
  const modulePath = '../../../packages/adapter-sdk/src/sdk/egress-receipt-source.js';
  const loaded: unknown = await import(modulePath);
  if (typeof loaded !== 'object' || loaded === null || !('HttpEgressReceiptSource' in loaded)
    || typeof loaded.HttpEgressReceiptSource !== 'function') throw new Error('Converged HTTP receipt source export is missing.');
  const { HttpEgressReceiptSource } = loaded as SourceModule;
  const directory = await mkdtemp(join(tmpdir(), 'notify-pg-consumer-'));
  const tenant = options.tenant ?? 'Steven';
  const alias = options.alias ?? 'argos';
  let store = await DurableStore.open(directory, { maxInlineTerminalRecords: 1 });
  try {
    await store.activateEpoch(1);
    for (const fixture of fixtures) {
      const input = originless({ ...delivery(fixture.deliveryId, 1, options.attempt ?? fixture.attempt),
        event_id: randomUUID(), message_id: randomUUID(), request_id: randomUUID() }, 'synthetic-originless');
      const accepted = await store.acceptAndEnqueue(input, new Date().toISOString());
      if (!accepted.event) throw new Error('Fixture was not accepted into the local durable store.');
      await store.acknowledge(accepted.event);
      const terminal = await store.transitionAndEnqueue(input.delivery_id, 'done', new Date().toISOString(), {
        output: { reply: null, messages: [], notify: fixture.notifications, status: 'done', retryable: false, artifacts: [] },
      });
      await store.acknowledge(terminal.event);
    }
    store.close(); store = await DurableStore.open(directory);
    const runner = new ControlledRunner();
    const source = new HttpEgressReceiptSource(emissionGateway({ tenant, alias, room: `grp.${tenant.toLowerCase()}`,
      instanceId: 'notify-pg-test', stateDirectory: directory, relayUrl: httpUrl.replace(/^http/u, 'ws'),
      environment: 'test', heartbeatMs: 1000, defaultTimeoutMs: 10000, developmentIdentity: true,
    }), { tenant_id: tenant, alias });
    const engineOptions = { store, harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
      ownTenantId: tenant, executionIntentMode: 'local-test-only' as const,
      publish: async () => undefined, egressReceipts: source };
    const engine = new AdapterEngine(engineOptions);
    const input = { ...delivery(randomUUID()), event_id: randomUUID(), message_id: randomUUID(), request_id: randomUUID() };
    const origin = { adapter: 'telegram', channel: 'telegram', conversation_id: options.conversation ?? CONVERSATION, relay: [],
      metadata: options.replyTo === undefined ? {} : { reply_to: { message_id: options.replyTo } } };
    await engine.handleDelivery({ ...input, tenant_id: tenant, recipient_alias: alias, origin,
      room_id: tenant === 'Jhon' ? 'grp.jhon' : 'grp.steven',
      body: { ...input.body, timeout_ms: 10000 },
      authenticated_context: { session_id: 'notify-pg-human', channel: 'telegram', origin },
    });
    if (runner.calls !== 1) throw new Error('Engine did not invoke the recording harness exactly once.');
    return runner.requests[0]?.stdin ?? '';
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}
