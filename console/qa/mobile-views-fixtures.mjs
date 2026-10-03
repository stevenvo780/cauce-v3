import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { getResponse } from 'msw';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function loadFixtures() {
  const temporary = await mkdtemp(join(ROOT, 'qa/.mobile-views-'));
  try {
    const outfile = join(temporary, 'fixtures.mjs');
    await build({ stdin: {
      contents: 'export { handlers } from "./src/mocks/handlers"; export { mobileChatFixtures } from "./src/test/mobile-chat-fixtures";',
      resolveDir: ROOT,
    }, outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm' });
    const { handlers, mobileChatFixtures } = await import(pathToFileURL(outfile).href);
    const chat = mobileChatFixtures();
    return async (url, method = 'GET') => {
      if (method !== 'GET') throw new Error(`Mutation blocked: ${method} ${new URL(url).pathname}`);
      const path = new URL(url).pathname;
      if (path === '/v3/console/messages') return Response.json(chat[path]);
      const response = await getResponse(handlers, new Request(url));
      if (path === '/v3/console/config' && response?.ok) {
        const configuration = await response.json();
        return Response.json({ ...configuration, mobile_qa_collection: [{ id: 'qa-visible-collection', label: 'Colección adicional de prueba' }] });
      }
      return response;
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
