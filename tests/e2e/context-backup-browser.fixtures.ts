import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';

// Gateway configuration reads process.env during startup; callers must serialize fixture creation.
export async function startContextBackupFixture(): Promise<Awaited<ReturnType<typeof startConsoleFunctionalFixture>>> {
  const directory = await mkdtemp(join(tmpdir(), 'zz-canary-e2e-copias-404-1025-'));
  const previous = process.env.CAUCE_SPACE_BACKUP_DIRECTORY;
  process.env.CAUCE_SPACE_BACKUP_DIRECTORY = directory;
  try {
    const fixture = await startConsoleFunctionalFixture();
    return { ...fixture, close: async () => {
      try { await fixture.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    } };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (previous === undefined) delete process.env.CAUCE_SPACE_BACKUP_DIRECTORY;
    else process.env.CAUCE_SPACE_BACKUP_DIRECTORY = previous;
  }
}
