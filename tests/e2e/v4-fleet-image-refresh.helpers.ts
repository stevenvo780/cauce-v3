import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll } from 'vitest';

const execute = promisify(execFile);
const OWNER = 'f4-flota-server2-1025';

async function docker(args: string[]): Promise<string> {
  return (await execute('docker', args, { timeout: 120_000 })).stdout.trim();
}

export function imageRefreshFixture(): (name: string, image?: 'good' | 'bad') => Promise<Record<string, unknown>> {
  const prefix = `zz-canary-${OWNER}-image-${randomUUID().slice(0, 8)}`;
  const evidence = join(process.cwd(), '.delegados/v4/recibos', OWNER, 'image-refresh', prefix);
  let directory = '';
  const images: Record<string, string> = {};
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), prefix));
    await chmod(directory, 0o755);
    await mkdir(evidence, { recursive: true });
    for (const revision of ['old', 'good', 'bad']) {
      const file = join(directory, `Dockerfile-${revision}`);
      await writeFile(file, `FROM python:3.12-slim\nLABEL cauce.e2e.owner="${OWNER}" revision=${revision}\n`
        + (revision === 'bad' ? 'RUN rm /bin/sleep\n' : ''));
      await docker(['build', '-q', '-f', file, '-t', `${prefix}:${revision}`, directory]);
      images[revision] = await docker(['image', 'inspect', '--format', '{{.Id}}', `${prefix}:${revision}`]);
    }
  }, 240_000);
  afterAll(async () => {
    for (const revision of ['old', 'good', 'bad']) await docker(['image', 'rm', `${prefix}:${revision}`]);
    await rm(directory, { recursive: true, force: true });
  });
  return async (name, image = 'good') => {
    const work = join(directory, name);
    await mkdir(work);
    const result = await execute('python3', ['-B', 'tests/e2e/v4-fleet-image-refresh.driver.py', work, `${prefix}-${name}`, images.old ?? '', images[image] ?? '', name],
      { timeout: 120_000, maxBuffer: 1024 * 1024 });
    await writeFile(join(evidence, `${name}.stderr.log`), result.stderr);
    await writeFile(join(evidence, `${name}.json`), result.stdout);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
}
