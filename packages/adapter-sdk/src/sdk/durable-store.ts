import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConsumerLeaseError } from "./errors.js";
import type { Delivery, DeliveryEvent, StructuredOutput } from "./types.js";

export type InboxState = "accepted" | "started" | "done" | "failed";

export interface InboxRecord {
  readonly delivery_id: string;
  readonly fingerprint: string;
  readonly epoch: number;
  readonly attempt: number;
  readonly claim_token: string;
  readonly previous_claim_tokens?: readonly string[];
  readonly state: InboxState;
  readonly origin: Delivery["origin"];
  readonly request?: Delivery;
  readonly output?: StructuredOutput;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  readonly updated_at: string;
}

interface InboxFile {
  readonly version: 1;
  readonly deliveries: Record<string, InboxRecord>;
}

interface OutboxFile {
  readonly version: 1;
  readonly pending: readonly DeliveryEvent[];
}

export interface SessionRecord {
  readonly native_id: string;
  readonly initialized: boolean;
}

interface SessionsFile {
  readonly version: 1;
  readonly sessions: Record<string, SessionRecord>;
}

interface FencingFile {
  readonly version: 1;
  readonly epoch: number;
}

export type DeliveryAcceptance = "created" | "retry" | "duplicate" | "stale" | "blocked";

export interface EventCorrelation {
  readonly event_id: string;
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
}

const EMPTY_INBOX: InboxFile = { version: 1, deliveries: {} };
const EMPTY_OUTBOX: OutboxFile = { version: 1, pending: [] };
const EMPTY_SESSIONS: SessionsFile = { version: 1, sessions: {} };
const EMPTY_FENCING: FencingFile = { version: 1, epoch: 0 };

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(fallback);
    throw error;
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const data = `${JSON.stringify(value)}\n`;
  await writeFile(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const handle = await open(temporary, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
  try {
    const directory = await open(dirname(path), fsConstants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some portable filesystems do not permit directory fsync; the atomic rename still applies.
  }
}

function deliveryFingerprint(delivery: Delivery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        delivery_id: delivery.delivery_id,
        message_id: delivery.message_id,
        request_id: delivery.request_id,
        trace_id: delivery.trace_id,
        tenant_id: delivery.tenant_id,
        room_id: delivery.room_id,
        actor_alias: delivery.actor_alias,
        recipient_alias: delivery.recipient_alias,
        origin: delivery.origin,
        authenticated_context: delivery.authenticated_context,
        body: delivery.body,
      }),
    )
    .digest("hex");
}

/**
 * Durable, process-serialized inbox/outbox/session state.
 * Files and directories are owner-only; no prompt or harness output is logged.
 */
export class DurableStore {
  private inbox: InboxFile = clone(EMPTY_INBOX);
  private outbox: OutboxFile = clone(EMPTY_OUTBOX);
  private sessions: SessionsFile = clone(EMPTY_SESSIONS);
  private fencing: FencingFile = clone(EMPTY_FENCING);
  private tail: Promise<void> = Promise.resolve();

  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<DurableStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const store = new DurableStore(directory);
    [store.inbox, store.outbox, store.sessions, store.fencing] = await Promise.all([
      readJson(store.path("inbox.json"), EMPTY_INBOX),
      readJson(store.path("outbox.json"), EMPTY_OUTBOX),
      readJson(store.path("sessions.json"), EMPTY_SESSIONS),
      readJson(store.path("fencing.json"), EMPTY_FENCING),
    ]);
    return store;
  }

  private path(name: string): string {
    return join(this.directory, name);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  get epoch(): number {
    return this.fencing.epoch;
  }

  async activateEpoch(epoch: number): Promise<"same" | "advanced"> {
    return this.serialized(async () => {
      if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new RangeError("Epoch must be positive");
      if (epoch < this.fencing.epoch) {
        throw new RangeError(`Cannot lower fencing epoch from ${this.fencing.epoch} to ${epoch}`);
      }
      if (epoch === this.fencing.epoch) return "same";
      this.fencing = { version: 1, epoch };
      await atomicWrite(this.path("fencing.json"), this.fencing);
      return "advanced";
    });
  }

  async accept(
    delivery: Delivery,
    occurredAt: string,
  ): Promise<{ acceptance: DeliveryAcceptance; record: InboxRecord }> {
    return this.serialized(async () => {
      const existing = this.inbox.deliveries[delivery.delivery_id];
      const fingerprint = deliveryFingerprint(delivery);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error(`delivery_id collision for ${delivery.delivery_id}`);
        }
        if (delivery.attempt < existing.attempt) {
          return { acceptance: "stale", record: clone(existing) };
        }
        if (delivery.attempt === existing.attempt) {
          return {
            acceptance: delivery.claim_token === existing.claim_token ? "duplicate" : "stale",
            record: clone(existing),
          };
        }
        const seenClaims = [...(existing.previous_claim_tokens ?? []), existing.claim_token];
        if (seenClaims.includes(delivery.claim_token)) {
          return { acceptance: "stale", record: clone(existing) };
        }
        if (existing.state !== "failed" || existing.error?.retryable !== true) {
          return { acceptance: "blocked", record: clone(existing) };
        }
      }
      const record: InboxRecord = {
        delivery_id: delivery.delivery_id,
        fingerprint,
        epoch: delivery.epoch,
        attempt: delivery.attempt,
        claim_token: delivery.claim_token,
        ...(existing === undefined
          ? {}
          : { previous_claim_tokens: [...(existing.previous_claim_tokens ?? []), existing.claim_token] }),
        state: "accepted",
        origin: delivery.origin,
        request: delivery,
        updated_at: occurredAt,
      };
      this.inbox = {
        version: 1,
        deliveries: { ...this.inbox.deliveries, [delivery.delivery_id]: record },
      };
      await atomicWrite(this.path("inbox.json"), this.inbox);
      return { acceptance: existing === undefined ? "created" : "retry", record: clone(record) };
    });
  }

  getDelivery(deliveryId: string): InboxRecord | undefined {
    const record = this.inbox.deliveries[deliveryId];
    return record === undefined ? undefined : clone(record);
  }

  pendingDeliveries(): readonly InboxRecord[] {
    return Object.values(this.inbox.deliveries)
      .filter((record) => record.state === "accepted" || record.state === "started")
      .map(clone);
  }

  async transition(
    deliveryId: string,
    state: InboxState,
    occurredAt: string,
    details: {
      readonly output?: StructuredOutput;
      readonly error?: InboxRecord["error"];
      readonly retainRequest?: boolean;
      readonly attempt?: number;
      readonly claimToken?: string;
    } = {},
  ): Promise<InboxRecord> {
    return this.serialized(async () => {
      const existing = this.inbox.deliveries[deliveryId];
      if (existing === undefined) throw new Error(`Unknown delivery ${deliveryId}`);
      if (details.attempt !== undefined && details.attempt !== existing.attempt) {
        throw new Error(`Stale attempt ${details.attempt} for delivery ${deliveryId}`);
      }
      if (details.claimToken !== undefined && details.claimToken !== existing.claim_token) {
        throw new Error(`Stale claim token for delivery ${deliveryId}`);
      }
      const terminal = state === "done" || state === "failed";
      const next: InboxRecord = {
        delivery_id: existing.delivery_id,
        fingerprint: existing.fingerprint,
        epoch: existing.epoch,
        attempt: existing.attempt,
        claim_token: existing.claim_token,
        ...(existing.previous_claim_tokens === undefined
          ? {}
          : { previous_claim_tokens: existing.previous_claim_tokens }),
        state,
        origin: existing.origin,
        ...(!terminal || details.retainRequest === true ? { request: existing.request } : {}),
        ...(details.output === undefined ? {} : { output: details.output }),
        ...(details.error === undefined ? {} : { error: details.error }),
        updated_at: occurredAt,
      };
      this.inbox = {
        version: 1,
        deliveries: { ...this.inbox.deliveries, [deliveryId]: next },
      };
      await atomicWrite(this.path("inbox.json"), this.inbox);
      return clone(next);
    });
  }

  async enqueue(event: DeliveryEvent): Promise<void> {
    await this.serialized(async () => {
      if (this.outbox.pending.some((candidate) => candidate.event_id === event.event_id)) return;
      this.outbox = { version: 1, pending: [...this.outbox.pending, event] };
      await atomicWrite(this.path("outbox.json"), this.outbox);
    });
  }

  pendingEvents(): readonly DeliveryEvent[] {
    return clone(this.outbox.pending);
  }

  async acknowledge(correlation: EventCorrelation): Promise<boolean> {
    return this.serialized(async () => {
      const pending = this.outbox.pending.filter((event) => !sameCorrelation(event, correlation));
      if (pending.length === this.outbox.pending.length) return false;
      this.outbox = { version: 1, pending };
      await atomicWrite(this.path("outbox.json"), this.outbox);
      return true;
    });
  }

  pendingEventsFor(correlation: Pick<EventCorrelation, "delivery_id" | "attempt" | "claim_token">): readonly DeliveryEvent[] {
    return clone(this.outbox.pending.filter((event) => (
      event.delivery_id === correlation.delivery_id
      && event.attempt === correlation.attempt
      && event.claim_token === correlation.claim_token
    )));
  }

  getSession(key: string): SessionRecord | undefined {
    const record = this.sessions.sessions[key];
    return record === undefined ? undefined : clone(record);
  }

  async setSession(key: string, record: SessionRecord): Promise<void> {
    await this.serialized(async () => {
      this.sessions = {
        version: 1,
        sessions: { ...this.sessions.sessions, [key]: record },
      };
      await atomicWrite(this.path("sessions.json"), this.sessions);
    });
  }
}

function sameCorrelation(event: DeliveryEvent, correlation: EventCorrelation): boolean {
  return event.event_id === correlation.event_id
    && event.delivery_id === correlation.delivery_id
    && event.attempt === correlation.attempt
    && event.claim_token === correlation.claim_token;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Cross-process guard for one long-lived consumer per stable alias. */
export class ConsumerLease {
  private constructor(
    private readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  static async acquire(stateDirectory: string, alias: string, instanceId: string): Promise<ConsumerLease> {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(stateDirectory, `.consumer-${alias}.lock`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, instance_id: instanceId })}\n`, "utf8");
        await handle.sync();
        return new ConsumerLease(path, handle);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
          stale = typeof parsed.pid !== "number" || !pidIsAlive(parsed.pid);
        } catch {
          const age = await stat(path)
            .then((metadata) => Date.now() - metadata.mtimeMs)
            .catch(() => 0);
          stale = age > 30_000;
        }
        if (!stale) {
          throw new ConsumerLeaseError(`A consumer already owns stable alias '${alias}'`);
        }
        await unlink(path).catch(() => undefined);
      }
    }
    throw new ConsumerLeaseError(`Could not acquire consumer lease for '${alias}'`);
  }

  async release(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    await unlink(this.path).catch(() => undefined);
  }
}
