import { PROTOCOL_VERSION } from '@cauce/protocol';
import {
  resumenDeLaSiembra, sembrarPerfilDelArnes, type ResultadoDeLaSiembra,
} from '../context/siembra-del-perfil.js';
import { nativeProfileContextEnabled } from '../context/native-profile-context.js';
import { DEFAULT_BACKOFF, ExponentialBackoff, systemClock } from './backoff.js';
import { ConsumerLease, DurableStore } from './durable-store.js';
import { AdapterEngine } from './engine.js';
import { AdapterError } from './errors.js';
import type { HarnessAdapter } from '../contracts/harness.js';
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

type CapabilityEncoder = (capabilities: AdapterCapabilities) => readonly string[];

interface ExecutionIntentWaiter {
  readonly deliveryId: string;
  readonly attempt: number;
  readonly claimToken: string;
  readonly confirm: () => void;
  readonly reject: (error: AdapterError) => void;
}

interface SendDeadline {
  /** Absolute wall-clock deadline; queueing behind an earlier frame consumes this budget. */
  readonly at: number;
  readonly signal: AbortSignal;
}

/*
 * Mapeo de claves de `AdapterCapabilities` a cadenas de capability del frame hello.
 */
const CAPABILITY_ENCODERS = {
  protocol_version: (value) => [`protocol.${value.protocol_version}`],
  harness: (value) => [`harness.${value.harness}`],
  structured_output: (value) => value.structured_output === true ? ['structured-output'] : [],
  stdin_prompt: (value) => value.stdin_prompt === true ? ['stdin-prompt'] : [],
  durable_inbox: (value) => value.durable_inbox === true ? ['durable-inbox'] : [],
  durable_outbox: (value) => value.durable_outbox === true ? ['durable-outbox'] : [],
  idempotent_delivery: (value) => value.idempotent_delivery === true ? ['idempotent-delivery'] : [],
  heartbeat: (value) => value.heartbeat === true ? ['heartbeat'] : [],
  cancellation: (value) => value.cancellation === 'process_group'
    ? ['cancellation.process-group']
    : [],
  fencing_epoch: (value) => value.fencing_epoch === true ? ['fencing-epoch'] : [],
  origin_relay: (value) => value.origin_relay === true ? ['origin-relay'] : [],
  attempt_scoped_delivery: (value) => value.attempt_scoped_delivery === true
    ? ['attempt-scoped-delivery']
    : [],
  event_id_correlation: (value) => value.event_id_correlation === true
    ? ['event-id-correlation']
    : [],
  claim_token_correlation: (value) => value.claim_token_correlation === true
    ? ['claim-token-correlation']
    : [],
  authenticated_session_scope: (value) => value.authenticated_session_scope === true
    ? ['authenticated-session-scope']
    : [],
  routing_targets_v1: (value) => value.routing_targets_v1 === true ? ['routing_targets_v1'] : [],
  attachments_v1: (value) => value.attachments_v1 === true ? ['attachments_v1'] : [],
  native_image_input_v1: (value) => value.native_image_input_v1 === true
    ? ['native_image_input_v1']
    : [],
  native_document_input_v1: (value) => value.native_document_input_v1 === true
    ? ['native_document_input_v1']
    : [],
  persistent_sessions: (value) => value.persistent_sessions === true ? ['persistent-sessions'] : [],
  loopback_api: (value) => value.loopback_api === true ? ['loopback-api'] : [],
  stable_alias_sessions: (value) => value.stable_alias_sessions === true
    ? ['stable-alias-sessions']
    : [],
  api_cancellation: (value) => value.api_cancellation === 'abort_signal'
    ? ['api-cancellation.abort-signal']
    : [],
  renewable_delivery_claims_v1: (value) => value.renewable_delivery_claims_v1 === true
    ? ['renewable_delivery_claims_v1']
    : [],
  delegation_feedback_v1: (value) => value.delegation_feedback_v1 === true
    ? ['delegation_feedback_v1']
    : [],
  agent_identity_v1: (value) => value.agent_identity_v1 === true ? ['agent_identity_v1'] : [],
  agent_profile_v1: (value) => value.agent_profile_v1 === true ? ['agent_profile_v1'] : [],
  agent_profile_adoption_v1: (value) => value.agent_profile_adoption_v1 === true
    ? ['agent_profile_adoption_v1']
    : [],
} satisfies Record<keyof AdapterCapabilities, CapabilityEncoder>;

export function capabilityStrings(capabilities: AdapterCapabilities): string[] {
  return Object.values(CAPABILITY_ENCODERS).flatMap((encode) => encode(capabilities));
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
  private readonly failedConnections = new WeakSet<ConsumerConnection>();
  private readonly executionIntentWaiters = new Map<string, ExecutionIntentWaiter>();
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
      publishExecutionIntent: (event, signal, timeoutMs) => (
        this.publishAndConfirmExecutionIntent(event, signal, timeoutMs)
      ),
      logger: this.logger,
      ...(options.config.tenantId === undefined ? {} : { ownTenantId: options.config.tenantId }),
      ...(options.config.ownRoom === undefined ? {} : { ownRoom: options.config.ownRoom }),
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
          /*
           * Sincroniza el perfil recibido en `hello_ack` antes de iniciar heartbeat, outbox y recuperación.
           * Ocurre tras `activateEpoch` para asegurar que el runtime aplica la identidad antes de procesar entregas.
           */
          this.sembrarPerfil(frame);
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

  /**
   * Escribe el perfil recibido en el saludo en los ficheros del arnés o falla la conexión.
   * `CAUCE_SEMBRAR_PERFIL=0` desactiva la sincronización.
   */
  private sembrarPerfil(frame: Extract<ServerFrame, { type: 'hello_ack' }>): void {
    const perfil = frame.agent_profile;
    if (perfil === undefined) return;
    try {
      const resultado = sembrarPerfilDelArnes(
        this.harness.definition.id,
        perfil,
        { habilitado: siembraHabilitada(process.env) },
      );
      const resumen = resumenDeLaSiembra(resultado);
      this.logger({ event: 'profile_seed', alias: this.config.alias, reason: resumen });
      if (!siembraAplicada(resultado)) {
        throw new AdapterError('PROFILE_SEED_FAILED', resumen, true);
      }
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      this.logger({
        event: 'profile_seed',
        alias: this.config.alias,
        reason: 'la siembra del perfil falló antes de acreditar el runtime',
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw new AdapterError('PROFILE_SEED_FAILED', 'Profile seed failed before runtime ACK', true);
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
        const terminalPending = pending?.phase === 'done' || pending?.phase === 'failed';
        const terminalReceipt = frame.applied === true
          ? 'applied' as const
          : frame.receipt === 'duplicate' || frame.receipt === 'ownership_lost'
            ? frame.receipt
            : undefined;
        const executionIntentReceipt = pending?.execution_started === true
          && frame.status === 'started'
          && ((frame.applied === true && frame.receipt === 'applied')
            || frame.receipt === 'duplicate')
          ? (frame.receipt === 'applied' ? 'applied' as const : 'duplicate' as const)
          : undefined;
        // Only a conclusive terminal receipt can clear pending done/failed states.
        if (terminalPending && terminalReceipt === undefined) return;
        const acknowledged = await this.store.acknowledgeResult(correlation, {
          ...(frame.delegation_rejections === undefined
            ? {}
            : { delegation_rejections: frame.delegation_rejections }),
          ...(frame.delegation_materializations === undefined
            ? {}
            : { delegation_materializations: frame.delegation_materializations }),
          ...(terminalReceipt === undefined ? {} : { terminal_receipt: terminalReceipt }),
          ...(executionIntentReceipt === undefined
            ? {}
            : { execution_intent_receipt: executionIntentReceipt }),
        });
        const intentWaiter = this.executionIntentWaiters.get(frame.event_id);
        if (intentWaiter !== undefined
          && intentWaiter.deliveryId === frame.delivery_id
          && intentWaiter.attempt === frame.attempt
          && intentWaiter.claimToken === frame.claim_token) {
          const durableReceipt = this.store.getDelivery(frame.delivery_id)
            ?.execution_intent_receipt_event_id === frame.event_id;
          if (acknowledged && executionIntentReceipt !== undefined && durableReceipt) {
            intentWaiter.confirm();
          } else {
            intentWaiter.reject(new AdapterError(
              frame.receipt === 'ownership_lost' ? 'FENCED' : 'EXECUTION_INTENT_CONFIRMATION_FAILED',
              'Gateway did not confirm the exact durable execution intent',
              true,
            ));
          }
        }
        if (acknowledged && pending?.claim_renewal === true) {
          if (frame.applied === true || frame.receipt === 'duplicate') {
            this.engine.confirmClaim(frame.delivery_id, frame.attempt, frame.claim_token);
          } else if (pending.phase === 'accepted' && frame.receipt !== 'ownership_lost') {
            // Renewal in unconfirmed accepted phase; not treated as ownership loss.
            this.engine.logDroppedQueueRenewal(frame.delivery_id, frame.attempt);
          } else {
            this.engine.loseClaim(frame.delivery_id, frame.attempt, frame.claim_token);
          }
        }
        return;
      }
      case 'error':
        if (frame.code === 'fenced') {
          const error = new AdapterError('FENCED', frame.message, true);
          for (const waiter of this.executionIntentWaiters.values()) waiter.reject(error);
          throw error;
        }
        return;
      case 'heartbeat_ack':
      case 'wake':
        return;
    }
  }

  private async flushOutbox(): Promise<void> {
    for (const event of this.store.pendingEvents()) await this.sendEvent(event);
  }

  private sendEvent(event: DeliveryEvent, deadline?: SendDeadline): Promise<void> {
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
      ...(event.execution_started === true ? { execution_started: true } : {}),
      ...(detail === undefined ? {} : { error: detail }),
      ...(event.error === undefined ? {} : { error_code: event.error.code }),
      ...(event.output === undefined && event.profile_adoption === undefined
        ? {}
        : {
            result: {
              ...(event.output === undefined ? {} : { output: event.output }),
              ...(event.profile_adoption === undefined
                ? {}
                : { profile_adoption: event.profile_adoption }),
            },
          }),
    }, deadline);
  }

  /**
   * The process may cross its side-effect boundary only after the remote store confirms the
   * exact event. Registration precedes send, and the timeout is absolute: unrelated renewal
   * receipts cannot extend it.
   */
  private async publishAndConfirmExecutionIntent(
    event: DeliveryEvent,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<void> {
    if (event.execution_started !== true || event.phase !== 'started') {
      throw new AdapterError(
        'EXECUTION_INTENT_CONFIRMATION_FAILED',
        'Execution-intent barrier received a non-marker event',
        true,
      );
    }
    if (signal.aborted) {
      throw signal.reason instanceof AdapterError
        ? signal.reason
        : new AdapterError('EXECUTION_INTENT_CONFIRMATION_FAILED', 'Execution intent was cancelled', true);
    }
    if (this.executionIntentWaiters.has(event.event_id)) {
      throw new AdapterError(
        'EXECUTION_INTENT_CONFIRMATION_FAILED',
        'Execution-intent confirmation is already pending',
        true,
      );
    }

    let settled = false;
    const timerRef: { current?: NodeJS.Timeout } = {};
    let resolveConfirmation!: () => void;
    let rejectConfirmation!: (error: AdapterError) => void;
    const confirmation = new Promise<void>((resolveWait, rejectWait) => {
      resolveConfirmation = resolveWait;
      rejectConfirmation = rejectWait;
    });
    const cleanup = (): void => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      signal.removeEventListener('abort', onAbort);
      const current = this.executionIntentWaiters.get(event.event_id);
      if (current === waiter) this.executionIntentWaiters.delete(event.event_id);
    };
    const confirm = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveConfirmation();
    };
    const reject = (error: AdapterError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectConfirmation(error);
    };
    const onAbort = (): void => {
      reject(signal.reason instanceof AdapterError
        ? signal.reason
        : new AdapterError('EXECUTION_INTENT_CONFIRMATION_FAILED', 'Execution intent was cancelled', true));
    };
    const waiter: ExecutionIntentWaiter = {
      deliveryId: event.delivery_id,
      attempt: event.attempt,
      claimToken: event.claim_token,
      confirm,
      reject,
    };
    this.executionIntentWaiters.set(event.event_id, waiter);
    signal.addEventListener('abort', onAbort, { once: true });
    timerRef.current = setTimeout(() => {
      reject(new AdapterError(
        'EXECUTION_INTENT_CONFIRMATION_FAILED',
        'Gateway did not confirm execution intent before the ownership deadline',
        true,
      ));
    }, timeoutMs);
    timerRef.current.unref();

    try {
      await Promise.all([
        this.sendEvent(event, { at: Date.now() + timeoutMs, signal }),
        confirmation,
      ]);
    } catch (error) {
      if (!settled) {
        reject(error instanceof AdapterError
          ? error
          : new AdapterError(
              'EXECUTION_INTENT_CONFIRMATION_FAILED',
              'Execution intent could not be sent to the gateway',
              true,
            ));
      }
      throw error instanceof AdapterError
        ? error
        : new AdapterError(
            'EXECUTION_INTENT_CONFIRMATION_FAILED',
            'Execution intent could not be confirmed by the gateway',
            true,
          );
    }
  }

  private send(frame: ClientFrame, deadline?: SendDeadline): Promise<void> {
    const next = this.sendTail.catch(() => undefined).then(async () => {
      const connection = this.activeConnection;
      if (connection === undefined) throw new Error('No active consumer connection');
      if (this.failedConnections.has(connection)) throw new Error('Consumer connection is no longer writable');
      if (deadline === undefined) {
        await connection.send(frame);
        return;
      }
      if (deadline.signal.aborted) {
        throw deadline.signal.reason instanceof Error
          ? deadline.signal.reason
          : new AdapterError('EXECUTION_INTENT_CONFIRMATION_FAILED', 'Execution intent was cancelled', true);
      }
      const remainingMs = deadline.at - Date.now();
      if (remainingMs <= 0) {
        this.failedConnections.add(connection);
        void connection.close().catch(() => undefined);
        throw new AdapterError(
          'EXECUTION_INTENT_CONFIRMATION_FAILED',
          'Execution intent send exceeded the ownership deadline',
          true,
        );
      }
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AdapterError(
          'EXECUTION_INTENT_CONFIRMATION_FAILED',
          'Execution intent send exceeded the ownership deadline',
          true,
        )), remainingMs);
        timer.unref();
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(deadline.signal.reason instanceof Error
          ? deadline.signal.reason
          : new AdapterError('EXECUTION_INTENT_CONFIRMATION_FAILED', 'Execution intent was cancelled', true));
        deadline.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        await Promise.race([connection.send(frame), timedOut, aborted]);
      } catch (error) {
        this.failedConnections.add(connection);
        void connection.close().catch(() => undefined);
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort !== undefined) deadline.signal.removeEventListener('abort', onAbort);
      }
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

/** Sólo un lote completo, un no-op comprobado o una retirada explícita permiten consumir. */
export function siembraAplicada(resultado: ResultadoDeLaSiembra): boolean {
  if (resultado.estado === 'apagado' || resultado.estado === 'sin-ficheros') return true;
  if (resultado.estado !== 'hecho') return false;
  return resultado.ficheros.every((fichero) => (
    fichero.estado === 'escrito' || fichero.estado === 'ya-estaba'
  ));
}

/** Legacy reconnect seeding is default-on but never races the native publisher. */
export function siembraHabilitada(entorno: NodeJS.ProcessEnv): boolean {
  return !nativeProfileContextEnabled(entorno.CAUCE_NATIVE_PROFILE_CONTEXT)
    && entorno.CAUCE_SEMBRAR_PERFIL !== '0';
}

/**
 * Truncates `BaseAckSchema.error` to 2000 characters to fit frame schema limits.
 * The full message remains preserved in `result.output`.
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
