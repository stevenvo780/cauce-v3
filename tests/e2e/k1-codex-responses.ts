import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

function textParts(value: unknown, depth = 0): string[] {
  if (depth > 32) throw new Error('local Responses input exceeds its nesting bound');
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((part: unknown) => textParts(part, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap((part: unknown) => textParts(part, depth + 1));
  }
  return [];
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const part of request) {
    const chunk: Buffer = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error('local Responses request exceeds its byte bound');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function replyTo(value: unknown): string {
  const text = textParts(value).join('\n');
  const matches = [...text.matchAll(/"cauce_correlation_id"\s*:\s*"([a-f0-9]{64})"/gu)];
  const correlation = matches.at(-1)?.[1];
  if (correlation === undefined) return 'K1_READY';
  return JSON.stringify({ reply: 'K1_DELIVERED', messages: [], notify: [], status: 'done', retryable: false,
    artifacts: [], cauce_correlation_id: correlation });
}

function complete(response: ServerResponse, text: string): void {
  const id = `resp_${randomUUID().replaceAll('-', '')}`;
  const item = { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const result = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
    model: 'gpt-5.4', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  const event = (type: string, packet: Record<string, unknown>) => {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...packet })}\n\n`);
  };
  event('response.created', { response: { ...result, status: 'in_progress', output: [] } });
  event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] } });
  event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
  event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
  event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  event('response.output_item.done', { output_index: 0, item });
  event('response.completed', { response: result });
  response.end();
}

export async function startK1CodexResponses() {
  let requests = 0;
  const server = createServer((request, response) => {
    const serve = async () => {
      if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.4', object: 'model', owned_by: 'k1-local' }] }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404); response.end(); return;
      }
      const body = await readRequest(request);
      requests++;
      complete(response, replyTo(body));
    };
    void serve().catch(() => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('local Responses server has no TCP address');
  return { url: `http://127.0.0.1:${String(address.port)}/v1`, requestCount: () => requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => {
      server.close(error => { if (error) reject(error); else resolve(); });
    }); } };
}
