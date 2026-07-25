import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { App } from './App';
import { renderWithApi } from './test/render';
import { server } from './mocks/server';

it('provides basic accessible landmarks and identity guidance', async () => {
  window.location.hash = '#/fleet';
  renderWithApi(<App />);
  expect(screen.getByRole('navigation', { name: /principal/i })).toBeInTheDocument();
  expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  expect(screen.getByRole('link', { name: /saltar al contenido/i })).toHaveAttribute('href', '#main-content');
  expect(await screen.findByRole('heading', { level: 1, name: /fleet/i })).toBeInTheDocument();
  expect(screen.getByText(/Cookie HttpOnly esperada/i)).toBeInTheDocument();
  expect(await screen.findByText('Steven:kant')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /cerrar sesión/i })).toBeInTheDocument();
});

it('shows the server-side login entry point when no BFF session exists', async () => {
  server.use(http.get('http://localhost/v3/auth/session', () => HttpResponse.json({ authenticated: false })));
  renderWithApi(<App />);

  expect(await screen.findByRole('link', { name: /iniciar sesión/i })).toHaveAttribute(
    'href',
    'http://localhost/v3/auth/login',
  );
});

it('routes #/fleet/:tenant/:alias to the bot detail instead of the fleet list', async () => {
  window.location.hash = '#/fleet/Steven/kant';
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'kant' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /volver a fleet/i })).toHaveAttribute('href', '#/fleet');
  expect(screen.getByRole('link', { name: /^fleet$/i })).toHaveAttribute('aria-current', 'page');
});

it('falls back to Fleet for an unknown route id even with extra hash segments', async () => {
  window.location.hash = '#/unknown/nested/segment';
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /fleet & presencia/i })).toBeInTheDocument();
});

it('ignores extra hash segments on non-fleet routes and keeps rendering the existing page', async () => {
  window.location.hash = '#/terminal/unused/segment';
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Ultimate Terminal' })).toBeInTheDocument();
});
