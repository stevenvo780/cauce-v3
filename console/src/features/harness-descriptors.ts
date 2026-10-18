/** One published descriptor, as bundled from packages/adapter-sdk/descriptors. */
export interface PublishedHarnessDescriptor {
  readonly harness: string;
  readonly context?: {
    readonly native_document?: string;
  };
  readonly provider?: {
    readonly authenticate_argv?: readonly string[];
    readonly verify_argv?: readonly string[];
    readonly fleet_module?: string | null;
  };
}

const HARNESS_ID = /^[a-z][a-z0-9_-]{0,63}$/u;

function isPublishedHarnessDescriptor(value: unknown): value is PublishedHarnessDescriptor {
  if (value === null || typeof value !== 'object' || !('harness' in value)) return false;
  return typeof value.harness === 'string' && HARNESS_ID.test(value.harness);
}

const loaded = import.meta.glob(
  '../../../packages/adapter-sdk/descriptors/*.json',
  { eager: true, import: 'default' },
);

/** Every descriptor JSON in the package. A new file appears here without editing an import list. */
export const PUBLISHED_HARNESS_DESCRIPTORS: readonly PublishedHarnessDescriptor[] = Object.values(loaded)
  .filter(isPublishedHarnessDescriptor)
  .sort((left, right) => (left.harness < right.harness ? -1 : left.harness > right.harness ? 1 : 0));
