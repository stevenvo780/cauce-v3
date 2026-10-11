import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { HarnessAdapter, fakeDefinition } from '../src/harnesses/index.js';
import { DurableStore } from '../src/sdk/durable-store.js';
import { AdapterEngine } from '../src/sdk/engine.js';
import type {
  AdapterLog, CommandRunRequest, CommandRunResult, CommandRunner, Delivery, DeliveryEvent,
} from '../src/sdk/types.js';
import { testStateRoot } from "./test-state.js";
import { HUMANIZAR_MEMBER } from "./company-context-fixtures.js";

const root = testStateRoot();

class ForbiddenRunner implements CommandRunner {
  calls = 0;

  async run(_request: CommandRunRequest): Promise<CommandRunResult> {
    this.calls += 1;
    throw new Error('system gate probe must never invoke the harness/model');
  }
}

class CountingHarness extends HarnessAdapter {
  reservations = 0;

  override reserveSession(...arguments_: Parameters<HarnessAdapter['reserveSession']>) {
    this.reservations += 1;
    return super.reserveSession(...arguments_);
  }
}

function probeDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    type: 'delivery',
    version: '3.0',
    delivery_id: '10000000-0000-4000-8000-000000000001',
    event_id: '20000000-0000-4000-8000-000000000001',
    message_id: '30000000-0000-4000-8000-000000000001',
    request_id: '40000000-0000-4000-8000-000000000001',
    trace_id: 'gate-probe-test',
    epoch: 7,
    attempt: 2,
    claim_token: '50000000-0000-4000-8000-000000000001',
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipient_alias: 'kant',
    company_context: HUMANIZAR_MEMBER,
    authenticated_context: { session_id: 'gate-probe', channel: 'gate' },
    body: {
      type: 'system.gate.probe',
      nonce: '0123456789abcdef0123456789abcdef',
      timeout_ms: 5_000,
    },
    ...overrides,
  };
}

async function setup(name: string) {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  const store = await DurableStore.open(directory);
  const runner = new ForbiddenRunner();
  const harness = new CountingHarness({ definition: fakeDefinition, runner, store });
  const events: DeliveryEvent[] = [];
  const logs: AdapterLog[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness,
    publish: async (event) => { events.push(event); },
    logger: (entry) => { logs.push(entry); },
  });
  await engine.activateEpoch(7);
  return { directory, store, runner, harness, events, logs, engine };
}

test('system.gate.probe ACKs the real claim without model, session, reply, messages or durable request', async () => {
  const context = await setup('gate-probe-valid');
  try {
    const delivery = probeDelivery();
    await context.engine.handleDelivery(delivery);

    assert.equal(context.runner.calls, 0);
    assert.equal(context.harness.reservations, 0);
    assert.deepEqual(context.events.map((event) => event.phase), ['accepted', 'done']);
    const terminal = context.events[1];
    assert.ok(terminal, "no terminal event captured");
    assert.deepEqual(
      { attempt: terminal.attempt, claim_token: terminal.claim_token, epoch: terminal.epoch },
      { attempt: delivery.attempt, claim_token: delivery.claim_token, epoch: delivery.epoch },
    );
    assert.deepEqual(terminal.output, {
      reply: null, messages: [], notify: [], status: 'done', retryable: false, artifacts: [],
    });
    const durable = context.store.getDelivery(delivery.delivery_id);
    assert.equal(durable?.state, 'done');
    assert.equal(durable.request, undefined);
    assert.deepEqual(durable.output, terminal.output);
    assert.deepEqual(context.logs, [], 'reserved probes must not print body or identifiers');
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test('system.gate.probe is fail-closed when any trusted authority field differs', async () => {
  const context = await setup('gate-probe-denied');
  try {
    await context.engine.handleDelivery(probeDelivery({ actor_alias: 'quota-collector' }));
    assert.equal(context.runner.calls, 0);
    assert.equal(context.harness.reservations, 0);
    assert.deepEqual(context.events.map((event) => event.phase), ['accepted', 'failed']);
    assert.equal(context.events[1]?.error?.code, 'UNAUTHORIZED_GATE_PROBE');
    assert.equal(context.store.getDelivery('10000000-0000-4000-8000-000000000001')?.request, undefined);
    assert.deepEqual(context.logs, []);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test('system.gate.probe needs the company principal as data and matches it field by field', async () => {
  const context = await setup('gate-probe-data');
  try {
    const { company_context: _absent, ...withoutCompany } = probeDelivery();
    const forged = [
      withoutCompany,
      probeDelivery({ tenant_id: 'Miguel' }),
      probeDelivery({ room_id: 'grp.miguel' }),
      probeDelivery({ authenticated_context: { session_id: 'other-principal', channel: 'gate' } }),
      probeDelivery({ company_context: { company_id: 'other', gate_probe: {
        tenant_id: 'Hospital', room_id: 'grp.hospital', actor_alias: 'operador', principal_alias: 'gate-probe',
      } } }),
    ];
    for (const [index, delivery] of forged.entries()) {
      const unique = {
        ...delivery,
        delivery_id: `10000000-0000-4000-8000-00000000010${String(index)}`,
        event_id: `20000000-0000-4000-8000-00000000010${String(index)}`,
        message_id: `30000000-0000-4000-8000-00000000010${String(index)}`,
        request_id: `40000000-0000-4000-8000-00000000010${String(index)}`,
      } satisfies Delivery;
      await context.engine.handleDelivery(unique);
    }
    assert.equal(context.runner.calls, 0);
    assert.deepEqual(
      context.events.filter((event) => event.phase === 'failed').map((event) => event.error?.code),
      Array<string>(forged.length).fill('UNAUTHORIZED_GATE_PROBE'),
    );
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});
