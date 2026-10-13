import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentQuotaDescriptorModuleUrl } from '../agent-quota-operations-model.js';
import { ConfigurationError } from './contracts.js';

/**
 * Closed vocabulary of harness_definitions.capabilities. The strings are rendered into agent
 * profile facts, so a new one is a deliberate edit here; ops/tests/test_harness_parity.py reads
 * this list to check the migration seeds.
 */
export const HARNESS_CATALOG_CAPABILITIES: readonly string[] = Object.freeze([
  'messages.receive', 'ack.timeline', 'origin.relay', 'jobs.interactive', 'jobs.batch',
]);

type PublishedDescriptorReader = (directory: URL, harness: string) => Promise<{ readonly harness: string }>;

/** The fields a catalog write sets; absent (undefined) fields keep their stored value. */
export interface HarnessCatalogChange {
  readonly command?: unknown;
  readonly capabilities?: unknown;
}

function reject(field: string, reason: string): never {
  throw new ConfigurationError('invalid_input', `harness.${field}: ${reason}`);
}

async function publishedReader(source?: string): Promise<{ read: PublishedDescriptorReader; directory: URL }> {
  const configured = process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY;
  if (configured !== undefined && !isAbsolute(configured)) {
    reject('id', 'CAUCE_HARNESS_DESCRIPTOR_DIRECTORY must be an absolute path to the published descriptors');
  }
  const sdkUrl = agentQuotaDescriptorModuleUrl(source);
  let sdk: unknown;
  try { sdk = await import(sdkUrl.href); } catch { sdk = undefined; }
  if (sdk === null || typeof sdk !== 'object' || !('publishedHarnessDescriptor' in sdk)
    || typeof sdk.publishedHarnessDescriptor !== 'function') {
    reject('id', 'the published harness descriptor catalog is unavailable');
  }
  return { read: sdk.publishedHarnessDescriptor as PublishedDescriptorReader,
    directory: configured === undefined ? new URL('../../descriptors/', sdkUrl) : pathToFileURL(`${configured}/`) };
}

/**
 * The harness catalog only names harnesses whose descriptor is published: the descriptor, not a
 * database row, decides how a harness is installed, run and authenticated. `command` stays null
 * because no descriptor declares one (the adapter runs its packaged executable), and capabilities
 * come from the closed vocabulary.
 */
export async function assertPublishedHarnessDefinition(id: string, change: HarnessCatalogChange,
  source?: string): Promise<void> {
  const { read, directory } = await publishedReader(source);
  try {
    await read(directory, id);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const reason = code === 'ENOENT' ? 'no published descriptor declares this harness'
      : `its published descriptor is invalid (${error instanceof Error ? error.message : 'unreadable'})`;
    reject('id', `'${id}': ${reason}; add packages/adapter-sdk/descriptors/${id}.json and follow the parity list first`);
  }
  if (change.command !== undefined && change.command !== null) {
    reject('command', 'the published descriptor declares no command; the adapter runs its packaged executable, so it must be null');
  }
  if (change.capabilities !== undefined) {
    if (!Array.isArray(change.capabilities)) reject('capabilities', 'must be a list of capabilities');
    if (change.capabilities.length === 0) reject('capabilities', 'at least one capability is required');
    const seen = new Set<string>();
    for (const capability of change.capabilities) {
      if (typeof capability !== 'string' || !HARNESS_CATALOG_CAPABILITIES.includes(capability)) {
        reject('capabilities', `'${String(capability)}' is outside the closed vocabulary (${HARNESS_CATALOG_CAPABILITIES.join(', ')})`);
      }
      if (seen.has(capability)) reject('capabilities', `'${capability}' is repeated`);
      seen.add(capability);
    }
  }
}
