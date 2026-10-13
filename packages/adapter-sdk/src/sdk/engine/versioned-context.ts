import { canonicalVersionedContext } from '../../context/versioned-context-files.js';
import { packagedHarnessDescriptor } from '../../context/harness-descriptor.js';
import { writeSpaceContext, type SpaceContextWriteResult } from '../../context/space-layout.js';
import type { Delivery, HarnessId } from '../types.js';
import { AdapterError } from '../errors.js';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { SessionReservation } from '../../harnesses/shared/session-reservation.js';
import type { VersionedContext } from '@cauce/protocol';
import type { HarnessRequestContext } from '../../contracts/harness.js';
import type { NativeContextIngest } from '../context-ingest-client.js';
import { ingestLocalContextEdits, quarantineDivergedContextFiles, readSpaceContextStateVersion } from './native-context-ingest.js';

export interface MaterializationDegradation {
  readonly code: 'native_context_conflict' | 'local_context_quarantined' | 'context_too_large' | 'context_superseded';
  readonly paths: readonly string[];
}

const spaceTurns = new Map<string, Promise<void>>();
export class VersionedContextTurn {
  private reservation: SessionReservation | undefined;
  private materialized: SpaceContextWriteResult | undefined;
  private effective: VersionedContext | undefined;
  private baseContext: VersionedContext | undefined;
  private turnDelivery: Delivery | undefined;
  private turnTenant: string | undefined;
  private turnHarness: HarnessId | undefined;
  private degraded: MaterializationDegradation | undefined;
  private readonly ignored: string[] = [];
  constructor(readonly root: string | undefined = process.env.CAUCE_SPACE_ROOT,
    private readonly ingest: NativeContextIngest | undefined = undefined) {}
  get effectiveContext(): VersionedContext | undefined { return this.effective; }
  get materializationDegraded(): MaterializationDegradation | undefined { return this.degraded; }
  takeMaterializationDegraded(): MaterializationDegradation | undefined {
    const degraded = this.degraded; this.degraded = undefined; return degraded;
  }
  get materializedVersion(): number | undefined { return this.materialized?.version; }
  get materializedDigest(): string | undefined { return this.materialized?.digest; }
  get ignoredPaths(): readonly string[] { return this.ignored; }
  private async acquire(signal: AbortSignal): Promise<void> {
    const root = this.root;
    if (root === undefined) return;
    if (!isAbsolute(root) || resolve(root) !== root || root === '/') throw new AdapterError('INVALID_VERSIONED_CONTEXT', 'Space root must be a canonical absolute directory', false);
    const previous = spaceTurns.get(root) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const completed = new Promise<void>(resolveCompleted => { release = resolveCompleted; });
    const tail = previous.catch(() => undefined).then(() => completed);
    spaceTurns.set(root, tail);
    void tail.finally(() => { if (spaceTurns.get(root) === tail) spaceTurns.delete(root); });
    this.reservation = new SessionReservation(root, previous, release);
    try { await this.reservation.wait(signal); } catch (error) { this.release(); throw error; }
  }
  release(): void { this.reservation?.release(); this.reservation = undefined; }
  async materialize(delivery: Delivery, tenant: string | undefined, harness: HarnessId, signal?: AbortSignal): Promise<void> {
    if (this.root === undefined || delivery.versioned_context === undefined) {
      this.materialized = await materializeVersionedContext(delivery, tenant, harness, { CAUCE_SPACE_ROOT: this.root });
      return;
    }
    await this.acquire(signal ?? new AbortController().signal);
    try {
      validateVersionedContext(delivery, tenant);
      const base = canonicalVersionedContext(delivery.versioned_context);
      const stateVersion = await readSpaceContextStateVersion(this.root);
      if (stateVersion !== undefined && stateVersion > base.version) {
        this.degraded = { code: 'context_superseded', paths: [] };
        return;
      }
      if (this.ingest !== undefined) {
        try {
          this.effective = await ingestLocalContextEdits(this.root, base, this.ingest, paths => { this.ignored.push(...paths); });
        } catch (error) {
          if (error instanceof AdapterError && (error.code === 'VERSIONED_CONTEXT_CONFLICT'
            || error.code === 'VERSIONED_CONTEXT_CHANGED' || error.code === 'VERSIONED_CONTEXT_INGEST_REJECTED')) {
            const paths = await quarantineDivergedContextFiles(this.root, base);
            this.degraded = { code: error.code === 'VERSIONED_CONTEXT_CONFLICT' ? 'native_context_conflict' : 'local_context_quarantined', paths };
          } else throw error;
        }
      }
      this.baseContext = this.effective ?? base;
      this.turnDelivery = delivery; this.turnTenant = tenant; this.turnHarness = harness;
      const effectiveDelivery = this.effective === undefined ? delivery : { ...delivery, versioned_context: this.effective };
      try {
        this.materialized = await materializeVersionedContext(effectiveDelivery, tenant, harness, { CAUCE_SPACE_ROOT: this.root });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'context exceeds harness document limit') {
          this.degraded = { code: 'context_too_large', paths: [] };
        } else if (message.includes('edited locally')) {
          const paths = await quarantineDivergedContextFiles(this.root, this.baseContext);
          this.degraded ??= { code: 'local_context_quarantined', paths };
          try {
            this.materialized = await materializeVersionedContext(effectiveDelivery, tenant, harness, { CAUCE_SPACE_ROOT: this.root });
          } catch (retryError) {
            const retryMessage = retryError instanceof Error ? retryError.message : '';
            if (retryMessage === 'context exceeds harness document limit') this.degraded = { code: 'context_too_large', paths: [] };
            else if (!retryMessage.includes('edited locally')) throw retryError;
          }
        } else throw error;
      }
    } finally { this.release(); }
  }
  private async documentsChanged(): Promise<boolean> {
    if (this.materialized === undefined) return false;
    try {
      for (const document of this.materialized.documents) {
        if (!(await lstat(document.path)).isFile() || await realpath(document.path) !== document.path
            || createHash('sha256').update(await readFile(document.path)).digest('hex') !== document.sha256) return true;
      }
      return false;
    } catch { return true; }
  }
  async verify(): Promise<void> {
    if (this.materialized === undefined || this.root === undefined) return;
    await this.acquire(new AbortController().signal);
    try {
      const currentVersion = await readSpaceContextStateVersion(this.root);
      if (currentVersion !== undefined && currentVersion > this.materialized.version) return;
      const changed = await this.documentsChanged();
      if (this.ingest === undefined || this.baseContext === undefined || this.turnDelivery === undefined || this.turnHarness === undefined) {
        if (changed) throw new AdapterError('VERSIONED_CONTEXT_CHANGED', 'Materialized versioned context changed during the turn', false);
        return;
      }
      let effective: VersionedContext | undefined;
      try {
        effective = await ingestLocalContextEdits(this.root, this.baseContext, this.ingest, paths => { this.ignored.push(...paths); });
      } catch (error) {
        if (error instanceof AdapterError && (error.code === 'VERSIONED_CONTEXT_CONFLICT'
          || error.code === 'VERSIONED_CONTEXT_CHANGED' || error.code === 'VERSIONED_CONTEXT_INGEST_REJECTED')) {
          const paths = await quarantineDivergedContextFiles(this.root, this.baseContext);
          this.degraded ??= { code: error.code === 'VERSIONED_CONTEXT_CONFLICT' ? 'native_context_conflict' : 'local_context_quarantined', paths };
        } else throw error;
      }
      if (effective !== undefined) this.effective = effective;
      if (effective !== undefined || changed) {
        const snapshot = this.effective ?? this.baseContext;
        try {
          this.materialized = await materializeVersionedContext(
            { ...this.turnDelivery, versioned_context: snapshot }, this.turnTenant, this.turnHarness, { CAUCE_SPACE_ROOT: this.root });
          this.baseContext = snapshot;
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (message === 'context exceeds harness document limit') this.degraded = { code: 'context_too_large', paths: [] };
          else if (message.includes('edited locally')) {
            const paths = await quarantineDivergedContextFiles(this.root, snapshot);
            this.degraded ??= { code: 'local_context_quarantined', paths };
            this.materialized = await materializeVersionedContext(
              { ...this.turnDelivery, versioned_context: snapshot }, this.turnTenant, this.turnHarness, { CAUCE_SPACE_ROOT: this.root })
              .catch(() => undefined);
          } else throw error;
        }
      }
    } finally { this.release(); }
  }
}

export function validateVersionedContext(delivery: Delivery, tenant: string | undefined): void {
  const raw = delivery.versioned_context;
  if (raw === undefined) return;
  const context = canonicalVersionedContext(raw);
  if (context.tenant_id !== (tenant ?? delivery.tenant_id) || context.alias !== delivery.recipient_alias
    || (delivery.company_context !== undefined && delivery.company_context.company_id !== context.company_id)) throw new AdapterError('INVALID_VERSIONED_CONTEXT', 'Versioned context scope or digest differs', false);
}
export async function materializeVersionedContext(delivery: Delivery, tenant: string | undefined, harness: HarnessId,
  environment: NodeJS.ProcessEnv = process.env): Promise<SpaceContextWriteResult | undefined> {
  validateVersionedContext(delivery, tenant);
  const context = delivery.versioned_context; const root = environment.CAUCE_SPACE_ROOT;
  if (context === undefined || root === undefined) return;
  const descriptor = await packagedHarnessDescriptor(harness);
  return writeSpaceContext(root, descriptor, context);
}

export interface VersionedContextDeliveryInput {
  readonly spaceRoot: string | undefined;
  readonly materializedVersion: number | undefined;
  readonly materializedDigest: string | undefined;
  readonly degraded: boolean;
  readonly context: VersionedContext;
  readonly maxBytes: number;
  readonly nativeDocument: string;
  /** Session already received this version and digest inline. Without a session key it is never true. */
  readonly sessionHasContent: boolean;
}

/**
 * References replace content only with proof the agent already holds it: the space has the same
 * version and digest, the harness got the content inline earlier in this session, and nothing
 * degraded. The harness cwd is not necessarily the space root, so relative paths prove nothing.
 */
export function versionedContextDelivery(input: VersionedContextDeliveryInput): NonNullable<HarnessRequestContext['versioned_context_delivery']> {
  const materialized = input.spaceRoot !== undefined && !input.degraded && input.sessionHasContent
    && input.materializedVersion === input.context.version && input.materializedDigest === input.context.digest;
  return { materialized, max_bytes: input.maxBytes,
    ...(input.spaceRoot === undefined ? {} : { space_root: input.spaceRoot }),
    ...(input.nativeDocument === 'none' ? {} : { native_document: input.nativeDocument }) };
}

export function contextSentKey(sessionKey: string | undefined, alias: string, context: VersionedContext): string {
  return `${sessionKey ?? ''}|${alias}|${String(context.version)}|${context.digest}`;
}
