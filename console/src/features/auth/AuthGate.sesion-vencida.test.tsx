import { screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { AuthGate } from './AuthGate';
import { useApi } from '../../api/context';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

/**
 * An expired session used to leave the console in limbo for up to 60 s: the 401 painted error
 * cards INSIDE the shell and the gate kept saying `in` until the next poll. What is verified here
 * is the fix and its three limits: a 401 revalidates at once, another failure does not throw
 * anybody out, and neither the gateway without a BFF nor a 401 on the session itself spins.
 */

const SESSION = 'http://localhost/v3/auth/session';
const DATOS = 'http://localhost/v3/status';
const MONTADA = 'la consola quedó montada';

/** Any view of the console: it reads data as soon as it is mounted. */
function Sonda() {
  const api = useApi();
  useEffect(() => { void api.getStatus().catch(() => undefined); }, [api]);
  return <p>{MONTADA}</p>;
}

function sesion(respuesta: () => Response) {
  let sesiones = 0;
  server.use(http.get(SESSION, () => { sesiones += 1; return respuesta(); }));
  return () => sesiones;
}

it('un 401 en una llamada de datos lleva al login SIN esperar el poll de 60 s', async () => {
  let vencida = false;
  const sesiones = sesion(() => HttpResponse.json(vencida
    ? { authenticated: false, reason: 'La sesión venció.' }
    : { authenticated: true, subject: 'steven@elenxos.com', csrf_token: 'x'.repeat(32) }));
  server.use(http.get(DATOS, () => {
    vencida = true;
    return HttpResponse.json({ error: 'unauthorized' }, { status: 401 });
  }));

  renderWithApi(<AuthGate>{() => <Sonda />}</AuthGate>);
  expect(await screen.findByText(MONTADA)).toBeInTheDocument();

  expect(await screen.findByRole('link', { name: /iniciar sesión/i })).toBeInTheDocument();
  expect(screen.getByText(/la sesión venció/i)).toBeInTheDocument();
  // Nothing of the console survives behind the login: that was the limbo.
  expect(screen.queryByText(MONTADA)).not.toBeInTheDocument();
  // And it was the SERVER that decided: the 401 only triggered the second question.
  expect(sesiones()).toBe(2);
});

it('un 500 en los datos NO desloguea: sólo el 401 pregunta de nuevo por la sesión', async () => {
  const sesiones = sesion(() => HttpResponse.json({
    authenticated: true, subject: 'steven@elenxos.com', csrf_token: 'x'.repeat(32),
  }));
  server.use(http.get(DATOS, () => HttpResponse.json({ error: 'boom' }, { status: 500 })));

  renderWithApi(<AuthGate>{() => <Sonda />}</AuthGate>);
  expect(await screen.findByText(MONTADA)).toBeInTheDocument();

  await waitFor(() => { expect(sesiones()).toBe(1); });
  expect(screen.queryByRole('link', { name: /iniciar sesión/i })).not.toBeInTheDocument();
  expect(screen.getByText(MONTADA)).toBeInTheDocument();
});

it('sin BFF el 401 revalida pero no inventa un login que el gateway no tiene', async () => {
  const sesiones = sesion(() => HttpResponse.json({ error: 'not_found' }, { status: 404 }));
  server.use(http.get(DATOS, () => HttpResponse.json({ error: 'unauthorized' }, { status: 401 })));

  renderWithApi(<AuthGate>{() => <Sonda />}</AuthGate>);
  expect(await screen.findByText(MONTADA)).toBeInTheDocument();

  await waitFor(() => { expect(sesiones()).toBe(2); });
  expect(screen.getByText(MONTADA)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /iniciar sesión/i })).not.toBeInTheDocument();
});

it('un 401 de la propia sesión no se realimenta: falla cerrado y pregunta UNA vez', async () => {
  const sesiones = sesion(() => HttpResponse.json({ error: 'unauthorized' }, { status: 401 }));

  renderWithApi(<AuthGate>{() => <Sonda />}</AuthGate>);

  expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo verificar la sesión/i);
  await waitFor(() => { expect(sesiones()).toBe(1); });
  expect(screen.queryByText(MONTADA)).not.toBeInTheDocument();
});
