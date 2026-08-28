import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publisher = join(repository, 'ops/pty-agent/publish-alias-key.sh');
const scratch: string[] = [];

const MASTER_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const GOLDEN_JARVIS = '33ab99cc766ee43031f9c22b8db78aeae5b04bc0ebedddfe8539330af7233efa';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-pub-alias-key-'));
  scratch.push(directory);
  const masterFile = join(directory, 'master.b64');
  await import('node:fs/promises').then((fs) => fs.writeFile(masterFile, `${MASTER_B64}\n`, 'utf8'));
  await chmod(masterFile, 0o400);
  const output = join(directory, 'issued');
  return { directory, masterFile, output };
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('publish alias key script', () => {
  test('publishes alias-key.hex with mode 0400 from master file', async () => {
    const { masterFile, output } = await fixture();
    const result = spawnSync('bash', [
      publisher,
      '--tenant', 'Steven',
      '--alias', 'jarvis',
      '--output-dir', output,
      '--master-file', masterFile,
    ], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('alias key publishing passed');

    const keyPath = join(output, 'alias-key.hex');
    const keyStat = await stat(keyPath);
    expect(keyStat.mode & 0o777).toBe(0o400);

    const content = (await readFile(keyPath, 'utf8')).trim();
    expect(content).toBe(GOLDEN_JARVIS);
  });

  test('publishes alias-key.hex via environment variable', async () => {
    const { output } = await fixture();
    const result = spawnSync('bash', [
      publisher,
      '--tenant', 'Steven',
      '--alias', 'jarvis',
      '--output-dir', output,
      '--master-env', 'CUSTOM_MASTER_ENV',
    ], {
      env: { ...process.env, CUSTOM_MASTER_ENV: MASTER_B64 },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const keyPath = join(output, 'alias-key.hex');
    const content = (await readFile(keyPath, 'utf8')).trim();
    expect(content).toBe(GOLDEN_JARVIS);
  });

  test('refuses overwrite and preserves existing key', async () => {
    const { masterFile, output } = await fixture();
    const first = spawnSync('bash', [
      publisher,
      '--tenant', 'Steven',
      '--alias', 'jarvis',
      '--output-dir', output,
      '--master-file', masterFile,
    ], { encoding: 'utf8' });
    expect(first.status).toBe(0);

    const keyPath = join(output, 'alias-key.hex');
    const before = await readFile(keyPath, 'utf8');

    const second = spawnSync('bash', [
      publisher,
      '--tenant', 'Steven',
      '--alias', 'jarvis',
      '--output-dir', output,
      '--master-file', masterFile,
    ], { encoding: 'utf8' });

    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already exists');
    expect(await readFile(keyPath, 'utf8')).toBe(before);
  });
});
