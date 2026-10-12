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
import type { NativeContextIngest } from '../context-ingest-client.js';
import { ingestLocalContextEdits, readSpaceContextStateVersion } from './native-context-ingest.js';

const spaceTurns = new Map<string, Promise<void>>();
export class VersionedContextTurn {
  private reservation: SessionReservation | undefined;
  private materialized: SpaceContextWriteResult | undefined;
  private effective: VersionedContext | undefined;
  constructor(readonly root: string | undefined = process.env.CAUCE_SPACE_ROOT,
    private readonly ingest: NativeContextIngest | undefined = undefined) {}
  get effectiveContext(): VersionedContext | undefined { return this.effective; }
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
      if (this.ingest !== undefined) {
        validateVersionedContext(delivery, tenant);
        this.effective = await ingestLocalContextEdits(this.root, canonicalVersionedContext(delivery.versioned_context), this.ingest);
      }
      const effectiveDelivery = this.effective === undefined ? delivery : { ...delivery, versioned_context: this.effective };
      this.materialized = await materializeVersionedContext(effectiveDelivery, tenant, harness, { CAUCE_SPACE_ROOT: this.root });
    } finally { this.release(); }
  }
  async verify(): Promise<void> {
    if (this.materialized === undefined || this.root === undefined) return;
    await this.acquire(new AbortController().signal);
    try {
      const currentVersion = await readSpaceContextStateVersion(this.root);
      if (currentVersion !== undefined && currentVersion > this.materialized.version) return;
      try {
        for (const document of this.materialized.documents) {
          if (!(await lstat(document.path)).isFile() || await realpath(document.path) !== document.path
              || createHash('sha256').update(await readFile(document.path)).digest('hex') !== document.sha256) throw new Error('Materialized context differs');
        }
      } catch { throw new AdapterError('VERSIONED_CONTEXT_CHANGED', 'Materialized versioned context changed during the turn', false); }
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
  return writeSpaceContext(root, { ...descriptor, context: { ...descriptor.context, native_document: 'none' } }, context);
}
