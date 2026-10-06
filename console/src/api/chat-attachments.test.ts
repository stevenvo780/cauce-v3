import { createHash } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { CauceApi } from './client';
import type { ChatAttachment } from './types';
import { server } from '../mocks/server';

it('preserves exact file bytes on both intent and publication with cookie/CSRF authority', async () => {
  const bytes = Buffer.from('Informe del chat\n', 'utf8');
  const file: ChatAttachment = {
    kind: 'document', name: 'informe.txt', mime_type: 'text/plain', file_size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64'),
  };
  const requests: { body: unknown; csrf: string | null; credentials: string }[] = [];
  const observe = async (request: Request) => {
    requests.push({ body: await request.json(), csrf: request.headers.get('x-csrf-token'), credentials: request.credentials });
    return HttpResponse.json({});
  };
  server.use(
    http.post('http://localhost/v3/console/publish-intents', ({ request }) => observe(request)),
    http.post('http://localhost/v3/console/messages', ({ request }) => observe(request)),
  );
  const api = new CauceApi('http://localhost');
  const input = {
    room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: '', attachments_v1: [file], forged: true }, lane: 'interactive' as const, priority: 10,
  };
  await api.preparePublishIntent({ ...input, intent_nonce: 'a0000000-0000-4000-8000-000000000001' });
  await api.publishMessage({ ...input, idempotency_key: 'server-key' });
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.csrf).toBe('mock-csrf-token');
    expect(request.credentials).toBe('include');
    expect(request.body).toMatchObject({ body: { text: '', attachments_v1: [file] } });
    expect(request.body).not.toHaveProperty('body.forged');
  }
  expect((requests[0].body as { body: unknown }).body).toEqual((requests[1].body as { body: unknown }).body);
});
