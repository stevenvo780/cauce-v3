import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AckSchema, HumanMessageInitiatorSchema } from '@cauce/protocol';
import type { ClaimedDeliveryEnvelope } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { createHumanGatewayAuthorization } from '../../packages/mcp-fleet-monitor/src/gateway-http.js';
import { AdapterEngine } from '../../packages/adapter-sdk/src/sdk/engine.js';
import { DurableStore } from '../../packages/adapter-sdk/src/sdk/durable-store.js';
import { deliveryHarnesses } from '../../packages/adapter-sdk/src/bin/shared.js';
import { claudeDefinition } from '../../packages/adapter-sdk/src/harnesses/claude.js';
import { humanHarnessSelector, sessionFromDelivery } from '../../packages/adapter-sdk/src/sdk/engine/delivery-context.js';
import type { CommandRunner, CommandRunRequest, Delivery, DeliveryEvent } from '../../packages/adapter-sdk/src/sdk/types.js';
import {
  connectSdkClient, startHumanOperationsFixture, startHttpsForwarder, trustFixtureCa,
  type HumanMcpClient,
} from './mcp-human-operations.fixtures.js';

export function content(result: { readonly content: readonly { type: string; text?: string }[] }): Record<string, unknown> {
  const text = result.content.find((part) => part.type === 'text')?.text;
  if (text === undefined) throw new Error('Missing MCP tool content');
  return object(JSON.parse(text));
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}

function deliveryContext(request: CommandRunRequest): Record<string, unknown> {
  const start = '--- BEGIN TRUSTED DELIVERY CONTEXT ---\n';
  const end = '\n--- END TRUSTED DELIVERY CONTEXT ---';
  const offset = request.stdin.indexOf(start);
  const limit = request.stdin.indexOf(end, offset + start.length);
  if (offset < 0 || limit < 0) throw new Error('Harness prompt omitted trusted delivery context');
  return object(JSON.parse(request.stdin.slice(offset + start.length, limit)));
}

export type HumanEngineFixture = Awaited<ReturnType<typeof startHumanEngineFixture>>;

export async function startHumanEngineFixture() {
  const fixture = await startHumanOperationsFixture();
  const clients: HumanMcpClient[] = [];
  let directory: string | undefined;
  let restoreTrust: (() => void) | undefined;
  let forwarder: Awaited<ReturnType<typeof startHttpsForwarder>> | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let engine: AdapterEngine | undefined;
  let acceptedRelease: (() => void) | undefined;
  let runnerRelease: (() => void) | undefined;
  const work = new Set<Promise<void>>();
  const close = async () => {
    engine?.stop(); acceptedRelease?.(); runnerRelease?.();
    await Promise.allSettled(work);
    const failures: unknown[] = [];
    for (const cleanup of [
      ...clients.splice(0).map((client) => async () => { await client.close(); }),
      async () => { await app?.close(); },
      async () => { await forwarder?.close(); },
      async () => { restoreTrust?.(); },
      async () => { await fixture.close(); },
      async () => { if (directory !== undefined) await rm(directory, { recursive: true, force: true }); },
    ]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Human Engine fixture cleanup failed');
  };
  try {
    directory = await mkdtemp(join(tmpdir(), 'mcp-eng-'));
    console.info(`Owned Engine directory: ${directory}`);
    console.info(`Owned PostgreSQL container: ${fixture.database.container.getId()}`);
    const resources = await promisify(execFile)('docker', ['inspect', fixture.database.container.getId(),
      '--format', '{{json .Mounts}} {{json .NetworkSettings.Ports}}'], { timeout: 5000 });
    console.info(`Owned PostgreSQL mounts/ports: ${resources.stdout.trim()}`);
    restoreTrust = await trustFixtureCa(fixture.issuer.ca);
    forwarder = await startHttpsForwarder(fixture.issuer.tlsKey, fixture.issuer.tlsCertificate, '127.0.0.1');
    const origin = forwarder.origin;
    app = await buildGateway({ pool: fixture.pool, authProvider: DevOnlyAuthProvider.forTests(),
      humanMcp: { publicOrigin: origin, authorization: createHumanGatewayAuthorization(origin,
        { issuer: fixture.issuer.issuer, jwksUri: fixture.issuer.jwksUri }) } });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    forwarder.setTarget(Number(new URL(address).port));
    const requests: { request: CommandRunRequest; humanId: string; channel: unknown }[] = [];
    const events: DeliveryEvent[] = [];
    const selections: { dedicated: boolean; sessionKey?: string }[] = [];
    let manualCalls = 0;
    const manual: CommandRunner = { run: async () => {
      manualCalls += 1;
      throw new Error('Authenticated MCP human entered manual/shared harness');
    } };
    const headless: CommandRunner = { run: async (request) => {
      const context = deliveryContext(request);
      const human = HumanMessageInitiatorSchema.parse(context.human_initiator);
      if (!fixture.accounts.some((account) => account.id === human.human_id && account.tenant === human.tenant_id)) {
        throw new Error('Harness identity did not originate from a bound server account');
      }
      requests.push({ request, humanId: human.human_id, channel: context.channel });
      request.onHarnessStart?.();
      await new Promise<void>((resolve) => {
        runnerRelease = resolve;
        request.signal.addEventListener('abort', () => { resolve(); }, { once: true });
        if (request.signal.aborted) resolve();
      });
      return { stdout: JSON.stringify({ result: JSON.stringify({ reply: `owned Engine reply ${human.human_id}`,
        messages: [], status: 'done', retryable: false, artifacts: [] }) }), stderr: '', exitCode: 0,
        signal: null, cancelled: false, timedOut: false, harnessStarted: true };
    } };
    const store = await DurableStore.open(directory);
    const target = 'mcp_target_steven';
    const instance = `mcp-engine-${randomUUID()}`;
    const adapters = deliveryHarnesses({ definition: claudeDefinition, runner: manual, store,
      sessionNamespace: target, sharedSession: { alias: target, harness: 'claude', stateDirectory: directory } }, headless);
    const select = humanHarnessSelector(adapters.harness, adapters.humanHarness);
    engine = new AdapterEngine({ store, harness: adapters.harness, ownTenantId: 'Steven',
      harnessForDelivery: (delivery) => {
        const selected = select(delivery);
        const sessionKey = sessionFromDelivery(delivery, 'Steven').sessionKey;
        selections.push({ dedicated: selected === adapters.humanHarness,
          ...(sessionKey === undefined ? {} : { sessionKey }) });
        return selected;
      }, executionIntentMode: 'local-test-only', publish: async (event) => {
        const ack = AckSchema.parse({ event_id: event.event_id, instance_id: instance, epoch: event.epoch,
          attempt: event.attempt, claim_token: event.claim_token, status: event.phase,
          ...(event.execution_started === true ? { execution_started: true } : {}),
          ...(event.output === undefined ? {} : { result: { output: event.output } }),
          ...(event.error === undefined ? {} : { error: event.error.message, error_code: event.error.code,
            retryable: event.error.retryable }) });
        const result = await fixture.repository.ackDelivery(event.delivery_id, 'Steven', target, ack);
        if (!result.applied) throw new Error('Engine lifecycle ACK did not apply');
        events.push(event);
        if (event.phase === 'accepted') await new Promise<void>((resolve) => { acceptedRelease = resolve; });
      } });
    const activeEngine = engine;
    return { ...fixture, target, instance, requests, events, selections,
      async connect(subject: string) {
        const token = await fixture.issuer.issue(subject, ['cauce.read', 'cauce.publish'], `${origin}/mcp`);
        const client = await connectSdkClient(origin, token); clients.push(client); return client;
      },
      call: (client: HumanMcpClient, name: string, args: Readonly<Record<string, unknown>>) =>
        client.callTool({ name, arguments: args }),
      async lease(capabilities: string[]) {
        const result = await fixture.repository.acquireLease('Steven', target, instance, capabilities, 60_000);
        if (!result.acquired || result.epoch === undefined) throw new Error('Recipient lease was not acquired');
        return result.epoch;
      },
      activate: (epoch: number) => activeEngine.activateEpoch(epoch),
      run: (claim: ClaimedDeliveryEnvelope) => {
        if (claim.authenticated_context === undefined) throw new Error('Missing canonical authentication context');
        const delivery: Delivery = { ...claim, authenticated_context: {
          session_id: claim.authenticated_context.session_id, channel: claim.authenticated_context.channel,
          ...(claim.authenticated_context.origin === undefined ? {} : { origin: claim.authenticated_context.origin }),
        } };
        const task = activeEngine.handleDelivery(delivery); work.add(task); return task;
      },
      advanceAccepted: () => { if (!acceptedRelease) throw new Error('No accepted barrier'); acceptedRelease(); acceptedRelease = undefined; },
      finishTurn: () => { if (!runnerRelease) throw new Error('No runner barrier'); runnerRelease(); runnerRelease = undefined; },
      manualInvocations: () => manualCalls,
      close,
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Human Engine setup failed'); }
    throw error;
  }
}
