import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { App } from '../../App';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';

/**
 * Las dos pruebas que dejó la verificación adversarial del 2026-08-22 sobre
 * `consola/retiradas-20260822`, INVERTIDAS: allí afirmaban el defecto —pasaban contra el código
 * averiado— y acá afirman la conducta correcta, así que fallan contra aquel código y sólo pasan
 * con el arreglo puesto.
 *
 * El defecto: el commit 252cf3c («el menú deja de prometer vistas que ese usuario no puede abrir»)
 * dejó «Configuración y altas» inerte, con su motivo, para quien no tiene `config.write`. La
 * portada nueva —que ahora es la PRIMERA pantalla de todo el mundo— volvía a prometerla como
 * enlace vivo, porque su lista de atajos estaba escrita a mano y no pasaba por `navAvailability`.
 * El verificador hizo clic y navegó. Y el panel decía «Ocho vistas» omitiendo «Ultimate Terminal»,
 * que sí es entrada de menú.
 *
 * El arreglo es de FUENTE, no de rótulo: las dos listas son ahora una sola (`NAV_ENTRIES` en
 * `src/nav.ts`) y la portada pregunta por la misma `useNavAvailability()` que la barra lateral.
 */
it('la portada NO ofrece /config a quien la barra lateral se lo niega: mismo veredicto en las dos', async () => {
  server.use(
    http.get('http://localhost/v3/console/access', () =>
      HttpResponse.json({
        subject: 'Miguel:janus', roles: [], permissions: ['message.publish'],
        observed_at: new Date().toISOString(),
      })),
  );
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  const lateral = within(nav).getByRole('link', { name: /configuración y altas/i });
  await waitFor(() => expect(lateral).toHaveAttribute('aria-disabled', 'true'));

  // El MISMO rótulo en la portada, con el MISMO veredicto y el motivo a la vista.
  const lista = within(await screen.findByRole('list', { name: /el resto de la consola/i }));
  const atajo = lista.getByRole('link', { name: /configuración y altas/i });
  await waitFor(() => expect(atajo).toHaveAttribute('aria-disabled', 'true'));
  expect(atajo).toHaveAttribute('title', expect.stringContaining('permiso de control'));
  expect(atajo.textContent).toMatch(/permiso de control/i);

  // Y el clic NO navega. Es lo que el verificador midió al revés: hizo clic y llegó a /config.
  await userEvent.click(atajo);
  expect(window.location.pathname).toBe('/');
});

it('la portada SÍ ofrece /config a quien la barra lateral se lo permite', async () => {
  // Control negativo del control: sin esto, esconder o inutilizar el atajo SIEMPRE también pasaría
  // la prueba de arriba, y la portada quedaría rota para el operador que sí tiene el permiso.
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  const lista = within(await screen.findByRole('list', { name: /el resto de la consola/i }));
  const atajo = lista.getByRole('link', { name: /configuración y altas/i });
  await waitFor(() => expect(atajo).not.toHaveAttribute('aria-disabled'));
  await userEvent.click(atajo);
  expect(window.location.pathname).toBe('/config');
});

it('«el resto de la consola» son las SIETE entradas del menú, «Ultimate Terminal» incluida', async () => {
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  const lista = await screen.findByRole('list', { name: /el resto de la consola/i });
  const rotulos = within(lista).getAllByRole('link').map((enlace) => enlace.querySelector('strong')?.textContent);
  expect(rotulos).toEqual([
    'La flota ahora',
    'Cuentas y cuotas',
    'Mensajes',
    'Queues & DLQ',
    'Señales y auditoría',
    'Configuración y altas',
    'Ultimate Terminal',
  ]);
  // La portada no se ofrece a sí misma como atajo, y el rótulo del recuento SE DERIVA de la lista.
  expect(rotulos).not.toContain('Portada');
  expect(await screen.findByText(/Siete vistas, cada una con la pregunta que responde/)).toBeInTheDocument();
});

/**
 * La barra lateral y la portada dibujan el MISMO menú. Esta es la prueba que impide que vuelvan a
 * divergir: no compara contra una lista escrita a mano —eso es justo lo que falló— sino a las dos
 * copias entre sí.
 */
it('los rótulos de la portada son exactamente los de la barra lateral, menos la portada misma', async () => {
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  const lateral = within(nav).getAllByRole('link').map((enlace) => enlace.textContent);
  const lista = await screen.findByRole('list', { name: /el resto de la consola/i });
  const portada = within(lista).getAllByRole('link').map((enlace) => enlace.querySelector('strong')?.textContent);

  expect(portada).toEqual(lateral.filter((rotulo) => rotulo !== 'Portada'));
});
