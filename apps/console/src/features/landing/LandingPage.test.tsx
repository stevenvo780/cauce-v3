import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { LandingPage } from './LandingPage';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';

/** Las cuatro lecturas de la portada, todas sanas. El punto de partida de los dos controles. */
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
  // Las métricas de conjunto, con su número real del snapshot (mockStatus.online = 99).
  expect(await screen.findByText('99')).toBeInTheDocument();

  // 🔴 Y van ANTES de la banda de avisos en el orden del documento. Medido el 2026-08-23 a
  // 1280×900, las ocho bandas de aviso ocupaban ~580 px y empujaban los cuatro números fuera del
  // borde inferior: el resumen de conjunto no se veía al entrar al resumen de conjunto.
  const banda = await screen.findByRole('region', { name: /lo que exige atención/i });
  const numeros = screen.getByText('99').closest('.metrics-grid')!;
  // `compareDocumentPosition` con FOLLOWING = los números están antes que la banda.
  expect(numeros.compareDocumentPosition(banda) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('no imprime rutas de endpoint en la pantalla del operador: van al title=', async () => {
  renderWithApi(<LandingPage />);

  const banda = await screen.findByRole('region', { name: /lo que exige atención/i });
  await within(banda).findByText(/entrega muerta en la DLQ/i);
  // La ruta hace falta para contrastar un número dudoso; no hace falta para leer la pantalla.
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
  // Siete hallazgos —tres en «La flota ahora», cuatro en «Cuentas y cuotas»— y DOS filas.
  await within(banda).findByText(/cosas que atender en La flota ahora/i);
  const filas = banda.querySelectorAll('.landing-alerta');
  expect(filas.length).toBeLessThanOrEqual(3);
  const enlaces = within(banda).getAllByRole('link').map((enlace) => enlace.getAttribute('href'));
  // Ni un destino repetido: era lo que hacía que cuatro bandas idénticas apuntaran al mismo sitio.
  expect(new Set(enlaces).size).toBe(enlaces.length);
});

it('los arneses siguen estando, plegados: es lo que era la vista «Adapters»', async () => {
  renderWithApi(<LandingPage />);

  const tira = await screen.findByText(/arneses declarados/i);
  expect(tira).toBeInTheDocument();
  // El contenido de la vista retirada está presente en el DOM, no perdido.
  expect(await screen.findByRole('heading', { name: 'Hermes' })).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Codex' })).toBeInTheDocument();
});

it('escribe las alertas que el snapshot acredita, con su enlace a la vista que las resuelve', async () => {
  // El snapshot de demostración trae 1 dead letter, así que la alerta de DLQ tiene que salir.
  renderWithApi(<LandingPage />);

  const banda = await screen.findByRole('region', { name: /lo que exige atención/i });
  const dlq = await within(banda).findByText(/entrega muerta en la DLQ/i);
  expect(dlq).toBeInTheDocument();
  expect(within(banda).getByRole('link', { name: /revisar alerta en queues & dlq/i })).toHaveAttribute('href', '/queues');
});

/**
 * El control negativo de la pantalla, no ya de la función: una portada a la que se le cayó una
 * lectura NO puede leerse igual que una flota sana. Sin esta prueba, `resumenPortada` podría estar
 * separando bien los dos casos y la pantalla seguir pintándolos iguales.
 */
it('con una fuente caída NO dice «sin incidencias»: lo declara ausente', async () => {
  // TODO lo demás sano a propósito. Es la única forma de que esta prueba muerda: con una sola
  // alerta viva en la banda, la frase tranquilizadora no se dibujaría igual y el fallo pasaría.
  // Acá no hay ninguna incidencia y la ÚNICA razón para callarse es la lectura que no llegó.
  // El 503 va PRIMERO: `server.use()` antepone y gana el primero de la lista, así que ponerlo
  // detrás de `todoSano()` lo dejaría sin efecto y la prueba pasaría sin probar nada.
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
