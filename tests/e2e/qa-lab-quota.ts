import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURE_PROVIDER_IDENTITY } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import type { DatabasePool } from '@cauce/store';
import { prepareFake2QuotaImage } from './v4-cuotas-fake2.fixtures.js';
import { startQuotaDockerHost } from './v4-quota-environments-real-browser.fixtures.js';

/**
 * The synthetic quota readers of the exploration laboratory, approved the way production approves the real ones:
 * a descriptor approval for the gateway (agent quota) and a quota environment host whose policy names an image and a
 * pinned bundle (quota environments). Nothing here reads a real provider.
 */
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** The reader baked into the agent image at the path the codex descriptor names; modes: normal, exhausted, broken. */
export const QA_CODEX_QUOTA_PROBE = `#!/usr/local/bin/python3
import datetime, json, os, pathlib, sys
# The runtime root is read-only; its dedicated profile mount is the one place the operator can flip the mode.
mode_file = pathlib.Path('/home/cauce/.cauce-profiles/.qa-quota-mode')
mode = mode_file.read_text().strip() if mode_file.exists() else 'normal'
now = datetime.datetime.now(datetime.UTC)
def instant(delta):
    return (now + delta).isoformat().replace('+00:00', 'Z')
if mode == 'broken':
    print('not json')
    sys.exit(0)
five = {'key': 'five-hour', 'limitId': 'default', 'windowMinutes': 300, 'remainingPercent': 72, 'usedPercent': 28,
        'resetAt': instant(datetime.timedelta(hours=3, minutes=20)), 'status': 'ok'}
week = {'key': 'seven-day', 'limitId': 'default', 'windowMinutes': 10080, 'remainingPercent': 91, 'usedPercent': 9,
        'resetAt': instant(datetime.timedelta(days=4, hours=2)), 'status': 'ok'}
if mode == 'exhausted':
    five.update(remainingPercent=0, usedPercent=100, status='exhausted', resetAt=instant(datetime.timedelta(hours=1, minutes=25)))
print(json.dumps({'ok': True, 'available': True, 'extra': {'account_id': ${JSON.stringify(FIXTURE_PROVIDER_IDENTITY)}}, 'windows': [five, week]}))
`;

export interface QaLabQuota {
  readonly hostId: string;
  close(): Promise<void>;
}

/** The agents' reader is approved by the descriptor pin, never by the image: publish the public approvals file. */
export async function approveQaCodexQuotaReader(directory: string): Promise<void> {
  const descriptors = join(process.cwd(), 'packages/adapter-sdk/descriptors');
  const approvals = join(directory, 'agent-quota-approvals.json');
  await writeFile(approvals, JSON.stringify({ codex: sha(await readFile(join(descriptors, 'codex.json'))) }), { mode: 0o600 });
  process.env.CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE = approvals;
  process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY = descriptors;
}

export async function startQaLabQuota(options: {
  prefix: string; pool: DatabasePool; email: string; accountId: string; origin: string; ca: string;
  directory: string; computerImage: string; rawDockerSocket: string;
}): Promise<QaLabQuota> {
  const { prefix, pool, email, accountId, origin, ca, directory } = options;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await approveQaCodexQuotaReader(directory);
  // The agent reader reports FIXTURE_PROVIDER_IDENTITY; the account carries the hash the executor derives from it.
  await pool.query('UPDATE provider_accounts SET quota_identity_hash=$2 WHERE id=$1', [accountId,
    sha(JSON.stringify(['codex', FIXTURE_PROVIDER_IDENTITY]))]);
  const image = await prepareFake2QuotaImage(directory, prefix, 'qa0-entorno-exploracion-1025',
    'https://example.invalid/fake2', { baseImage: options.computerImage });
  process.env.CAUCE_QUOTA_DOCKER_HOST = `unix://${options.rawDockerSocket}`;
  const hostId = `${prefix}-quota`;
  const owner = { email, name: prefix, password: '', company: { name: prefix, slug: prefix } };
  const fixture = { database: { pool }, baseUrl: origin, pki: { ca: { cert: ca } } };
  const host = await startQuotaDockerHost(fixture as never, owner, hostId, image, directory);
  return { hostId, close: async () => { await host.close(); } };
}
