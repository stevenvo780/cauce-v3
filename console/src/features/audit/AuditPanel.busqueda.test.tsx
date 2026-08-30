import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { AuditPanel } from './AuditPanel';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

/**
 * The audit book's SEARCH. It runs in the browser over the loaded pages, and that is exactly why
 * it has to say so: the relay's "See audit" button lands here with a `trace_id` that is usually
 * older than the first page, and the panel used to answer that no event matched.
 */

const evento = (id: string, extra: Record<string, unknown> = {}) => ({
  event_id: id,
  at: '2026-08-26T08:00:00.000Z',
  tenant_id: 'Steven',
  actor_alias: 'kant',
  action: `audit.event.${id}`,
  decision: 'allow',
  request_id: null,
  trace_id: `trace-${id}`,
  summary: JSON.stringify({ state: 'done' }),
  ...extra,
});

/** The panel keeps the text on the page, as the merged view does. */
function PanelConBusqueda({ inicial = '' }: { inicial?: string }) {
  const [query, setQuery] = useState(inicial);
  return <AuditPanel query={query} onQuery={setQuery} />;
}

it('filtra por cualquiera de los seis campos, sin pedirle nada al servidor', async () => {
  const consultas: string[] = [];
  server.use(http.get('*/v3/console/audit', ({ request }) => {
    consultas.push(new URL(request.url).search);
    return HttpResponse.json({
      items: [evento('1'), evento('2', { actor_alias: 'atlas' })],
      next_cursor: null,
    });
  }));
  const user = userEvent.setup();
  renderWithApi(<PanelConBusqueda />);
  await screen.findByText('audit.event.1');

  await user.type(screen.getByRole('searchbox', { name: /filtrar auditoría/i }), 'atlas');

  await waitFor(() => { expect(screen.getByText('1 visibles de 2')).toBeInTheDocument(); });
  expect(screen.queryByText('audit.event.1')).not.toBeInTheDocument();
  expect(screen.getByText('audit.event.2')).toBeInTheDocument();
  // The filter is local: the search does not issue a second request with a parameter the gateway
  // does not accept.
  expect(consultas).toEqual(['?limit=100']);
});

it('NO afirma que el evento no existe cuando sólo miró la primera página', async () => {
  server.use(http.get('*/v3/console/audit', () => HttpResponse.json({
    items: [evento('9'), evento('8')],
    next_cursor: '8',
  })));
  renderWithApi(<PanelConBusqueda inicial="trace-1" />);

  // The lie that was: "No hay eventos que coincidan" over an audit log with pages left to walk.
  expect(await screen.findByText(/ninguno de los 2 eventos cargados coincide/i)).toBeInTheDocument();
  expect(screen.queryByText('No hay eventos que coincidan.')).not.toBeInTheDocument();
  expect(screen.getByText(/sólo cubre lo cargado/i)).toBeInTheDocument();
  // And the way out is right there, because that is what extends the search.
  expect(screen.getByRole('button', { name: /cargar anteriores/i })).toBeInTheDocument();
});

it('el camino real de «Ver auditoría»: cargar anteriores encuentra la traza del relay', async () => {
  server.use(http.get('*/v3/console/audit', ({ request }) => {
    const before = new URL(request.url).searchParams.get('before');
    return before === '8'
      ? HttpResponse.json({ items: [evento('7'), evento('1')], next_cursor: null })
      : HttpResponse.json({ items: [evento('9'), evento('8')], next_cursor: '8' });
  }));
  const user = userEvent.setup();
  renderWithApi(<PanelConBusqueda inicial="trace-1" />);
  await screen.findByText(/ninguno de los 2 eventos cargados coincide/i);

  await user.click(screen.getByRole('button', { name: /cargar anteriores/i }));

  expect(await screen.findByText('audit.event.1')).toBeInTheDocument();
  expect(screen.getByText('1 visibles de 4')).toBeInTheDocument();
});

it('agotado el libro, la búsqueda vacía SÍ es una afirmación sobre todo el libro', async () => {
  server.use(http.get('*/v3/console/audit', () => HttpResponse.json({
    items: [evento('9')],
    next_cursor: null,
  })));
  renderWithApi(<PanelConBusqueda inicial="trace-1" />);
  await screen.findByText('No hay eventos que coincidan.');

  expect(screen.queryByText(/sólo cubre lo cargado/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /cargar anteriores/i })).not.toBeInTheDocument();
});

it('dice hasta dónde llegó la búsqueda incluso cuando encontró algo', async () => {
  server.use(http.get('*/v3/console/audit', () => HttpResponse.json({
    items: [evento('9'), evento('8')],
    next_cursor: '8',
  })));
  renderWithApi(<PanelConBusqueda inicial="trace-9" />);
  await screen.findByText('audit.event.9');

  expect(screen.getByRole('status')).toHaveTextContent(
    /entre los 2 eventos ya cargados; la auditoría tiene más atrás/i,
  );
});
