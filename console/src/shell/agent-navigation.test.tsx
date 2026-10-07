import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { topology } from '../mocks/data';
import { server } from '../mocks/server';
import { navigate } from '../router';
import { renderWithApi } from '../test/render';
import { lastChatPath, rememberChat } from './last-chat';

function viewport(width: number) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('1100px') ? width <= 1100 : query.includes('760px') && width <= 760,
    media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
}

function nav(label: string) {
  return within(screen.getByRole('navigation', { name: 'Navegación principal' }))
    .getByRole('link', { name: label });
}

async function open(path: string) {
  act(() => { navigate(path); });
  await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' });
}

beforeEach(() => {
  rememberChat(undefined);
  server.use(http.get('*/v3/console/terminal/capability', () => HttpResponse.json({ available: true })));
});

afterEach(() => {
  rememberChat(undefined);
  window.history.pushState({}, '', '/');
});

it.each([1440, 360, 390])('keeps the selected agent across Chat, Terminal and Office at %ipx', async (width) => {
  viewport(width);
  window.history.pushState({}, '', '/messages/Steven/zeus');
  const user = userEvent.setup();
  renderWithApi(<App />);
  await screen.findByRole('heading', { level: 2, name: 'zeus' });
  expect(nav('Chat')).toHaveAttribute('href', '/messages');
  expect(nav('Terminal')).toHaveAttribute('href', '/terminal/Steven/zeus');
  await user.click(nav('Terminal'));
  expect(window.location.pathname).toBe('/terminal/Steven/zeus');
  await screen.findByRole('heading', { level: 2, name: /^zeus/ });

  await open('/terminal/Miguel/kratos');
  await screen.findByRole('heading', { level: 2, name: /^kratos/ });
  expect(nav('Chat')).toHaveAttribute('href', '/messages/Miguel/kratos');
  await user.click(nav('Oficina'));
  await screen.findByRole('heading', { level: 1, name: 'Oficina' });
  expect(nav('Terminal')).toHaveAttribute('href', '/terminal/Miguel/kratos');
  expect(nav('Chat')).toHaveAttribute('href', '/messages/Miguel/kratos');
  await user.click(nav('Chat'));
  expect(window.location.pathname).toBe('/messages/Miguel/kratos');
  await screen.findByRole('heading', { level: 2, name: 'kratos' });
  await user.click(nav('Chat'));
  expect(window.location.pathname).toBe('/messages');
  expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
});

it.each([1440, 390])('explicit terminal identity overrides older chat memory and survives Office at %ipx', async (width) => {
  viewport(width);
  rememberChat('/messages/Steven/zeus');
  window.history.pushState({}, '', '/terminal/Miguel/kratos');
  renderWithApi(<App />);
  await screen.findByRole('heading', { level: 2, name: /^kratos/ });
  expect(nav('Chat')).toHaveAttribute('href', '/messages/Miguel/kratos');
  await userEvent.click(nav('Oficina'));
  await screen.findByRole('heading', { level: 1, name: 'Oficina' });
  expect(nav('Chat')).toHaveAttribute('href', '/messages/Miguel/kratos');
  expect(nav('Terminal')).toHaveAttribute('href', '/terminal/Miguel/kratos');
});

it('preserves encoded identity segments when leaving an observed terminal', async () => {
  server.use(http.get('*/v3/console/topology', () => HttpResponse.json({
    ...topology,
    tenants: [...(topology.tenants ?? []), {
      id: 'Equipo Azul', rooms: [{ id: 'equipo', members: [{ alias: 'sálva', enabled: true }] }],
    }],
  })));
  window.history.pushState({}, '', '/terminal/Equipo%20Azul/s%C3%A1lva');
  renderWithApi(<App />);
  await screen.findByRole('heading', { level: 2, name: /^sálva/ });
  await userEvent.click(nav('Oficina'));
  await screen.findByRole('heading', { level: 1, name: 'Oficina' });
  expect(nav('Chat')).toHaveAttribute('href', '/messages/Equipo%20Azul/s%C3%A1lva');
  expect(nav('Terminal')).toHaveAttribute('href', '/terminal/Equipo%20Azul/s%C3%A1lva');
});

it('does not remember an unobserved terminal identity or invent a selection on bare routes', async () => {
  window.history.pushState({}, '', '/terminal/Steven/missing-agent');
  renderWithApi(<App />);
  await screen.findByText(/no observa al agente Steven:missing-agent/);
  expect(lastChatPath()).toBeUndefined();
  await userEvent.click(nav('Oficina'));
  await screen.findByRole('heading', { level: 1, name: 'Oficina' });
  expect(nav('Chat')).toHaveAttribute('href', '/messages');
  expect(nav('Terminal')).toHaveAttribute('href', '/terminal');
});

it('keeps Terminal unavailable when the server denies control', async () => {
  server.use(http.get('*/v3/console/terminal/capability', () => HttpResponse.json({ error: 'forbidden' }, { status: 403 })));
  window.history.pushState({}, '', '/messages/Steven/zeus');
  renderWithApi(<App />);
  await screen.findByRole('heading', { level: 2, name: 'zeus' });
  await waitFor(() => { expect(nav('Terminal')).toHaveAttribute('aria-disabled', 'true'); });
  await userEvent.click(nav('Terminal'));
  expect(window.location.pathname).toBe('/messages/Steven/zeus');
  expect(screen.queryByRole('heading', { level: 1, name: 'Terminal de agentes' })).not.toBeInTheDocument();
});
