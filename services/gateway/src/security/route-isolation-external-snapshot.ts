import { parseJson, type ExternalClient, type ExternalSession } from './route-isolation-external-client.js';
import type { CanaryState } from './route-isolation-external-canary.js';

/** Company B as its own owner sees it, flattened to path → value so one changed field names itself. */
export type Snapshot = ReadonlyMap<string, string>;

export function snapshotRoutes(b: CanaryState, terminal = false): string[] {
  return [`/v3/console/companies/${b.slug}`, `/v3/console/companies/${b.slug}/admins`, '/v3/console/people', '/v3/console/config',
    '/v3/console/office/layout', '/v3/console/preferences', '/v3/console/quota-accounts', '/v3/console/quota-environments',
    '/v3/console/fleet/hosts', '/v3/console/fleet/hosts/enrollments', '/v3/console/agents', '/v3/console/agent-preferences',
    '/v3/console/mcp/client-delegations', '/v3/console/fleet/operations/recent', ...(b.blob === undefined ? [] : [`/v3/blobs/${b.blob}`]),
    ...(terminal ? ['/v3/console/terminal/grants', '/v3/console/terminal/sessions'] : [])];
}

function flatten(prefix: string, value: unknown, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    out.set(`${prefix}#length`, String(value.length));
    value.forEach((item, index) => { flatten(`${prefix}[${String(index)}]`, item, out); });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, field] of Object.entries(value)) flatten(`${prefix}.${key}`, field, out);
  } else out.set(prefix, JSON.stringify(value));
}

export async function readSnapshot(client: ExternalClient, session: ExternalSession, b: CanaryState, terminal = false): Promise<Snapshot> {
  const out = new Map<string, string>();
  for (const route of snapshotRoutes(b, terminal)) {
    const response = await client.send('GET', route, { session });
    out.set(`${route} status`, String(response.status));
    const parsed = parseJson(response.body);
    if (parsed === undefined) out.set(`${route} body`, response.body);
    else flatten(route, parsed, out);
  }
  return out;
}

/** Paths that differ between two reads with nothing in between: clocks and observation stamps. */
export function volatilePaths(first: Snapshot, second: Snapshot): Set<string> {
  return new Set([...new Set([...first.keys(), ...second.keys()])].filter(key => first.get(key) !== second.get(key)));
}

export function compareSnapshots(before: Snapshot, after: Snapshot, volatile: ReadonlySet<string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter(key => !volatile.has(key) && before.get(key) !== after.get(key));
}
