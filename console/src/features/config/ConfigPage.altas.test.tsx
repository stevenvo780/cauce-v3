import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { ConfigPage } from './ConfigPage';
import { renderWithApi } from '../../test/render';
import { irA, recordChanges, type ChangeRequest } from './ConfigPage.test-helpers';

/**
 * The onboarding paths that the suite was not walking: creating a TENANT (the first thing anybody
 * does on an empty bus) and the raw editor's refusal to send text that is not a mutation.
 */

const ESPACIOS = /espacios y miembros/i;
const HISTORIAL = /historial y json/i;

it('da de alta un TENANT desde el formulario y deja el alta vacía para no repetirla', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ESPACIOS);

  await user.selectOptions(await screen.findByLabelText(/recurso a crear/i), 'tenant');
  await user.type(screen.getByLabelText('Tenant'), 'Acme');
  await user.type(screen.getByLabelText('Nombre'), 'Acme Corp');
  await user.click(screen.getByRole('button', { name: /^Crear$/ }));

  expect(await screen.findByText(/Tenant creado en la revisión 2/i)).toBeInTheDocument();
  expect(changes.at(-1)?.mutation).toEqual({
    resource: 'tenant', action: 'create', id: 'Acme',
    value: { display_name: 'Acme Corp', is_hub: false, enabled: true },
  });
  // The tenant now EXISTS: leaving the fields loaded rearms "Crear" over it and earns a 409.
  expect(screen.getByLabelText('Tenant')).toHaveValue('');
  expect(screen.getByRole('button', { name: /^Crear$/ })).toBeDisabled();
});

it('un tenant con nombre inválido no llega a salir: lo dice y no manda nada', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ESPACIOS);

  await user.selectOptions(await screen.findByLabelText(/recurso a crear/i), 'tenant');
  await user.type(screen.getByLabelText('Tenant'), '1-no-empieza-con-letra');

  expect(screen.getByRole('alert')).toHaveTextContent(/debe empezar con letra/i);
  expect(screen.getByRole('button', { name: /^Crear$/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /previsualizar el alta/i })).toBeDisabled();
  expect(changes).toEqual([]);
});

it('el editor crudo rechaza lo que no es una mutación sin gastar un viaje al servidor', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, HISTORIAL);

  const editor = await screen.findByLabelText(/mutación/i);
  await user.clear(editor);
  await user.type(editor, '{{ esto no es json');
  await user.click(screen.getByRole('button', { name: /preview \/ dry-run/i }));

  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(changes).toEqual([]);
});
