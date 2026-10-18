import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { RecentFleetOperations } from './RecentFleetOperations';

const base = { request_sha256: 'a'.repeat(64), actor: { tenant_id: 'A', alias: 'op' }, expected_revision: 4,
  desired_revision: null, applied_revision: null, steps: [], created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z' };
const failed = (id: string, retryable: boolean) => ({ ...base, id, kind: 'purge', status: 'failed', version: 2,
  target: { resource: 'room', tenant_id: 'A', room_id: 'sala' }, error: { code: 'STEP_FAILED', step: 'purge', retryable } });
const retryable = failed('11111111-1111-4111-8111-111111111111', true);
const final = failed('22222222-2222-4222-8222-222222222222', false);
const running = { ...base, id: '33333333-3333-4333-8333-333333333333', kind: 'create', status: 'running', version: 1,
  target: { resource: 'tenant', tenant_id: 'A' }, error: null };

function serve(permissions: string[], operations: unknown[] = [retryable, final, running]) {
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({ subject: 'A:op', roles: ['operator'], permissions })),
    http.get('http://localhost/v3/console/fleet/operations/recent', () => HttpResponse.json({ operations })),
  );
}
const view = () => renderWithApi(<ConsoleAccessBoundary><RecentFleetOperations /></ConsoleAccessBoundary>);

it('lists summary and human-readable targets', async () => {
  serve(['config.write']);
  view();
  expect(await screen.findAllByText('Eliminar definitivamente el grupo sala')).toHaveLength(2);
  expect(screen.getAllByText(/Falló/u).length).toBeGreaterThan(0);
  expect(screen.getByText('Preparar el espacio A')).toBeInTheDocument();
  expect(screen.getAllByText(/por op/u).length).toBeGreaterThan(0);
});

it('cancels a failed operation with its version and replaces the row', async () => {
  serve(['config.write'], [retryable]);
  let body: unknown;
  server.use(http.post('http://localhost/v3/console/fleet/operations/:id/cancel', async ({ request }) => {
    body = await request.json();
    return HttpResponse.json({ ...retryable, status: 'cancelled', version: 3, error: null });
  }));
  view();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ver detalle de Eliminar definitivamente el grupo sala' }));
  await user.click(await screen.findByRole('button', { name: 'Cancelar' }));
  await waitFor(() => { expect(screen.getAllByText(/Cancelada/u).length).toBeGreaterThan(0); });
  expect(screen.getAllByRole('status')[0]).toHaveTextContent('Eliminar definitivamente el grupo sala: cancelada.');
  expect(body).toEqual({ expected_version: 2 });
});

it('sin operaciones, el vacío dice cuándo aparecerá la primera', async () => {
  serve(['config.write'], []);
  view();
  expect(await screen.findByText(/Cuando se cree, detenga o reanude un agente, grupo o espacio/)).toBeInTheDocument();
});

it('offers Reintentar only for resumable operations', async () => {
  serve(['config.write']);
  view();
  const user = userEvent.setup();
  await screen.findAllByText('Eliminar definitivamente el grupo sala');
  const rows = screen.getAllByRole('listitem');
  await user.click(within(rows[0]).getByRole('button', { name: /Ver detalle/u }));
  expect(within(rows[0]).getByRole('button', { name: 'Reintentar' })).toBeEnabled();
  await user.click(within(rows[1]).getByRole('button', { name: /Ver detalle/u }));
  expect(within(rows[1]).queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  expect(within(rows[1]).getByRole('button', { name: 'Cancelar' })).toBeEnabled();
  await user.click(within(rows[2]).getByRole('button', { name: /Ver detalle/u }));
  expect(within(rows[2]).queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  expect(within(rows[2]).getByRole('button', { name: 'Cancelar' })).toBeEnabled();
});

it('stays quiet when the server predates the route', async () => {
  serve(['config.write']);
  server.use(http.get('http://localhost/v3/console/fleet/operations/recent', () => new HttpResponse(null, { status: 404 })));
  view();
  expect(await screen.findByText(/no publica las operaciones de flota recientes/u)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('disables every control without config.write', async () => {
  serve(['config.read']);
  view();
  const user = userEvent.setup();
  await screen.findAllByText('Eliminar definitivamente el grupo sala');
  await user.click(screen.getAllByRole('button', { name: /Ver detalle/u })[0]);
  await waitFor(() => { for (const button of screen.getAllByRole('button', { name: /^(Reintentar|Reanudar|Cancelar)$/u })) expect(button).toBeDisabled(); });
  expect(screen.getByRole('button', { name: 'Releer' })).toBeEnabled();
});
