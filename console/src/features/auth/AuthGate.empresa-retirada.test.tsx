import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { App } from '../../App';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

const SESSION = 'http://localhost/v3/auth/session';
const LOGOUT = 'http://localhost/v3/auth/logout';

const session = (role: string, scope: string) => HttpResponse.json({
  authenticated: true,
  subject: 'owner@empresa.test',
  expires_at: '2026-10-30T12:00:00.000Z',
  csrf_token: 'x'.repeat(32),
  authority: { role, scope, home_company: 'acme', acting_company: 'acme', platform_override: false },
});

it('con autoridad none muestra «Tu empresa fue retirada» y no renderiza la consola', async () => {
  server.use(http.get(SESSION, () => session('none', 'none')));
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { name: /tu empresa fue retirada/i })).toBeVisible();
  expect(screen.getByText(/administrador de plataforma/i)).toBeVisible();
  expect(screen.queryByRole('navigation', { name: /principal/i })).not.toBeInTheDocument();
});

it('el botón cierra la sesión', async () => {
  let loggedOut = false;
  server.use(
    http.get(SESSION, () => (loggedOut ? HttpResponse.json({ authenticated: false }) : session('none', 'none'))),
    http.post(LOGOUT, () => { loggedOut = true; return new HttpResponse(null, { status: 204 }); }),
  );
  renderWithApi(<App />);

  await userEvent.click(await screen.findByRole('button', { name: /cerrar sesión/i }));
  expect(await screen.findByRole('link', { name: /iniciar sesión/i })).toBeVisible();
});

it('un lector con autoridad válida entra a la consola', async () => {
  server.use(http.get(SESSION, () => session('reader', 'company')));
  renderWithApi(<App />);

  expect(await screen.findByRole('navigation', { name: /principal/i })).toBeInTheDocument();
  expect(screen.queryByText(/tu empresa fue retirada/i)).not.toBeInTheDocument();
});
