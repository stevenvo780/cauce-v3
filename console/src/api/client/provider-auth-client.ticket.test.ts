import { describe, expect, it } from 'vitest';
import { providerAuthClient } from './provider-auth-client';

const SESSION = '00000000-0000-4000-8000-000000000051';
const TICKET = '00000000-0000-4000-8000-000000000052';
const issuedAt = (offsetMs: number) => providerAuthClient((async () => ({ ticket: TICKET,
  expires_at: new Date(Date.now() + offsetMs).toISOString() })) as never).ticket(SESSION);

describe('ticket del terminal de autenticación', () => {
  it('acepta el vencimiento cuando el reloj del navegador va unos segundos por detrás del servidor', async () => {
    await expect(issuedAt(12_000)).resolves.toMatchObject({ ticket: TICKET });
  });
  it('acepta el vencimiento cuando el reloj del navegador va unos segundos por delante', async () => {
    await expect(issuedAt(-5_000)).resolves.toMatchObject({ ticket: TICKET });
  });
  it('rechaza un vencimiento absurdamente lejano o ya muy pasado', async () => {
    await expect(issuedAt(120_000)).rejects.toThrow();
    await expect(issuedAt(-120_000)).rejects.toThrow();
  });
});
