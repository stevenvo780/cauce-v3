import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { LandingPage } from './LandingPage';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';

/** The four landing-page readings, all healthy. The starting point for the two controls. */
function todoSano() {
  return [
    http.get('http://localhost/v3/status', () => HttpResponse.json({ online: 15, queued: 0, dead_letters: 0, outbox_pending: 0, presence: [] })),
    http.get('http://localhost/v3/console/queues', () => HttpResponse.json({ observed_at: new Date().toISOString(), pending: 0, retrying: 0, dead: 0, items: [] })),
    http.get('http://localhost/v3/console/quotas', () => HttpResponse.json({
      observed_at: new Date().toISOString(),
      collectors: [{ host: 'kratos', stale: false, age_seconds: 12 }],
      providers: [{ provider: 'claude', severity: 'ok', effective_remaining_percent: 90 }],
      paused_accounts: [],
    })),
    http.get('http://localhost/v3/console/activity', () => HttpResponse.json({
      observed_at: new Date().toISOString(),
      totals: { agents: 15, in_flight: 0, queued: 0, retrying: 0, overdue_in_flight: 0, by_state: { idle: 15 }, flagged: {} },
      agents: [],
    })),
  ];
}

it('resume la consola entera: flota, colas y cuotas, con los números PRIMERO', async () => {
  renderWithApi(<LandingPage />);

  expect(await screen.findByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeInTheDocument();
  // The aggregate metrics, with their real snapshot number (mockStatus.online = 99).
  expect(await screen.findByText('99')).toBeInTheDocument();

  // And they go BEFORE the alerts band in document order. At 1280×900, the eight alert bands
  // occupied ~580 px and pushed the four numbers off the bottom edge: the aggregate summary was
  // invisible when the user came in for it.
  const banda = await screen.findByRole('region', { name: /lo que exige atención/i });
  const numeros = screen.getByText('99').closest('.metrics-grid');
  expect(numeros).not.toBeNull();
  if (numeros) {
    // `compareDocumentPosition` with FOLLOWING = the numbers are before the band.
    expect(numeros.compareDocumentPosition(banda) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

it('no imprime rutas de endpoint en la pantalla del operador: van al title=', async () => {
  renderWithApi(<LandingPage />);

  const banda = await screen.findByRole('region', { name: /lo que exige atención/i });
  await within(banda).findByText(/entrega muerta en la DLQ/i);
  // The path is needed to cross-check a doubtful number; it is not needed to read the screen.
  expect(banda.textContent).not.toMatch(/GET \/v3\/console\//);
});

it('agrupa los avisos por la vista que los resuelve: una fila por destino, no una por hallazgo', async () => {
  server.use(
    http.get('http://localhost/v3/console/queues', () => HttpResponse.json({ observed_at: new Date().toISOString(), pending: 0, retrying: 0, dead: 0, items: [] })),
    http.get('http://localhost/v3/console/quotas', () => HttpResponse.json({
      observed_at: new Date().toISOString(),
      collectors: [{ host: 'kratos', stale: true, age_seconds: 9000 }],
      providers: [
        { provider: 'codex', severity: 'exhausted', effective_remaining_percent: 0 },
        { provider: 'claude', severity: 'warn', effective_remaining_percent: 12 },
      ],
      paused_accounts: [{ account_id: 'a-1', provider: 'codex' }],
    })),
    http.get('http://localhost/v3/console/activity', () => HttpResponse.json({
      observed_at: new Date().toISOString(),
      totals: {
        agents: 15, in_flight: 3, queued: 1, retrying: 0, overdue_in_flight: 41,
        by_state: { stalled: 5 }, flagged: { queued_without_consumer: 2 },
      },
      agents: [],
    })),
  );
  renderWithApi(<LandingPage />);

  const banda = await screen.findByRole('region', { name: /lo que exige atención/i });
  // Seven findings —three in "The fleet now", four in "Accounts and quotas"— and TWO rows.
  await within(banda).findByText(/cosas que atender en La flota ahora/i);
  const filas = banda.querySelectorAll('.landing-alerta');
  expect(filas.length).toBeLessThanOrEqual(3);
  const enlaces = within(banda).getAllByRole('link').map((enlace) => enlace.getAttribute('href'));
  // Not a single repeated destination: that was what made four identical bands point at the same place.
  expect(new Set(enlaces).size).toBe(enlaces.length);
});

it('los arneses siguen estando, plegados: es lo que era la vista «Adapters»', async () => {
  renderWithApi(<LandingPage />);

  const tira = await screen.findByText(/arneses declarados/i);
  expect(tira).toBeInTheDocument();
  // The content of the retired view is present in the DOM, not lost.
  expect(await screen.findByRole('heading', { name: 'Hermes' })).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Codex' })).toBeInTheDocument();
});

it('escribe las alertas que el snapshot acredita, con su enlace a la vista que las resuelve', async () => {
  // The demo snapshot ships 1 dead letter, so the DLQ alert must surface.
  renderWithApi(<LandingPage />);

  const banda = await screen.findByRole('region', { name: /lo que exige atención/i });
  const dlq = await within(banda).findByText(/entrega muerta en la DLQ/i);
  expect(dlq).toBeInTheDocument();
  expect(within(banda).getByRole('link', { name: /revisar alerta en queues & dlq/i })).toHaveAttribute('href', '/queues');
});

/**
 * The negative control of the screen, not of the function: a landing page that lost a reading
 * must NOT read like a healthy fleet. Without this test, `resumenPortada` could be separating
 * the two cases correctly and the screen still paint them identically.
 */
it('con una fuente caída NO dice «sin incidencias»: lo declara ausente', async () => {
  // Everything else healthy on purpose. This is the only way for the test to bite: with even one
  // live alert in the band the reassuring phrase would not draw the same and the failure would
  // pass. Here there is no incident and the ONLY reason to stay silent is the reading that did
  // not arrive. The 503 goes FIRST: `server.use()` prepends and the first in the list wins, so
  // putting it after `todoSano()` would leave it ineffective.
  server.use(http.get('http://localhost/v3/console/quotas', () => HttpResponse.json({ error: 'boom' }, { status: 503 })), ...todoSano());
  renderWithApi(<LandingPage />);

  const banda = await screen.findByRole('region', { name: /lo que exige atención/i });
  expect(await within(banda).findByText(/una fuente no contestó/i)).toBeInTheDocument();
  expect(within(banda).getByText(/Consumo de cuotas/)).toBeInTheDocument();
  expect(within(banda).queryByText(/^Sin incidencias/)).not.toBeInTheDocument();
});

it('con TODO sano y leído entero sí se permite decir «sin incidencias»', async () => {
  server.use(...todoSano());
  renderWithApi(<LandingPage />);

  const banda = await screen.findByRole('region', { name: /lo que exige atención/i });
  expect(await within(banda).findByText(/^Sin incidencias/)).toBeInTheDocument();
  expect(within(banda).queryByText(/no contestó/i)).not.toBeInTheDocument();
});
