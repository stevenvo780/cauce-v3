import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const viteEntry = path.join(projectRoot, 'console/node_modules/vite/bin/vite.js');
const helperUrl = new URL('../../console/qa/layout-dev-server.mjs', import.meta.url).href;

interface LayoutServer {
  origin: string;
  pid: number;
  close: () => Promise<void>;
}

type StartLayoutDevServer = (options: { root: string; viteEntry: string }) => Promise<LayoutServer>;

async function startLayoutDevServer(options: { root: string; viteEntry: string }): Promise<LayoutServer> {
  const helper = await import(helperUrl) as { startLayoutDevServer: StartLayoutDevServer };
  return helper.startLayoutDevServer(options);
}

describe('isolated layout dev servers', () => {
  let scratch: string;
  let alphaRoot: string;
  let betaRoot: string;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'cauce-layout-servers-'));
    alphaRoot = path.join(scratch, 'alpha');
    betaRoot = path.join(scratch, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await Promise.all([
      writeFile(path.join(alphaRoot, 'index.html'), '<main>alpha-source</main>'),
      writeFile(path.join(betaRoot, 'index.html'), '<main>beta-source</main>'),
    ]);
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('serves each root on its own port and reaps only the server being closed', async () => {
    const unrelated = createServer((_request, response) => response.end('unrelated-server'));
    await new Promise<void>((resolve, reject) => {
      unrelated.once('error', reject);
      unrelated.listen(0, '127.0.0.1', () => { resolve(); });
    });
    const unrelatedAddress = unrelated.address();
    if (!unrelatedAddress || typeof unrelatedAddress === 'string') throw new Error('unrelated server has no TCP address');
    const unrelatedOrigin = `http://127.0.0.1:${String(unrelatedAddress.port)}`;
    let alpha: Awaited<ReturnType<typeof startLayoutDevServer>> | undefined;
    let beta: Awaited<ReturnType<typeof startLayoutDevServer>> | undefined;

    try {
      const starts = await Promise.allSettled([
        startLayoutDevServer({ root: alphaRoot, viteEntry }),
        startLayoutDevServer({ root: betaRoot, viteEntry }),
      ]);
      if (starts[0].status === 'fulfilled') alpha = starts[0].value;
      if (starts[1].status === 'fulfilled') beta = starts[1].value;
      const startupFailure = starts.find((result) => result.status === 'rejected');
      if (startupFailure?.status === 'rejected') throw startupFailure.reason;
      const startedAlpha = alpha;
      const startedBeta = beta;
      if (!startedAlpha || !startedBeta) throw new Error('both own Vite servers must start');
      expect(new URL(startedAlpha.origin).port).not.toBe(new URL(startedBeta.origin).port);
      expect(await (await fetch(startedAlpha.origin)).text()).toContain('alpha-source');
      expect(await (await fetch(startedBeta.origin)).text()).toContain('beta-source');

      await startedAlpha.close();
      expect(() => process.kill(startedAlpha.pid, 0)).toThrow();
      expect(await (await fetch(startedBeta.origin)).text()).toContain('beta-source');
      expect(await (await fetch(unrelatedOrigin)).text()).toBe('unrelated-server');
    } finally {
      await Promise.all([alpha?.close(), beta?.close()]);
      await new Promise<void>((resolve, reject) => {
        unrelated.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('reports an owned Vite startup failure instead of accepting an unrelated listener', async () => {
    const brokenRoot = path.join(scratch, 'broken');
    await mkdir(brokenRoot);
    await writeFile(path.join(brokenRoot, 'index.html'), '<main>broken-source</main>');
    await writeFile(path.join(brokenRoot, 'vite.config.js'), 'export default { plugins: [');
    const unrelated = createServer((_request, response) => response.end('still-alive'));
    await new Promise<void>((resolve, reject) => {
      unrelated.once('error', reject);
      unrelated.listen(0, '127.0.0.1', () => { resolve(); });
    });
    const address = unrelated.address();
    if (!address || typeof address === 'string') throw new Error('unrelated server has no TCP address');

    try {
      await expect(startLayoutDevServer({ root: brokenRoot, viteEntry })).rejects.toThrow(/before readiness/u);
      expect(await (await fetch(`http://127.0.0.1:${String(address.port)}`)).text()).toBe('still-alive');
    } finally {
      await new Promise<void>((resolve, reject) => {
        unrelated.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
