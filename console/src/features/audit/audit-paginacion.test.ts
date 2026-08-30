import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { CauceApi } from '../../api/client';
import { server } from '../../mocks/server';

/**
 * Limits of the audit book's paging, from the book's side. The keyset cursor is a bigint and the
 * page size is bounded by the gateway: a request outside those limits is a guaranteed 400, and the
 * console stops it before spending a round trip on it. `0` as a cursor is the case a naive
 * "first page" would produce, and it is not a canonical cursor.
 */

const api = new CauceApi('http://localhost');

it('rechaza los tamaños de página fuera de rango, incluso los que no son números', () => {
  expect(() => api.listAudit({ limit: 0 })).toThrow(/between 1 and 500/i);
  expect(() => api.listAudit({ limit: 501 })).toThrow(/between 1 and 500/i);
  expect(() => api.listAudit({ limit: Number('1x') })).toThrow(/between 1 and 500/i);
  expect(() => api.listAudit({ limit: 1.5 })).toThrow(/between 1 and 500/i);
  expect(() => api.listAudit({ limit: -1 })).toThrow(/between 1 and 500/i);
});

it('rechaza los cursores que no son un bigint positivo canónico', () => {
  expect(() => api.listAudit({ before: '0' })).toThrow(/canonical positive bigint/i);
  expect(() => api.listAudit({ before: '01' })).toThrow(/canonical positive bigint/i);
  expect(() => api.listAudit({ before: '-1' })).toThrow(/canonical positive bigint/i);
  expect(() => api.listAudit({ before: '' })).toThrow(/canonical positive bigint/i);
  // 2^63: one past the last id PostgreSQL can hold in a bigint.
  expect(() => api.listAudit({ before: '9223372036854775808' })).toThrow(/canonical positive bigint/i);
});

it('acepta los extremos que el gateway sí admite y los manda tal cual', async () => {
  const consultas: string[] = [];
  server.use(http.get('http://localhost/v3/console/audit', ({ request }) => {
    consultas.push(new URL(request.url).search);
    return HttpResponse.json({ items: [], next_cursor: null });
  }));

  await api.listAudit({ limit: 1 });
  await api.listAudit({ limit: 500, before: '9223372036854775807' });

  expect(consultas).toEqual(['?limit=1', '?limit=500&before=9223372036854775807']);
});
