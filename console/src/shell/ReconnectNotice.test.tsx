import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CauceApi } from '../api/client';
import { ApiProvider } from '../api/context';
import { ReconnectNotice } from './ReconnectNotice';

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

it('muestra «Reconectando con el servidor…» mientras una lectura reintenta', async () => {
  let intentos = 0;
  const fetcher = (() => {
    intentos += 1;
    return Promise.resolve(intentos < 3 ? json(502, { message: 'bad gateway' }) : json(200, { ok: true }));
  }) as typeof fetch;
  const api = new CauceApi('http://localhost', fetcher);
  render(<ApiProvider api={api}><ReconnectNotice /></ApiProvider>);
  const lectura = api.getStatus();
  expect(await screen.findByText('Reconectando con el servidor…')).toBeInTheDocument();
  await expect(lectura).resolves.toMatchObject({ ok: true });
});

it('una escritura caída no se reintenta sola: el aviso ofrece «Reintentar» y lo ejecuta', async () => {
  let intentos = 0;
  const fetcher = ((input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === '/v3/auth/session') return Promise.resolve(json(200, { authenticated: true, csrf_token: 'tok', subject: 'a:b' }));
    intentos += 1;
    return Promise.resolve(intentos === 1 ? json(503, { message: 'unavailable' }) : new Response(null, { status: 204 }));
  }) as typeof fetch;
  const api = new CauceApi('http://localhost', fetcher);
  await expect(api.logout()).rejects.toMatchObject({ status: 503 });
  render(<ApiProvider api={api}><ReconnectNotice /></ApiProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
  expect(intentos).toBe(2);
  expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
});
