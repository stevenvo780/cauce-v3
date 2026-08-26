import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const repository = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const policy = join(repository, 'ops/scripts/validate-console-browser-storage.mjs');
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(async (entry) => rm(entry, { recursive: true, force: true })));
});

async function check(source: string): Promise<ReturnType<typeof spawnSync>> {
  const root = await mkdtemp(join(tmpdir(), 'cauce-console-storage-policy-'));
  scratch.push(root);
  await writeFile(join(root, 'fixture.ts'), source);
  return spawnSync(process.execPath, [policy, root], { cwd: repository, encoding: 'utf8' });
}

describe('console durable browser-storage policy', () => {
  it('accepts memory-only state and ignores explanatory comments', async () => {
    const result = await check(`
      // localStorage, sessionStorage, indexedDB and CacheStorage are deliberately absent.
      const ephemeral = new Map<string, unknown>();
      ephemeral.set('intent', { pending: true });
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('browser durable storage policy passed');
  });

  it.each([
    ['Web Storage', 'void globalThis.localStorage; void window.sessionStorage;'],
    ['IndexedDB', 'void globalThis.indexedDB;'],
    ['computed IndexedDB', "void globalThis['indexedDB'];"],
    ['CacheStorage', 'void globalThis.caches;'],
    ['OPFS', 'void navigator.storage.getDirectory();'],
    ['computed OPFS', "void navigator.storage['getDirectory']();"],
    ['aliased OPFS', "const storage = navigator.storage; void storage['getDirectory']();"],
    ['destructured OPFS', 'const { storage } = navigator; void storage.getDirectory();'],
    ['script-readable cookies', 'document.cookie = "journal=opaque";'],
    ['aliased cookies', 'const d = document; d.cookie = "journal=opaque";'],
    ['destructured cookies', 'const { cookie } = document; void cookie;'],
    ['aliased global storage', 'const global = globalThis; void global.indexedDB;'],
  ])('rejects %s before it can become a console journal', async (_name, source) => {
    const result = await check(source);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('browser durable storage usage is forbidden');
  });
});
