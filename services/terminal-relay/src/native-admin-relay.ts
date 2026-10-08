import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import { AliasSchema, NativeAdminCommandSchema, NATIVE_ADMIN_FEATURE, TenantSchema } from '@cauce/protocol';
import type { AgentLookup } from './agent-leg.js';

interface NativeRelayOptions { agents: AgentLookup; token: () => Promise<string>; timeoutMs?: number }
export async function handleNativeAdmin(options: NativeRelayOptions, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (request.url !== '/v3/terminal/relay/native-admin') return false;
  const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.method !== 'POST') { request.resume(); send(405, { type: 'error', error: 'invalid_input' }); return true; }
  if (!(request.socket instanceof TLSSocket) || !request.socket.authorized) { request.resume(); send(401, { type: 'error', error: 'unavailable' }); return true; }
  const expected = createHash('sha256').update(`Bearer ${await options.token()}`).digest();
  const actual = createHash('sha256').update(request.headers.authorization ?? '').digest();
  if (!timingSafeEqual(expected, actual)) { request.resume(); send(401, { type: 'error', error: 'unavailable' }); return true; }
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 65_536) { request.resume(); send(413, { type: 'error', error: 'too_large' }); return true; }
    chunks.push(buffer);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, { type: 'error', error: 'invalid_input' }); return true; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { send(400, { type: 'error', error: 'invalid_input' }); return true; }
  const raw = body as Record<string, unknown>;
  const command = NativeAdminCommandSchema.safeParse(raw.command);
  if (Object.keys(raw).sort().join(',') !== 'alias,command,tenant_id' || !command.success
    || !TenantSchema.safeParse(raw.tenant_id).success || !AliasSchema.safeParse(raw.alias).success) {
    send(400, { type: 'error', error: 'invalid_input' }); return true;
  }
  const agent = options.agents.lookup(String(raw.tenant_id), String(raw.alias));
  const identity = command.data.identity;
  if (!agent?.hello.features.includes(NATIVE_ADMIN_FEATURE) || agent.hello.generation !== identity.generation
    || agent.hello.container_id !== identity.container_id || agent.hello.writer_instance_id !== identity.writer_instance_id) {
    send(409, { type: 'error', error: 'conflict' }); return true;
  }
  const controller = new AbortController(); const abort = () => { controller.abort(); };
  request.once('aborted', abort);
  response.once('close', abort);
  try { send(200, await agent.nativeAdmin.request(command.data, options.timeoutMs ?? 5000, controller.signal)); }
  catch { send(503, { type: 'error', error: 'unavailable' }); }
  finally { request.off('aborted', abort); response.off('close', abort); }
  return true;
}
