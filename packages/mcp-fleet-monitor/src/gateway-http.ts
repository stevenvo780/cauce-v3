import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { GatewayReader } from './gateway-client.js';
import { httpsOrigin } from './gateway-configuration.js';
import { MCP_METADATA_PATH, type GatewayAuthorization, type HumanGatewayAuthorization } from './gateway-authorization.js';
import { createGatewayToolServer } from './gateway-tools.js';
import type { GatewayOperationsFactory } from './gateway-operations.js';

export { createHumanGatewayAuthorization, type HumanGatewayAuthorization } from './gateway-authorization.js';
export { type VerifiedOAuthIdentity, type OAuthIdentityVerifierConfiguration } from './gateway-oauth-identity.js';
export {
  GatewayOperationError, GatewayOperationFailureSchema, McpSubmitCommandSchema, HumanMcpReceiptSchema,
  HUMAN_MCP_INBOX_MAX_BYTES, HUMAN_MCP_INBOX_TEXT_BYTES, HUMAN_MCP_INBOX_UNTRUSTED_FIELDS, HumanMcpInboxSchema, InboxInputSchema,
  type GatewayOperationsFactory, type HumanMcpInbox, type HumanMcpInboxQuery, type HumanMcpReceipt, type McpSubmitCommand,
} from './gateway-operations.js';
export { MailboxInputSchema, HumanMcpMailboxSchema, type HumanMcpMailbox, type HumanMcpMailboxQuery } from './gateway-mailbox.js';
export { projectGatewayAgents, projectGatewayStatus } from './gateway-projection.js';

export const MAX_MCP_REQUEST_BYTES = 16 * 1024;
export const MAX_MCP_REQUESTS = 8;

class RequestError extends Error {
  constructor(readonly status: number) { super('Invalid MCP request'); }
}

function reply(response: ServerResponse, status: number, challenge?: string, allow = 'POST'): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, {
    'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close',
    ...(status === 401 && challenge ? { 'www-authenticate': challenge } : {}),
    ...(status === 405 ? { allow } : {}),
  });
  response.end(JSON.stringify({ error: status === 401 ? 'unauthorized' : 'request_rejected' }));
}

function headerCount(request: IncomingMessage, name: string): number {
  return request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
}

function validHostOrigin(request: IncomingMessage, host: string, origin: string): boolean {
  return headerCount(request, 'host') === 1 && request.headers.host === host
    && headerCount(request, 'origin') <= 1
    && (request.headers.origin === undefined || request.headers.origin === origin);
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new RequestError(415);
  if (request.headers['content-encoding'] !== undefined) throw new RequestError(415);
  if (Number(request.headers['content-length']) > MAX_MCP_REQUEST_BYTES) throw new RequestError(413);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    bytes += chunk.length;
    if (bytes > MAX_MCP_REQUEST_BYTES) throw new RequestError(413);
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400);
    return body;
  }
  catch { throw new RequestError(400); }
}

export type GatewayHttpOptions = { readonly publicOrigin: string } & (
  | { readonly reader: GatewayReader; readonly authorization: GatewayAuthorization; readonly operationsFactory?: never }
  | { readonly operationsFactory: GatewayOperationsFactory; readonly authorization: HumanGatewayAuthorization; readonly reader?: never }
);

export interface GatewayHttpHandler extends RequestListener {
  drain(): Promise<void>;
}

interface ActiveRequest {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly controller: AbortController;
  readonly admitted: boolean;
  task: Promise<void>;
}

export function createGatewayHttpHandler(options: GatewayHttpOptions): GatewayHttpHandler {
  const origin = httpsOrigin(options.publicOrigin);
  const host = new URL(origin).host;
  const requests = new Set<ActiveRequest>();
  let active = 0;
  let draining = false;
  let drainTask: Promise<void> | undefined;

  async function handle(request: IncomingMessage, response: ServerResponse, controller: AbortController): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    if (!validHostOrigin(request, host, origin)) {
      reply(response, 403); return;
    }
    if (draining && (request.url === '/mcp' || request.url === MCP_METADATA_PATH)) { reply(response, 503); return; }
    if (request.url === MCP_METADATA_PATH && options.authorization.metadata) {
      if (request.method !== 'GET') { reply(response, 405, undefined, 'GET'); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(options.authorization.metadata));
      return;
    }
    if (request.url !== '/mcp') { reply(response, 404); return; }
    const requestAborted = () => controller.signal.aborted;
    const timeout = setTimeout(() => { controller.abort(); response.destroy(); }, 10_000);
    request.setTimeout(5000, () => request.destroy());
    let server: ReturnType<typeof createGatewayToolServer> | undefined;
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const closed = new Promise<void>((resolve) => {
      const finish = () => { controller.abort(); resolve(); };
      response.once('close', finish);
      response.once('finish', finish);
    });
    try {
      if (headerCount(request, 'authorization') !== 1) {
        reply(response, 401, options.authorization.challenge); return;
      }
      const header = request.headers.authorization ?? '';
      if (options.operationsFactory !== undefined) {
        const identity = await options.authorization.authenticateIdentity(header);
        if (!identity) { reply(response, 401, options.authorization.challenge); return; }
        if (requestAborted()) return;
        server = createGatewayToolServer({ factory: options.operationsFactory, identity, signal: controller.signal });
      } else {
        if (!await options.authorization.authenticate(header)) {
          reply(response, 401, options.authorization.challenge); return;
        }
        if (requestAborted()) return;
        server = createGatewayToolServer(options.reader, options.authorization.mode === 'oauth');
      }
      if (request.method !== 'POST') { reply(response, 405); return; }
      const body = await requestBody(request);
      // SDK 1.x optional callbacks predate exactOptionalPropertyTypes; omitted session IDs mean stateless mode.
      await server.connect(transport as Transport);
      if (requestAborted()) return;
      await transport.handleRequest(request, response, body);
      await closed;
    } catch (error) {
      reply(response, error instanceof RequestError ? error.status : 400);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await server?.close();
    }
  }

  const handler: GatewayHttpHandler = (request, response): void => {
    response.setHeader('cache-control', 'no-store');
    if (!validHostOrigin(request, host, origin)) { reply(response, 403); return; }
    if (draining && (request.url === '/mcp' || request.url === MCP_METADATA_PATH)) {
      reply(response, 503);
      return;
    }
    const admitted = request.url === '/mcp';
    if (admitted && active >= MAX_MCP_REQUESTS) { reply(response, 503); return; }
    if (admitted) active += 1;
    const activeRequest: ActiveRequest = { request, response, controller: new AbortController(), admitted, task: Promise.resolve() };
    requests.add(activeRequest);
    activeRequest.task = Promise.resolve().then(() => handle(request, response, activeRequest.controller))
      .catch(() => { reply(response, 500); })
      .finally(() => {
        requests.delete(activeRequest);
        if (activeRequest.admitted) active -= 1;
      });
  };
  handler.drain = (): Promise<void> => {
    if (drainTask) return drainTask;
    draining = true;
    drainTask = (async () => {
      while (requests.size > 0) {
        const active = [...requests];
        for (const request of active) {
          request.controller.abort();
          request.request.destroy();
          request.response.destroy();
        }
        await Promise.allSettled(active.map((request) => request.task));
      }
    })();
    return drainTask;
  };
  return handler;
}

export function createGatewayHttpServer(options: GatewayHttpOptions) {
  const http = createServer({ maxHeaderSize: 16 * 1024 }, createGatewayHttpHandler(options));
  http.requestTimeout = 10_000;
  http.headersTimeout = 10_000;
  http.keepAliveTimeout = 1000;
  http.maxHeadersCount = 64;
  http.maxConnections = 64;
  return http;
}
