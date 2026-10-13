import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';
import { RegistrationForm } from './RegistrationForm';

async function completeForm() {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Tu nombre' }), 'Nueva persona');
  await user.type(screen.getByRole('textbox', { name: 'Correo' }), 'new@example.test');
  await user.type(screen.getByLabelText('Contraseña'), 'synthetic-password');
  await user.type(screen.getByRole('textbox', { name: 'Nombre de empresa' }), 'Nueva empresa');
  await user.type(screen.getByRole('textbox', { name: 'Identificador de empresa' }), 'new-company');
  await user.click(screen.getByRole('button', { name: 'Crear cuenta y empresa' }));
}
it('un registro rechazado nunca inicia sesión y limpia la contraseña', async () => {
  const login = vi.fn(); server.use(http.post('*/v3/auth/register', () => HttpResponse.json({ error: 'conflict', message: 'Ese correo ya está registrado.' }, { status: 409 })));
  renderWithApi(<RegistrationForm onLogin={login} onCancel={vi.fn()} />); await completeForm();
  expect(await screen.findByRole('alert')).toHaveTextContent('el correo o el identificador de empresa ya están en uso');
  expect(login).not.toHaveBeenCalled(); expect(screen.getByLabelText('Contraseña')).toHaveValue('');
});
it.each([
  [400, 'invalid_request', 'Revisa correo, nombre, contraseña'],
  [429, 'too_many_requests', 'Demasiados intentos de registro'],
  [503, 'registration_unavailable', 'El registro no está disponible ahora'],
])('traduce el %i del servidor por su estado y nunca muestra su mensaje', async (status, error, text) => {
  server.use(http.post('*/v3/auth/register', () => HttpResponse.json({ error, message: 'registration is invalid' }, { status })));
  renderWithApi(<RegistrationForm onLogin={vi.fn()} onCancel={vi.fn()} />); await completeForm();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(text); expect(alert).not.toHaveTextContent('registration is invalid');
});
it('el identificador acepta exactamente lo que el servidor admite en el registro', () => {
  renderWithApi(<RegistrationForm onLogin={vi.fn()} onCancel={vi.fn()} />);
  const slug = screen.getByRole('textbox', { name: 'Identificador de empresa' });
  const pattern = new RegExp(`^(?:${slug.getAttribute('pattern') ?? ''})$`, 'v');
  for (const accepted of ['ab', 'acme-2', `a${'b'.repeat(62)}`]) expect(pattern.test(accepted)).toBe(true);
  for (const refused of ['a', 'acme_corp', 'Acme', '1acme', `a${'b'.repeat(63)}`]) expect(pattern.test(refused)).toBe(false);
});
it('creación confirmada y login fallido se presentan como resultados separados', async () => {
  const login = vi.fn().mockRejectedValue(new Error('invalid credentials'));
  server.use(http.post('*/v3/auth/register', () => HttpResponse.json({ user: { id: 'person', username: 'owner', email: 'new@example.test', name: 'Nueva persona' },
    company: { id: 'new-company', slug: 'new-company', name: 'Nueva empresa' }, hub: { id: 'NewHub', name: 'Nueva empresa' } }, { status: 201 })));
  renderWithApi(<RegistrationForm onLogin={login} onCancel={vi.fn()} />); await completeForm();
  expect(await screen.findByText('Cuenta y empresa creadas.')).toBeVisible();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('No se pudo iniciar sesión automáticamente. Inicia sesión con el correo registrado.');
  expect(alert).not.toHaveTextContent('invalid credentials');
  expect(login).toHaveBeenCalledWith('new@example.test', 'synthetic-password');
});
it('una respuesta sin recibo de creación no declara empresa creada', async () => {
  const login = vi.fn(); server.use(http.post('*/v3/auth/register', () => HttpResponse.json({}, { status: 201 })));
  renderWithApi(<RegistrationForm onLogin={login} onCancel={vi.fn()} />); await completeForm();
  expect(await screen.findByRole('alert')).toHaveTextContent('El servidor no confirmó');
  expect(screen.queryByText('Cuenta y empresa creadas.')).not.toBeInTheDocument(); expect(login).not.toHaveBeenCalled();
});
