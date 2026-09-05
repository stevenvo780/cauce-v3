import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { systemClock } from '../src/sdk/backoff.js';
import {
  ConnectionLiveness,
  MAX_NODE_TIMER_DELAY_MS,
  connectionTimeouts,
  raceWithDeadline,
} from '../src/sdk/connection-liveness.js';
import { AdapterError } from '../src/sdk/errors.js';
import type {
  AdapterConfig,
  ClientFrame,
  ConsumerConnection,
  ConsumerConnector,
  ServerFrame,
} from '../src/sdk/types.js';
import {
  FakeConnection,
  SequenceConnector,
  VirtualClock,
  makeClient,
  waitUntil,
} from './client-fixtures.js';

async function eventLoopTurn(): Promise<void> {
  await new Promise<void>((resolveWait) => { setImmediate(resolveWait); });
}

async function advance(clock: VirtualClock, ms: number): Promise<void> {
  clock.advance(ms);
  await eventLoopTurn();
}

async function settlesWithin(operation: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<boolean>((resolveWait) => {
        timer = setTimeout(() => { resolveWait(false); }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class TrackingConnection extends FakeConnection {
  closeCalls = 0;

  override async close(): Promise<void> {
    this.closeCalls += 1;
    await super.close();
  }
}

class HangingCloseConnection extends TrackingConnection {
  override async close(): Promise<void> {
    this.closeCalls += 1;
    await new Promise<void>(() => undefined);
  }
}

class SilentHelloConnection extends TrackingConnection {
  override async send(frame: ClientFrame): Promise<void> {
    this.sent.push(frame);
  }
}

class HangingHeartbeatConnection extends TrackingConnection {
  private releaseHeartbeat: (() => void) | undefined;

  override async send(frame: ClientFrame): Promise<void> {
    if (frame.type !== 'heartbeat') {
      await super.send(frame);
      return;
    }
    this.sent.push(frame);
    await new Promise<void>((resolveWait) => { this.releaseHeartbeat = resolveWait; });
  }

  releaseLateSend(): void {
    this.releaseHeartbeat?.();
    this.releaseHeartbeat = undefined;
  }
}

class AcknowledgingConnection extends TrackingConnection {
  constructor(private readonly clock: VirtualClock) {
    super();
  }

  override async send(frame: ClientFrame): Promise<void> {
    if (frame.type === 'hello') {
      this.sent.push(frame);
      this.push({
        type: 'hello_ack', version: '3.0', epoch: 1,
        lease_expires_at: new Date(this.clock.now().getTime() + 30_000).toISOString(),
      });
      return;
    }
    await super.send(frame);
    if (frame.type !== 'heartbeat') return;
    this.push({
      type: 'heartbeat_ack',
      lease_expires_at: new Date(this.clock.now().getTime() + 30_000).toISOString(),
    });
  }
}

class StuckFrameIteratorConnection implements ConsumerConnection {
  readonly mode = 'consumer' as const;
  readonly ephemeral = false as const;
  readonly sent: ClientFrame[] = [];
  closeCalls = 0;
  nextCalls = 0;
  returnCalls = 0;

  constructor(private readonly clock: VirtualClock) {}

  async send(frame: ClientFrame): Promise<void> {
    this.sent.push(frame);
  }

  frames(): AsyncIterable<ServerFrame> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<ServerFrame>> => {
          this.nextCalls += 1;
          if (this.nextCalls === 1) {
            return {
              done: false,
              value: {
                type: 'hello_ack',
                version: '3.0',
                epoch: 1,
                lease_expires_at: new Date(this.clock.now().getTime() + 30_000).toISOString(),
              },
            };
          }
          return new Promise<IteratorResult<ServerFrame>>(() => undefined);
        },
        return: async (): Promise<IteratorResult<ServerFrame>> => (
          new Promise<IteratorResult<ServerFrame>>(() => {
            this.returnCalls += 1;
          })
        ),
      }),
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FrameWinsThenStopsConnection implements ConsumerConnection {
  readonly mode = 'consumer' as const;
  readonly ephemeral = false as const;
  typeReadsAfterStop = 0;
  closeCalls = 0;
  private nextCalls = 0;
  private readonly lateFrame: ServerFrame;

  constructor(
    private readonly clock: VirtualClock,
    private readonly stop: AbortController,
  ) {
    const wake: ServerFrame = {
      type: 'wake',
      alias: 'agent_frame_stop_race',
      reason: 'delivery_available',
    };
    this.lateFrame = new Proxy(wake, {
      get: (target, property, receiver): unknown => {
        if (property === 'type' && this.stop.signal.aborted) this.typeReadsAfterStop += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  }

  async send(frame: ClientFrame): Promise<void> {
    void frame;
  }

  frames(): AsyncIterable<ServerFrame> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<ServerFrame>> => {
          this.nextCalls += 1;
          if (this.nextCalls === 1) {
            return Promise.resolve({
              done: false,
              value: {
                type: 'hello_ack',
                version: '3.0',
                epoch: 1,
                lease_expires_at: new Date(this.clock.now().getTime() + 30_000).toISOString(),
              },
            });
          }
          return {
            then: (resolve: (value: IteratorResult<ServerFrame>) => void): void => {
              resolve({ done: false, value: this.lateFrame });
              this.stop.abort(new Error('planned stop after frame won'));
            },
          } as unknown as Promise<IteratorResult<ServerFrame>>;
        },
      }),
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const BASE_CONFIG = {
  tenantId: 'Steven',
  alias: 'agent_timeout_config',
  instanceId: 'instance-timeout-config',
  stateDirectory: '/tmp/cauce-timeout-config',
} satisfies AdapterConfig;

test('public connection timeout config accepts positive integers and rejects unsafe values', () => {
  assert.deepEqual(connectionTimeouts({
    ...BASE_CONFIG,
    connectTimeoutMs: 11,
    helloAckTimeoutMs: 12,
    heartbeatAckTimeoutMs: 13,
    sendTimeoutMs: 14,
  }), { connectMs: 11, helloAckMs: 12, heartbeatAckMs: 13, sendMs: 14 });

  for (const key of [
    'connectTimeoutMs',
    'helloAckTimeoutMs',
    'heartbeatAckTimeoutMs',
    'sendTimeoutMs',
  ] as const) {
    assert.doesNotThrow(() => connectionTimeouts({
      ...BASE_CONFIG,
      [key]: MAX_NODE_TIMER_DELAY_MS,
    }));
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => connectionTimeouts({ ...BASE_CONFIG, [key]: value }),
        new RegExp(`${key} must be a positive integer no greater than`, 'u'),
      );
    }
    assert.throws(
      () => connectionTimeouts({ ...BASE_CONFIG, [key]: MAX_NODE_TIMER_DELAY_MS + 1 }),
      new RegExp(`${key} must be a positive integer no greater than`, 'u'),
    );
  }
});

test('systemClock sleep removes its real abort listener after resolve and abort', async () => {
  const completed = new AbortController();
  for (let count = 0; count < 12; count += 1) {
    await systemClock.sleep(0, completed.signal);
    assert.equal(getEventListeners(completed.signal, 'abort').length, 0);
  }

  const cancelled = new AbortController();
  const sleeping = systemClock.sleep(60_000, cancelled.signal);
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 1);
  cancelled.abort(new Error('planned sleep abort'));
  await assert.rejects(sleeping, /planned sleep abort/u);
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 0);
});

test('deadline races remove their timer and abort listener on success and timeout', async () => {
  const clock = new VirtualClock(1_000);
  const stop = new AbortController();
  assert.equal(await raceWithDeadline(Promise.resolve('ok'), {
    clock,
    at: 1_100,
    signals: [stop.signal],
    timeoutError: () => new Error('late'),
  }), 'ok');
  assert.equal(clock.pendingTimers(), 0);
  assert.equal(getEventListeners(stop.signal, 'abort').length, 0);

  const never = new Promise<never>(() => undefined);
  const timed = raceWithDeadline(never, {
    clock,
    at: 1_100,
    signals: [stop.signal, stop.signal],
    timeoutError: () => new AdapterError('TEST_TIMEOUT', 'planned timeout', true),
  });
  const rejected = assert.rejects(timed, (error: unknown) => (
    error instanceof AdapterError && error.code === 'TEST_TIMEOUT'
  ));
  assert.equal(getEventListeners(stop.signal, 'abort').length, 1, 'duplicate signals share one listener');
  await advance(clock, 100);
  await rejected;
  assert.equal(clock.pendingTimers(), 0);
  assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
});

test('a stopped generation ignores late ACKs and duplicate ACKs cannot renew a newer heartbeat', () => {
  const clock = new VirtualClock(1_000);
  const failures: AdapterError[] = [];
  const previous = new ConnectionLiveness({
    clock,
    helloAckTimeoutMs: 10,
    heartbeatAckTimeoutMs: 20,
    onFailure: (error) => { failures.push(error); },
  });
  previous.start();
  previous.helloAcknowledged(new Date(2_000).toISOString());
  previous.stop();
  assert.equal(previous.heartbeatAcknowledged(new Date(3_000).toISOString()), false);

  const current = new ConnectionLiveness({
    clock,
    helloAckTimeoutMs: 10,
    heartbeatAckTimeoutMs: 20,
    onFailure: (error) => { failures.push(error); },
  });
  current.start();
  current.helloAcknowledged(new Date(2_000).toISOString());
  current.heartbeatStarted();
  const firstAck = new Date(3_000).toISOString();
  assert.equal(current.heartbeatAcknowledged(firstAck), true);
  current.heartbeatStarted();
  assert.equal(current.heartbeatAcknowledged(firstAck), false);
  clock.advance(20);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.code, 'HEARTBEAT_ACK_TIMEOUT');
  assert.equal(clock.pendingTimers(), 0);
});

test('hello lease seeds heartbeat monotonicity so an older first ACK cannot clear the watchdog', () => {
  const clock = new VirtualClock(1_000);
  const failures: AdapterError[] = [];
  const failureCodes = (): string[] => failures.map((error) => error.code);
  const liveness = new ConnectionLiveness({
    clock,
    helloAckTimeoutMs: 10,
    heartbeatAckTimeoutMs: 20,
    onFailure: (error) => { failures.push(error); },
  });
  liveness.start();
  const helloLease = new Date(3_000).toISOString();
  liveness.helloAcknowledged(helloLease);
  liveness.heartbeatStarted();
  assert.equal(liveness.heartbeatAcknowledged(helloLease), false);
  assert.equal(liveness.heartbeatAcknowledged(new Date(2_999).toISOString()), false);
  clock.advance(20);
  assert.deepEqual(failureCodes(), ['HEARTBEAT_ACK_TIMEOUT']);
  assert.equal(clock.pendingTimers(), 0);
});

test('an absolute lease timestamp behind the local clock defers to the relative heartbeat deadline', () => {
  const clock = new VirtualClock(10_000);
  const failures: AdapterError[] = [];
  const liveness = new ConnectionLiveness({
    clock,
    helloAckTimeoutMs: 10,
    heartbeatAckTimeoutMs: 20,
    onFailure: (error) => { failures.push(error); },
  });
  const failureCodes = (): string[] => failures.map((error) => error.code);
  liveness.start();
  liveness.helloAcknowledged(new Date(9_000).toISOString());
  assert.deepEqual(failureCodes(), []);
  liveness.heartbeatStarted();
  clock.advance(19);
  assert.deepEqual(failureCodes(), []);
  clock.advance(1);
  assert.deepEqual(failureCodes(), ['HEARTBEAT_ACK_TIMEOUT']);
  assert.equal(clock.pendingTimers(), 0);
});

test('a lease beyond the Node timer maximum rearms in chunks and fails one second before expiry', () => {
  const startedAt = 1_000;
  const clock = new VirtualClock(startedAt);
  const failures: AdapterError[] = [];
  const failureCodes = (): string[] => failures.map((error) => error.code);
  const liveness = new ConnectionLiveness({
    clock,
    helloAckTimeoutMs: 10,
    heartbeatAckTimeoutMs: 20,
    onFailure: (error) => { failures.push(error); },
  });
  const finalChunkMs = 5_000;
  const leaseExpiresAt = startedAt + MAX_NODE_TIMER_DELAY_MS + finalChunkMs + 1_000;
  liveness.start();
  liveness.helloAcknowledged(new Date(leaseExpiresAt).toISOString());

  assert.equal(clock.scheduledIn(MAX_NODE_TIMER_DELAY_MS), 1);
  clock.advance(MAX_NODE_TIMER_DELAY_MS);
  assert.deepEqual(failureCodes(), []);
  assert.equal(clock.scheduledIn(finalChunkMs), 1);
  clock.advance(finalChunkMs - 1);
  assert.deepEqual(failureCodes(), []);
  assert.equal(clock.pendingTimers(), 1);
  clock.advance(1);
  assert.deepEqual(failureCodes(), ['CONNECTION_LEASE_EXPIRED']);
  assert.equal(clock.pendingTimers(), 0);
});

test('stopping a chunked long lease removes its timer and prevents a later failure', () => {
  const startedAt = 1_000;
  const clock = new VirtualClock(startedAt);
  const failures: AdapterError[] = [];
  const liveness = new ConnectionLiveness({
    clock,
    helloAckTimeoutMs: 10,
    heartbeatAckTimeoutMs: 20,
    onFailure: (error) => { failures.push(error); },
  });
  const leaseDurationMs = MAX_NODE_TIMER_DELAY_MS + 10_000;
  liveness.start();
  liveness.helloAcknowledged(new Date(startedAt + leaseDurationMs).toISOString());
  assert.equal(clock.pendingTimers(), 1);

  liveness.stop();
  assert.equal(clock.pendingTimers(), 0);
  clock.advance(leaseDurationMs);
  assert.deepEqual(failures, []);
  assert.equal(clock.pendingTimers(), 0);
});

test('a connector that never settles is aborted at its deadline and reconnects', async () => {
  const clock = new VirtualClock();
  const attempts: AbortSignal[] = [];
  const connector: ConsumerConnector = {
    connect: async (signal) => {
      attempts.push(signal);
      return new Promise<ConsumerConnection>(() => undefined);
    },
  };
  const { client } = await makeClient('connect-deadline', connector, {
    clock,
    connectTimeoutMs: 100,
  });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  try {
    await waitUntil(() => attempts.length === 1, 'the first hanging connect attempt');
    const firstAttempt = attempts[0];
    assert.ok(firstAttempt);
    await advance(clock, 99);
    assert.equal(attempts.length, 1);
    assert.equal(firstAttempt.aborted, false);
    await advance(clock, 1);
    assert.equal(firstAttempt.aborted, true);
    await advance(clock, 1);
    await waitUntil(() => attempts.length === 2, 'a second connect attempt after backoff');
  } finally {
    stop.abort();
    await running;
  }
  assert.equal(attempts.every((signal) => signal.aborted), true);
  assert.equal(clock.pendingTimers(), 0);
});

test('silent hello closes only its generation and reconnects after the existing backoff', async () => {
  const clock = new VirtualClock();
  const first = new SilentHelloConnection();
  const second = new TrackingConnection();
  const connector = new SequenceConnector([first, second]);
  const { client } = await makeClient('silent-hello-deadline', connector, {
    clock,
    helloAckTimeoutMs: 100,
    sendTimeoutMs: 1_000,
  });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  try {
    await waitUntil(() => first.sent.some((frame) => frame.type === 'hello'), 'the silent hello');
    await advance(clock, 99);
    assert.equal(connector.calls, 1);
    assert.equal(first.closeCalls, 0);
    await advance(clock, 1);
    assert.notEqual(first.closeCalls, 0);
    await advance(clock, 1);
    await waitUntil(() => second.sent.some((frame) => frame.type === 'hello'), 'hello on the replacement connection');
    assert.equal(connector.calls, 2);

    first.push({
      type: 'heartbeat_ack',
      lease_expires_at: new Date(clock.now().getTime() + 30_000).toISOString(),
    });
    await eventLoopTurn();
    assert.equal(second.closeCalls, 0, 'a late frame from the old generation cannot close the new one');
  } finally {
    stop.abort();
    await running;
  }
  assert.equal(clock.pendingTimers(), 0);
});

test('a hanging connection close cannot block reconnect or client stop', async () => {
  const clock = new VirtualClock();
  const first = new HangingCloseConnection();
  const second = new HangingCloseConnection();
  const connector = new SequenceConnector([first, second]);
  const { client } = await makeClient('hanging-connection-close', connector, { clock });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  try {
    await waitUntil(() => first.sent.some((frame) => frame.type === 'hello'), 'hello before hanging close');
    first.end();
    await waitUntil(() => first.closeCalls > 0, 'best-effort hanging close');
    await waitUntil(() => clock.scheduledIn(1) >= 1, 'backoff after hanging close');
    await advance(clock, 1);
    await waitUntil(() => second.sent.some((frame) => frame.type === 'hello'), 'reconnect after hanging close');
    assert.equal(connector.calls, 2);
    assert.notEqual(first.closeCalls, 0);
  } finally {
    stop.abort();
  }
  assert.equal(await settlesWithin(running, 250), true);
  assert.notEqual(second.closeCalls, 0);
  assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
  assert.equal(clock.pendingTimers(), 0);
});

test('the first unacknowledged heartbeat expires without later sends extending its deadline', async () => {
  const clock = new VirtualClock();
  const first = new TrackingConnection();
  const second = new TrackingConnection();
  const connector = new SequenceConnector([first, second]);
  const { client } = await makeClient('heartbeat-ack-deadline', connector, {
    clock,
    heartbeatMs: 10,
    heartbeatAckTimeoutMs: 25,
    sendTimeoutMs: 100,
  });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  try {
    await waitUntil(() => first.sent.some((frame) => frame.type === 'hello'), 'the acknowledged hello');
    await waitUntil(() => clock.scheduledIn(10) >= 1, 'the first heartbeat interval');
    await advance(clock, 10);
    await waitUntil(() => first.sent.some((frame) => frame.type === 'heartbeat'), 'the first heartbeat');
    await advance(clock, 24);
    assert.equal(first.closeCalls, 0);
    assert.ok(
      first.sent.filter((frame) => frame.type === 'heartbeat').length >= 2,
      'later heartbeats continue but do not renew liveness without an ACK',
    );
    await advance(clock, 1);
    assert.notEqual(first.closeCalls, 0);
    await advance(clock, 1);
    await waitUntil(() => second.sent.some((frame) => frame.type === 'hello'), 'reconnect after heartbeat timeout');
  } finally {
    stop.abort();
    await running;
  }
  assert.equal(clock.pendingTimers(), 0);
});

test('fresh heartbeat acknowledgements keep the current generation alive', async () => {
  const clock = new VirtualClock();
  const connection = new AcknowledgingConnection(clock);
  const connector = new SequenceConnector([connection]);
  const { client } = await makeClient('heartbeat-ack-control', connector, {
    clock,
    heartbeatMs: 10,
    heartbeatAckTimeoutMs: 15,
  });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === 'hello'), 'the acknowledged hello');
    for (let count = 0; count < 4; count += 1) {
      await waitUntil(() => clock.scheduledIn(10) >= 1, `heartbeat interval ${String(count + 1)}`);
      await advance(clock, 10);
    }
    assert.equal(connector.calls, 1);
    assert.equal(connection.closeCalls, 0);
    assert.ok(connection.sent.filter((frame) => frame.type === 'heartbeat').length >= 4);
  } finally {
    stop.abort();
    await running;
  }
  assert.equal(clock.pendingTimers(), 0);
});

test('a hanging send times out, and its late completion cannot poison the new generation', async () => {
  const clock = new VirtualClock();
  const first = new HangingHeartbeatConnection();
  const second = new TrackingConnection();
  const connector = new SequenceConnector([first, second]);
  const { client } = await makeClient('hanging-send-deadline', connector, {
    clock,
    heartbeatMs: 10,
    heartbeatAckTimeoutMs: 100,
    sendTimeoutMs: 20,
  });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  try {
    await waitUntil(() => first.sent.some((frame) => frame.type === 'hello'), 'the acknowledged hello');
    await waitUntil(() => clock.scheduledIn(10) >= 1, 'the first heartbeat interval');
    await advance(clock, 10);
    await waitUntil(() => first.sent.some((frame) => frame.type === 'heartbeat'), 'the hanging heartbeat send');
    await advance(clock, 19);
    assert.equal(first.closeCalls, 0);
    await advance(clock, 1);
    assert.notEqual(first.closeCalls, 0);
    await advance(clock, 1);
    await waitUntil(() => second.sent.some((frame) => frame.type === 'hello'), 'replacement after send timeout');
    first.releaseLateSend();
    await eventLoopTurn();
    assert.equal(second.closeCalls, 0);
  } finally {
    stop.abort();
    await running;
  }
  assert.equal(clock.pendingTimers(), 0);
});

test('abort settles promptly even while the transport send promise remains hung', async () => {
  const clock = new VirtualClock();
  const connection = new HangingHeartbeatConnection();
  const { client } = await makeClient(
    'hanging-send-abort',
    new SequenceConnector([connection]),
    { clock, heartbeatMs: 10, heartbeatAckTimeoutMs: 1_000, sendTimeoutMs: 1_000 },
  );
  const stop = new AbortController();
  const running = client.run(stop.signal);
  await waitUntil(() => connection.sent.some((frame) => frame.type === 'hello'), 'the acknowledged hello');
  await waitUntil(() => clock.scheduledIn(10) >= 1, 'the first heartbeat interval');
  await advance(clock, 10);
  await waitUntil(() => connection.sent.some((frame) => frame.type === 'heartbeat'), 'the hanging heartbeat send');
  stop.abort();
  assert.equal(await settlesWithin(running, 250), true);
  assert.equal(clock.pendingTimers(), 0);
});

test('a stuck frame next and return cannot block watchdog reconnect or client stop', async () => {
  const clock = new VirtualClock();
  const first = new StuckFrameIteratorConnection(clock);
  const second = new TrackingConnection();
  const connector = new SequenceConnector([first, second]);
  const { client } = await makeClient('stuck-frame-iterator', connector, {
    clock,
    heartbeatMs: 10,
    heartbeatAckTimeoutMs: 20,
    sendTimeoutMs: 100,
  });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  try {
    await waitUntil(() => first.nextCalls === 2, 'the pending frame read after hello_ack');
    await waitUntil(() => clock.scheduledIn(10) >= 1, 'the first heartbeat interval');
    await advance(clock, 10);
    await waitUntil(() => first.sent.some((frame) => frame.type === 'heartbeat'), 'the first heartbeat');
    await advance(clock, 20);
    assert.notEqual(first.closeCalls, 0);
    assert.equal(first.returnCalls, 1);
    await advance(clock, 1);
    await waitUntil(() => second.sent.some((frame) => frame.type === 'hello'), 'hello after the stuck iterator');
    assert.equal(connector.calls, 2);
  } finally {
    stop.abort();
  }
  assert.equal(await settlesWithin(running, 250), true);
  assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
  assert.equal(clock.pendingTimers(), 0);
});

test('a frame that wins next is not processed after stop aborts its generation', async () => {
  const clock = new VirtualClock();
  const stop = new AbortController();
  const connection = new FrameWinsThenStopsConnection(clock, stop);
  const { client } = await makeClient(
    'frame-stop-race',
    new SequenceConnector([connection]),
    { clock, heartbeatMs: 10, heartbeatAckTimeoutMs: 20 },
  );

  const running = client.run(stop.signal);
  assert.equal(await settlesWithin(running, 250), true);
  assert.equal(stop.signal.aborted, true);
  assert.equal(connection.typeReadsAfterStop, 0);
  assert.notEqual(connection.closeCalls, 0);
  assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
  assert.equal(clock.pendingTimers(), 0);
});
