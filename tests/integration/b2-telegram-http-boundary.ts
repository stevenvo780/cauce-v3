import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TelegramUpdate } from '../../services/telegram-bridge/src/types.js';

export interface TelegramBoundaryCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
  readonly uploads: readonly { field: string; name: string; mime: string; bytes: number; sha256: string }[];
}

interface BoundaryResponse { readonly status: number; readonly result?: unknown; readonly raw?: string }
interface BoundaryFile { readonly bytes: Buffer; readonly mime?: string; readonly path?: string }

export async function startTelegramBoundary() {
  const calls: TelegramBoundaryCall[] = [];
  const updates: TelegramUpdate[] = [];
  const files = new Map<string, BoundaryFile>();
  const responses = new Map<string, BoundaryResponse[]>();
  let providerMessage = 700;
  let transcript = 'Mensaje de voz reconocido por el tercero ASR.';
  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.url?.split('/').at(-1) ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    const bytes = Buffer.concat(chunks);
    const headers = request.headers['content-type'] ?? '';
    const body: Record<string, unknown> = {};
    const uploads: TelegramBoundaryCall['uploads'][number][] = [];
    if (headers.startsWith('multipart/form-data')) {
      const form = await new Request('http://telegram-boundary.invalid', {
        method: 'POST', headers: { 'content-type': headers }, body: new Uint8Array(bytes),
      }).formData();
      const fields: { field: string; value: FormDataEntryValue }[] = [];
      form.forEach((value, field) => { fields.push({ field, value }); });
      for (const { field, value } of fields) {
        if (typeof value === 'string') body[field] = value;
        else {
          const content = Buffer.from(await value.arrayBuffer());
          uploads.push({ field, name: value.name, mime: value.type, bytes: content.length,
            sha256: createHash('sha256').update(content).digest('hex') });
        }
      }
    } else if (bytes.length > 0) Object.assign(body, JSON.parse(bytes.toString('utf8')) as object);
    calls.push({ method, body, uploads });
    const queued = responses.get(method)?.shift();
    if (queued !== undefined) {
      response.writeHead(queued.status, { 'content-type': 'application/json' });
      response.end(queued.raw ?? JSON.stringify(queued.status >= 400
        ? { ok: false, error_code: queued.status, description: 'Fallo del tercero de prueba', parameters: { retry_after: 1 } }
        : { ok: true, result: queued.result }));
      return;
    }
    if (request.method === 'GET') {
      const file = [...files.entries()].find(([id, file]) => (file.path ?? `files/${id}`) === request.url?.split('/').slice(3).join('/'))?.[1];
      response.writeHead(file === undefined ? 404 : 200, { 'content-type': file?.mime ?? 'application/octet-stream' });
      response.end(file?.bytes ?? 'missing');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (method === 'transcriptions') { response.end(JSON.stringify({ text: transcript })); return; }
    const file = typeof body.file_id === 'string' ? files.get(body.file_id) : undefined;
    const result = method === 'getMe' ? { id: 900001, username: 'B2Bot' }
      : method === 'getUpdates' ? updates.filter(update => update.update_id >= Number(body.offset))
        : method === 'getFile' ? { file_id: body.file_id, file_path: file?.path ?? `files/${String(body.file_id)}`, file_size: file?.bytes.length ?? 0 }
          : method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument' ? { message_id: ++providerMessage }
            : true;
    response.end(JSON.stringify({ ok: true, result }));
  };
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => { response.writeHead(500); response.end('boundary failed'); });
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { origin, calls, updates, files, responses,
    setTranscript(value: string) { transcript = value; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    },
  };
}
