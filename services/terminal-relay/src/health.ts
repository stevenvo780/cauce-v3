import type { Server } from 'node:http';
import { startHealthServer, type HealthAnswer } from '@cauce/protocol';

/**
 * Readiness for the relay data plane. A listening TCP socket alone is not useful: the process is
 * routable only after both TLS listeners are up and the gateway accepted a current presence
 * publication. `/metrics` rides this same listener, identity-free; it binds every interface of the compose network like the dispatcher's, because Prometheus is a separate container and a loopback bind is a target it can never reach, and Compose publishes no host port for it.
 */

type RelayNotReadyReason =
  | 'stopping'
  | 'listener_down'
  | 'presence_not_published'
  | 'presence_publish_failed'
  | 'presence_stale';

interface RelayHealthStateOptions {
  readonly listenersReady: () => boolean;
  readonly presenceMaxStaleMs: number;
  /** Test seam; production uses the wall clock because the value is process-local only. */
  readonly now?: () => number;
}

type RelayReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: RelayNotReadyReason };

export class RelayHealthState {
  private readonly listenersReady: () => boolean;
  private readonly presenceMaxStaleMs: number;
  private readonly now: () => number;
  private lastPresenceAcceptedAt: number | undefined;
  private lastPresenceAttemptFailed = false;
  private stopping = false;

  constructor(options: RelayHealthStateOptions) {
    if (!Number.isSafeInteger(options.presenceMaxStaleMs) || options.presenceMaxStaleMs < 1) {
      throw new Error('terminal relay presenceMaxStaleMs must be a positive integer');
    }
    this.listenersReady = options.listenersReady;
    this.presenceMaxStaleMs = options.presenceMaxStaleMs;
    this.now = options.now ?? Date.now;
  }

  presenceAccepted(): void {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0) throw new Error('terminal relay health clock is invalid');
    this.lastPresenceAcceptedAt = now;
    this.lastPresenceAttemptFailed = false;
  }

  presenceFailed(): void {
    this.lastPresenceAttemptFailed = true;
  }

  beginShutdown(): void {
    this.stopping = true;
  }

  get presenceAcceptedAt(): number | undefined {
    return this.lastPresenceAcceptedAt;
  }

  get ready(): boolean {
    return this.readiness().ready;
  }

  readiness(): RelayReadiness {
    if (this.stopping) return { ready: false, reason: 'stopping' };
    if (!this.listenersReady()) return { ready: false, reason: 'listener_down' };
    if (this.lastPresenceAttemptFailed) return { ready: false, reason: 'presence_publish_failed' };
    if (this.lastPresenceAcceptedAt === undefined) {
      return { ready: false, reason: 'presence_not_published' };
    }
    const now = this.now();
    if (!Number.isFinite(now) || now < this.lastPresenceAcceptedAt
        || now - this.lastPresenceAcceptedAt > this.presenceMaxStaleMs) {
      return { ready: false, reason: 'presence_stale' };
    }
    return { ready: true };
  }
}

interface RelayHealthServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly metrics?: () => string;
}

export function createRelayHealthServer(
  state: RelayHealthState,
  options: RelayHealthServerOptions,
): Server {
  return startHealthServer({
    port: options.port,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    live: (): HealthAnswer => ({ ok: true, body: { status: 'live' } }),
    ready: (): HealthAnswer => {
      const readiness = state.readiness();
      if (readiness.ready) return { ok: true, body: { status: 'ready' } };
      return { ok: false, body: { status: 'not_ready', reason: readiness.reason } };
    },
  });
}
