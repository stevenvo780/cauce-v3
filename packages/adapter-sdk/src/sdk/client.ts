import { PROTOCOL_VERSION } from '@cauce/protocol';
import { DEFAULT_BACKOFF, ExponentialBackoff, systemClock } from './backoff.js';
import { ConsumerLease, DurableStore } from './durable-store.js';
import { AdapterEngine } from './engine.js';
import { AdapterError } from './errors.js';
import type { HarnessAdapter } from '../harnesses/shared.js';
import type {
  AdapterCapabilities,
  AdapterConfig,
  AdapterLogger,
  ClientFrame,
  Clock,
  ConsumerConnection,
  ConsumerConnector,
  DeliveryEvent,
  HeartbeatFrame,
  ServerFrame,
} from './types.js';

export interface AdapterClientOptions {
  readonly config: AdapterConfig;
  readonly connector: ConsumerConnector;
  readonly store: DurableStore;
  readonly harness: HarnessAdapter;
  readonly clock?: Clock;
  readonly random?: () => number;
  readonly onError?: (code: string) => void;
  readonly logger?: AdapterLogger;
  /** Runs under the stable-alias lease before the first transport connection. */
  readonly onLeaseAcquired?: () => Promise<void>;
  /** Test/diagnostic override; production derives renewal cadence from the delivery claim. */
  readonly claimRenewalMs?: number;
  /** Test/diagnostic override; production derives the watchdog from the delivery claim. */
  readonly claimWatchdogMs?: number;
}

function validateIdentity(config: AdapterConfig): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(config.alias)) {
    throw new Error('Alias must be a stable lowercase identifier');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(config.instanceId)) {
    throw new Error('instance_id must be a stable non-empty identifier');
  }
  if (config.stateDirectory.length === 0) {
    throw new Error('A durable state directory is required; ephemeral consumers are forbidden');
  }
}

export function capabilityStrings(capabilities: AdapterCapabilities): string[] {
  return [
    `protocol.${capabilities.protocol_version}`,
    `harness.${capabilities.harness}`,
    'structured-output',
    'durable-inbox',
    'durable-outbox',
    'fencing-epoch',
    'attempt-scoped-delivery',
    'event-id-correlation',
    'claim-token-correlation',
    'authenticated-session-scope',
    ...(capabilities.routing_targets_v1 ? ['routing_targets_v1'] : []),
    ...(capabilities.renewable_delivery_claims_v1 ? ['renewable_delivery_claims_v1'] : []),
    ...(capabilities.persistent_sessions ? ['persistent-sessions'] : []),
    ...(capabilities.loopback_api === true ? ['loopback-api'] : []),
    ...(capabilities.stable_alias_sessions === true ? ['stable-alias-sessions'] : []),
    ...(capabilities.api_cancellation === 'abort_signal' ? ['api-cancellation.abort-signal'] : []),
  ];
}

export class AdapterClient {
  private readonly config: AdapterConfig;
  private readonly connector: ConsumerConnector;
  private readonly store: DurableStore;
  private readonly harness: HarnessAdapter;
  private readonly clock: Clock;
  private readonly backoff: ExponentialBackoff;
  private readonly engine: AdapterEngine;
  private readonly logger: AdapterLogger;
  private activeConnection: ConsumerConnection | undefined;
  private sendTail: Promise<void> = Promise.resolve();
  private running = false;
  private readonly onError: (code: string) => void;
  private readonly onLeaseAcquired: (() => Promise<void>) | undefined;

  constructor(options: AdapterClientOptions) {
    validateIdentity(options.config);
    this.config = options.config;
    this.connector = options.connector;
    this.store = options.store;
    this.harness = options.harness;
    this.onError = options.onError ?? (() => undefined);
    this.logger = options.logger ?? (() => undefined);
    this.onLeaseAcquired = options.onLeaseAcquired;
    this.clock = options.clock ?? systemClock;
    this.backoff = new ExponentialBackoff(
      { ...DEFAULT_BACKOFF, ...options.config.reconnect },
      options.random,
    );
    this.engine = new AdapterEngine({
      store: this.store,
      harness: this.harness,
      publish: (event) => this.sendEvent(event),
      logger: this.logger,
      ...(options.config.defaultTimeoutMs === undefined
        ? {}
        : { defaultTimeoutMs: options.config.defaultTimeoutMs }),
      ...(options.claimRenewalMs === undefined ? {} : { claimRenewalMs: options.claimRenewalMs }),
      ...(options.claimWatchdogMs === undefined ? {} : { claimWatchdogMs: options.claimWatchdogMs }),
      clock: this.clock,
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('Only one consumer loop is allowed per adapter instance');
    this.running = true;
    const lease = await ConsumerLease.acquire(
      this.config.stateDirectory,
      this.config.alias,
      this.config.instanceId,
    );
    try {
      await this.onLeaseAcquired?.();
      while (!signal.aborted) {
        try {
          const connection = await this.connector.connect(signal);
          this.assertLongLivedConsumer(connection);
          if (this.activeConnection !== undefined) throw new Error('Concurrent consumer connections are forbidden');
          this.activeConnection = connection;
          const closeOnAbort = (): void => { void connection.close(); };
          signal.addEventListener('abort', closeOnAbort, { once: true });
          try {
            await this.send({
              type: 'hello',
              version: PROTOCOL_VERSION,
              tenant_id: this.config.tenantId,
              alias: this.config.alias,
              instance_id: this.config.instanceId,
              capabilities: capabilityStrings(this.harness.definition.capabilities),
            });
            await this.consume(connection, signal);
          } finally {
            signal.removeEventListener('abort', closeOnAbort);
          }
          if (!signal.aborted) throw new Error('Consumer connection closed');
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof AdapterError && !error.retryable) throw error;
          const errorCode = connectionErrorCode(error);
          this.onError(errorCode);
          this.logger({
            event: 'connection_error',
            timestamp: this.clock.now().toISOString(),
            reason: errorCode,
            error_message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          const connection = this.activeConnection;
          this.activeConnection = undefined;
          await connection?.close().catch(() => undefined);
        }
        if (!signal.aborted) await this.clock.sleep(this.backoff.nextDelay(), signal).catch(() => undefined);
      }
    } finally {
      this.engine.stop();
      this.activeConnection = undefined;
      this.running = false;
      await lease.release();
    }
  }

  private async consume(connection: ConsumerConnection, signal: AbortSignal): Promise<void> {
    let welcomed = false;
    const heartbeatAbort = new AbortController();
    let heartbeat: Promise<void> = Promise.resolve();
    try {
      for await (const frame of connection.frames()) {
        if (signal.aborted) break;
        if (frame.type === 'hello_ack') {
          if (welcomed) throw new Error('Gateway sent duplicate hello_ack');
          await this.engine.activateEpoch(frame.epoch);
          welcomed = true;
          this.backoff.reset();
          heartbeat = this.heartbeatLoop(heartbeatAbort.signal).catch(async () => {
            await connection.close().catch(() => undefined);
          });
          await this.flushOutbox();
          void this.engine.recover().catch(() => undefined);
          continue;
        }
        if (frame.type === 'takeover_rejected') {
          throw new AdapterError('TAKEOVER_REJECTED', frame.reason, false);
        }
        if (!welcomed) throw new Error('Gateway sent traffic before hello_ack');
        await this.handleFrame(frame);
      }
    } finally {
      heartbeatAbort.abort();
      await heartbeat;
    }
  }

  private async handleFrame(frame: Exclude<ServerFrame, { type: 'hello_ack' | 'takeover_rejected' }>): Promise<void> {
    switch (frame.type) {
      case 'delivery':
        void this.engine.handleDelivery(frame).catch((error: unknown) => {
          this.onError(error instanceof AdapterError ? error.code : 'DELIVERY_FAILED');
        });
        return;
      case 'ack_result': {
        const correlation = {
          event_id: frame.event_id,
          delivery_id: frame.delivery_id,
          attempt: frame.attempt,
          claim_token: frame.claim_token,
        };
        const pending = this.store.pendingEvents().find((event) => (
          event.event_id === correlation.event_id
          && event.delivery_id === correlation.delivery_id
          && event.attempt === correlation.attempt
          && event.claim_token === correlation.claim_token
        ));
        const acknowledged = await this.store.acknowledge(correlation);
        if (acknowledged && pending?.claim_renewal === true) {
          if (frame.applied === true || frame.receipt === 'duplicate') {
            this.engine.confirmClaim(frame.delivery_id, frame.attempt, frame.claim_token);
          } else {
            this.engine.loseClaim(frame.delivery_id, frame.attempt, frame.claim_token);
          }
        }
        return;
      }
      case 'error':
        if (frame.code === 'fenced') throw new AdapterError('FENCED', frame.message, true);
        return;
      case 'heartbeat_ack':
      case 'wake':
        return;
    }
  }

  private async flushOutbox(): Promise<void> {
    for (const event of this.store.pendingEvents()) await this.sendEvent(event);
  }

  private sendEvent(event: DeliveryEvent): Promise<void> {
    const detail = clampAckDetail(
      event.error?.message ?? (event.output?.status === 'failed' ? event.output.reply ?? undefined : undefined),
    );
    return this.send({
      type: 'ack',
      version: PROTOCOL_VERSION,
      event_id: event.event_id,
      delivery_id: event.delivery_id,
      attempt: event.attempt,
      claim_token: event.claim_token,
      status: event.phase,
      instance_id: this.config.instanceId,
      epoch: event.epoch,
      retryable: event.error?.retryable ?? event.output?.retryable ?? false,
      ...(detail === undefined ? {} : { error: detail }),
      ...(event.error === undefined ? {} : { error_code: event.error.code }),
      ...(event.output === undefined ? {} : { result: { output: event.output } }),
    });
  }

  private send(frame: ClientFrame): Promise<void> {
    const next = this.sendTail.catch(() => undefined).then(async () => {
      const connection = this.activeConnection;
      if (connection === undefined) throw new Error('No active consumer connection');
      await connection.send(frame);
    });
    this.sendTail = next;
    return next;
  }

  private async heartbeatLoop(signal: AbortSignal): Promise<void> {
    const interval = this.config.heartbeatMs ?? 15_000;
    while (!signal.aborted) {
      await this.clock.sleep(interval, signal);
      if (signal.aborted || this.engine.epoch === 0) continue;
      const heartbeat: HeartbeatFrame = {
        type: 'heartbeat',
        instance_id: this.config.instanceId,
        epoch: this.engine.epoch,
      };
      await this.send(heartbeat);
    }
  }

  private assertLongLivedConsumer(connection: ConsumerConnection): void {
    const candidate = connection as Partial<ConsumerConnection>;
    if (candidate.mode !== 'consumer' || candidate.ephemeral !== false) {
      throw new AdapterError(
        'EPHEMERAL_CONNECTION',
        'Stable aliases require one non-ephemeral consumer connection',
        false,
      );
    }
  }
}

/**
 * `BaseAckSchema.error` is capped at 2000 characters and every client frame is
 * schema-checked before it reaches the socket. An over-long harness failure
 * message therefore used to throw a ZodError inside `send()`, tearing down the
 * connection; because the offending event stays at the head of the outbox, the
 * next `flushOutbox()` replayed it and killed the new connection too, so the
 * adapter reconnect-looped forever and could never report or receive anything.
 *
 * Truncating here is lossless for the operator: the untruncated text is always
 * carried in `result.output`, which the schema leaves unbounded.
 */
const MAX_ACK_ERROR_DETAIL = 2_000;
const ACK_DETAIL_TRUNCATION_SUFFIX = '… [truncated]';

export function clampAckDetail(detail: string | undefined): string | undefined {
  if (detail === undefined || detail.length <= MAX_ACK_ERROR_DETAIL) return detail;
  return detail.slice(0, MAX_ACK_ERROR_DETAIL - ACK_DETAIL_TRUNCATION_SUFFIX.length)
    + ACK_DETAIL_TRUNCATION_SUFFIX;
}

function connectionErrorCode(error: unknown): string {
  if (error instanceof AdapterError) return error.code;
  if (!(error instanceof Error)) return `CONNECTION_UNKNOWN_${typeof error}_${Object.prototype.toString.call(error).slice(8, -1)}`;
  if (error.message.includes('outside the Cauce V3 schema')) return 'FRAME_SCHEMA';
  if (error.message.includes('closed')) return 'CONNECTION_CLOSED';
  if (error.message.includes('traffic before')) return 'FRAME_BEFORE_HELLO';
  if (error.message.includes('duplicate hello')) return 'DUPLICATE_HELLO';
  if (error.message.includes('Could not connect')) return 'CONNECT_FAILED';
  return `CONNECTION_${error.name.toUpperCase()}`;
}
