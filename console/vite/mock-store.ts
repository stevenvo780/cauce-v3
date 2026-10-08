import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';

const PREFIX = '/__mock-store/';
const MAX_BODY = 256 * 1024;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) reject(new Error('mock store body too large'));
    });
    request.on('end', () => { resolve(body); });
    request.on('error', reject);
  });
}

/** Dev-only memory for the browser mocks, so demo state survives a reload while the dev server lives. */
export function mockStore(): Plugin {
  const documents = new Map<string, string>();
  return {
    name: 'cauce-mock-store',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? '';
        if (!url.startsWith(PREFIX)) { next(); return; }
        const name = url.slice(PREFIX.length);
        if (!/^[a-z-]{1,64}$/.test(name)) { response.statusCode = 404; response.end(); return; }
        if (request.method === 'GET') {
          const stored = documents.get(name);
          response.statusCode = stored === undefined ? 404 : 200;
          response.setHeader('content-type', 'application/json');
          response.end(stored ?? 'null');
          return;
        }
        if (request.method !== 'PUT') { response.statusCode = 405; response.end(); return; }
        readBody(request).then((body) => {
          JSON.parse(body);
          documents.set(name, body);
          response.statusCode = 204;
          response.end();
        }, () => {
          response.statusCode = 413;
          response.end();
        }).catch(() => {
          response.statusCode = 400;
          response.end();
        });
      });
    },
  };
}
