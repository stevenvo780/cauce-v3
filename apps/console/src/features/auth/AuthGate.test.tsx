import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { App } from '../../App';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

const SESSION = 'http://localhost/v3/auth/session';

it('sin sesión no se renderiza NADA de la consola, sólo la pantalla de login', async () => {
  server.use(http.get(SESSION, () => HttpResponse.json({ authenticated: false })));
  renderWithApi(<App />);

  expect(await screen.findByRole('link', { name: /iniciar sesión/i })).toHaveAttribute(
    'href',
    'http://localhost/v3/auth/login',
  );
  // La garantía que importa: la navegación y el contenido de la consola no existen en el DOM.
  expect(screen.queryByRole('navigation', { name: /principal/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /^cuentas de ia$/i })).not.toBeInTheDocument();
});

it('muestra el motivo que manda el servidor cuando lo hay', async () => {
  server.use(http.get(SESSION, () => HttpResponse.json({
    authenticated: false,
    reason: 'La sesión venció por inactividad.',
  })));
  renderWithApi(<App />);

  expect(await screen.findByText(/venció por inactividad/i)).toBeInTheDocument();
});

it('un gateway que no contesta NO es una autorización: falla cerrado con reintento', async () => {
  server.use(http.get(SESSION, () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
  renderWithApi(<App />);

  expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo verificar la sesión/i);
  expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: /principal/i })).not.toBeInTheDocument();
});

it('con sesión válida deja pasar y publica la identidad y el cierre de sesión', async () => {
  server.use(http.get(SESSION, () => HttpResponse.json({
    authenticated: true,
    subject: 'steven@elenxos.com',
    csrf_token: 'x'.repeat(32),
  })));
  renderWithApi(<App />);

  expect(await screen.findByText('steven@elenxos.com')).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: /principal/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /cerrar sesión/i })).toBeInTheDocument();
});

it('cerrar sesión vuelve a preguntarle al servidor y devuelve a la pantalla de login', async () => {
  let loggedIn = true;
  server.use(
    http.get(SESSION, () => HttpResponse.json(
      loggedIn ? { authenticated: true, subject: 'steven@elenxos.com', csrf_token: 'x'.repeat(32) } : { authenticated: false },
    )),
    http.post('http://localhost/v3/auth/logout', () => {
      loggedIn = false;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<App />);

  await user.click(await screen.findByRole('button', { name: /cerrar sesión/i }));

  // No se cree su propio optimismo: el estado sale de volver a leer /v3/auth/session.
  expect(await screen.findByRole('link', { name: /iniciar sesión/i })).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: /principal/i })).not.toBeInTheDocument();
});

it('en modo contraseña muestra el formulario y entra con las credenciales correctas', async () => {
  let loggedIn = false;
  server.use(
    http.get(SESSION, () => HttpResponse.json(loggedIn
      ? { authenticated: true, login_mode: 'password', subject: 'steven@elenxos.com', name: 'Steven', csrf_token: 'x'.repeat(32) }
      : { authenticated: false, login_mode: 'password' })),
    http.post('http://localhost/v3/auth/login', async ({ request }) => {
      const body = await request.json() as { email: string; password: string };
      if (body.password !== 'la-buena') {
        return HttpResponse.json({ error: 'unauthorized', message: 'Correo o contraseña incorrectos.' }, { status: 401 });
      }
      loggedIn = true;
      return HttpResponse.json({ authenticated: true, login_mode: 'password', csrf_token: 'x'.repeat(32) });
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<App />);

  await user.type(await screen.findByLabelText(/correo/i), 'steven@elenxos.com');
  await user.type(screen.getByLabelText(/contraseña/i), 'la-mala');
  await user.click(screen.getByRole('button', { name: /iniciar sesión/i }));

  // Credenciales equivocadas: el mensaje sale DENTRO del formulario y la consola no aparece.
  expect(await screen.findByRole('alert')).toHaveTextContent(/correo o contraseña incorrectos/i);
  expect(screen.queryByRole('navigation', { name: /principal/i })).not.toBeInTheDocument();

  await user.type(screen.getByLabelText(/contraseña/i), 'la-buena');
  await user.click(screen.getByRole('button', { name: /iniciar sesión/i }));

  // El estado no sale del POST: sale de volver a preguntarle a /v3/auth/session.
  expect(await screen.findByRole('navigation', { name: /principal/i })).toBeInTheDocument();
  // La identidad de la barra superior es la PERSONA, no el tenant: nombre y correo, juntos.
  const badge = screen.getByRole('button', { name: /cerrar sesión/i }).closest('.auth-state');
  expect(within(badge as HTMLElement).getByText('Steven')).toBeInTheDocument();
  expect(within(badge as HTMLElement).getByText('steven@elenxos.com')).toBeInTheDocument();
});

it('cuando el gateway no expone el BFF deja pasar pero lo declara a los gritos', async () => {
  // Es el caso REAL de producción hoy (CAUCE_AUTH_PROVIDER=mtls). Bloquear dejaría la consola
  // inservible; dibujar un candado sería mentir. Se pasa, con el aviso permanente.
  server.use(http.get(SESSION, () => HttpResponse.json({ error: 'not_found' }, { status: 404 })));
  renderWithApi(<App />);

  expect(await screen.findByRole('navigation', { name: /principal/i })).toBeInTheDocument();
  expect(screen.getByText(/no tiene login de usuario/i)).toBeInTheDocument();
  expect(screen.getByText(/sin login de verdad/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /cerrar sesión/i })).not.toBeInTheDocument();
});
