import { parseBlobArtifactUri, parseBlobLocator } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { grantBlobForDelivery } from './blob-entitlements.js';
import { StoreError } from './errors.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function referencedBlobDigests(body: unknown): string[] {
  const message = record(body);
  if (message === undefined) return [];
  const digests = new Set<string>();
  for (const field of ['attachments_v1', 'artifacts_v1'] as const) {
    const entries = message[field];
    if (!Array.isArray(entries)) continue;
    for (const candidate of entries) {
      const entry = record(candidate);
      if (entry === undefined) continue;
      const digest = parseBlobLocator(entry.blob) ?? parseBlobArtifactUri(entry.uri);
      if (digest !== undefined) digests.add(digest);
    }
  }
  return [...digests];
}

export async function grantCarriedBlobs(
  client: DatabaseClient,
  input: {
    readonly body: unknown;
    readonly sourceTenant: string;
    readonly sourceAlias: string;
    readonly targetTenant: string;
    readonly targetAlias: string;
    readonly deliveryId: string;
  },
): Promise<void> {
  for (const sha256 of referencedBlobDigests(input.body)) {
    const granted = await grantBlobForDelivery(client, {
      sha256,
      sourceTenant: input.sourceTenant,
      sourceAlias: input.sourceAlias,
      targetTenant: input.targetTenant,
      targetAlias: input.targetAlias,
      deliveryId: input.deliveryId,
    });
    if (!granted) throw new StoreError('forbidden', 'blob reference is unavailable');
  }
}
