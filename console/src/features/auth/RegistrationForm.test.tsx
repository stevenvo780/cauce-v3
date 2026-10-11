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
  const login = vi.fn(); server.use(http.post('*/v3/auth/register', () => HttpResponse.json({ message: 'Ese correo ya está registrado.' }, { status: 409 })));
  renderWithApi(<RegistrationForm onLogin={login} onCancel={vi.fn()} />); await completeForm();
  expect(await screen.findByRole('alert')).toHaveTextContent('Ese correo ya está registrado');
  expect(login).not.toHaveBeenCalled(); expect(screen.getByLabelText('Contraseña')).toHaveValue('');
});
it('creación confirmada y login fallido se presentan como resultados separados', async () => {
  const login = vi.fn().mockRejectedValue(new Error('No se pudo abrir la sesión.'));
  server.use(http.post('*/v3/auth/register', () => HttpResponse.json({ user: { id: 'person', username: 'owner', email: 'new@example.test', name: 'Nueva persona' },
    company: { id: 'new-company', slug: 'new-company', name: 'Nueva empresa' }, hub: { id: 'NewHub', name: 'Nueva empresa' } }, { status: 201 })));
  renderWithApi(<RegistrationForm onLogin={login} onCancel={vi.fn()} />); await completeForm();
  expect(await screen.findByText('Cuenta y empresa creadas.')).toBeVisible();
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo abrir la sesión. Inicia sesión con el correo registrado.');
  expect(login).toHaveBeenCalledWith('new@example.test', 'synthetic-password');
});
it('una respuesta sin recibo de creación no declara empresa creada', async () => {
  const login = vi.fn(); server.use(http.post('*/v3/auth/register', () => HttpResponse.json({}, { status: 201 })));
  renderWithApi(<RegistrationForm onLogin={login} onCancel={vi.fn()} />); await completeForm();
  expect(await screen.findByRole('alert')).toHaveTextContent('El servidor no confirmó');
  expect(screen.queryByText('Cuenta y empresa creadas.')).not.toBeInTheDocument(); expect(login).not.toHaveBeenCalled();
});
