export type HarnessId = 'openclaw' | 'claude' | 'hermes' | 'codex' | 'opencode';

export interface AliasManifest {
  alias: string;
  harness: HarnessId;
  tenant: string;
  room: string;
  path: string;
  sha256: string;
}

export const EXPECTED_ALIAS_COUNT: 12;
export const EXPECTED_HARNESS_COUNTS: Readonly<Record<HarnessId, number>>;
export const HARNESS_IDS: readonly HarnessId[];
export function readAliasManifest(manifestPath: string): Promise<AliasManifest>;
export function readFleetManifests(directory: string): Promise<AliasManifest[]>;
export function validateFleetMatrix(manifests: readonly AliasManifest[]): {
  aliases: string[];
  counts: Record<HarnessId, number>;
};
