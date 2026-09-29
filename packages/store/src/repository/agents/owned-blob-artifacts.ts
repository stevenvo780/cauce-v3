import { parseBlobArtifactUri } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { sourceCanReadBlob } from '../blob-entitlements.js';
import type { ArtifactRef } from './delegated-attachments.js';

export async function filterOwnedBlobArtifactRefs(
  client: DatabaseClient,
  refs: readonly ArtifactRef[],
  sourceTenant: string,
  sourceAlias: string,
): Promise<{ refs: ArtifactRef[]; dropped: number }> {
  const retained: ArtifactRef[] = [];
  let dropped = 0;
  for (const ref of refs) {
    const sha256 = parseBlobArtifactUri(ref.uri);
    if (sha256 === undefined || await sourceCanReadBlob(client, sourceTenant, sourceAlias, sha256)) {
      retained.push(ref);
    } else {
      dropped += 1;
    }
  }
  return { refs: retained, dropped };
}
