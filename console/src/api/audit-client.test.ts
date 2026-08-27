import { http, HttpResponse } from 'msw';
import { CauceApi } from './client';
import { server } from '../mocks/server';

describe('CauceApi audit pagination', () => {
  it('sends one bounded canonical keyset cursor', async () => {
    let query = '';
    server.use(http.get('http://localhost/v3/console/audit', ({ request }) => {
      query = new URL(request.url).search;
      return HttpResponse.json({ items: [], next_cursor: null });
    }));
    const api = new CauceApi('http://localhost');

    await api.listAudit({ limit: 50, before: '9223372036854775807' });
    expect(query).toBe('?limit=50&before=9223372036854775807');
  });

  it('rejects malformed pagination locally before issuing a request', () => {
    const api = new CauceApi('http://localhost');
    expect(() => api.listAudit({ limit: 0 })).toThrow(/between 1 and 500/i);
    expect(() => api.listAudit({ limit: 501 })).toThrow(/between 1 and 500/i);
    expect(() => api.listAudit({ before: '01' })).toThrow(/canonical positive bigint/i);
    expect(() => api.listAudit({ before: '9223372036854775808' }))
      .toThrow(/canonical positive bigint/i);
  });
});
