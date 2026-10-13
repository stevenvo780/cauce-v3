import { createHash } from 'node:crypto';

const EXHAUSTED = /all predefined address pools have been fully subnetted|could not find an available, non-overlapping/iu;
const OVERLAP = /overlap|pool overlaps|conflicts with network/iu;

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} ${error.cause.message}` : error.message;
}

/**
 * Creates a docker network and returns its id. When the daemon's default pools are used up (many e2e suites on one
 * host), it retries on explicit /24 subnets of 10.213.0.0/16 chosen from the network name, skipping overlaps.
 */
export async function createNetworkWithFallback(run: (args: readonly string[]) => Promise<string>,
  createArgs: readonly string[], name: string): Promise<string> {
  try { return (await run(['network', 'create', ...createArgs, name])).trim(); } catch (error) {
    if (!EXHAUSTED.test(describe(error))) throw error;
  }
  const start = createHash('sha256').update(name).digest().readUInt8(0);
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const octet = (start + attempt) % 256;
    try {
      return (await run(['network', 'create', '--subnet', `10.213.${String(octet)}.0/24`, ...createArgs, name])).trim();
    } catch (error) {
      if (!OVERLAP.test(describe(error))) throw error;
    }
  }
  throw new Error(`no free /24 in 10.213.0.0/16 for docker network ${name}`);
}
