import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { ConfigAdministration as ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
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
  expect(screen.getByText('Opciones de alta: habilitado · no es hub').closest('details')).not.toHaveAttribute('open');
  expect(screen.getByLabelText('Es hub')).not.toBeVisible();
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

it('pliega los valores iniciales y conserva los personalizados al cerrar y cambiar de recurso', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  const options = await screen.findByText('Opciones de alta: habilitado · rol agent');
  expect(options.closest('details')).not.toHaveAttribute('open');
  expect(screen.getByLabelText('Rol de permisos')).not.toBeVisible();
  expect(screen.getByLabelText('Habilitado')).not.toBeVisible();
  await user.click(options);
  expect(screen.getByRole('textbox', { name: 'Rol de permisos' })).toHaveValue('agent');
  await user.clear(screen.getByRole('textbox', { name: 'Rol de permisos' }));
  await user.type(screen.getByRole('textbox', { name: 'Rol de permisos' }), 'observer');
  await user.click(screen.getByRole('checkbox', { name: 'Habilitado' }));
  await user.click(options);
  expect(options).toHaveTextContent('Opciones de alta: deshabilitado · rol observer');
  expect(screen.getByLabelText('Rol de permisos')).not.toBeVisible();
  await user.selectOptions(screen.getByLabelText('Recurso a crear'), 'room');
  expect(options).toHaveTextContent(/^Opciones de alta: deshabilitado$/);
  await user.selectOptions(screen.getByLabelText('Recurso a crear'), 'membership');
  expect(options).toHaveTextContent('Opciones de alta: deshabilitado · rol observer');
  expect(changes).toEqual([]);

  await user.type(screen.getByLabelText('Tenant'), 'Acme');
  await user.type(screen.getByLabelText('Room'), 'grp.acme');
  await user.type(screen.getByLabelText('Alias'), 'reviewer');
  await user.click(screen.getByRole('button', { name: /previsualizar el alta/i }));
  expect(await screen.findByLabelText('Dry-run del alta')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^Crear$/ }));
  expect(await screen.findByText(/creado en la revisión 2/i)).toBeInTheDocument();
  const mutation = {
    resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'reviewer',
    value: { role: 'observer', enabled: false },
  };
  expect(changes).toEqual([
    { dry_run: true, expected_revision: 1, mutation },
    { dry_run: false, expected_revision: 1, mutation },
  ]);
  expect(options).toHaveTextContent('Opciones de alta: habilitado · rol agent');
});

it.each(['Observer', ''])('permite corregir el rol inválido «%s» sin ocultar el error al plegar opciones', async (invalidRole) => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  const options = await screen.findByText('Opciones de alta: habilitado · rol agent');
  await user.type(screen.getByLabelText('Tenant'), 'Acme');
  await user.type(screen.getByLabelText('Room'), 'grp.acme');
  await user.type(screen.getByLabelText('Alias'), 'reviewer');
  await user.click(options);
  await user.clear(screen.getByRole('textbox', { name: 'Rol de permisos' }));
  if (invalidRole) await user.type(screen.getByRole('textbox', { name: 'Rol de permisos' }), invalidRole);
  await user.click(options);

  expect(options.closest('details')).not.toHaveAttribute('open');
  expect(options).toHaveTextContent(`Opciones de alta: habilitado · rol ${invalidRole || 'sin definir'}`);
  expect(screen.getByLabelText('Rol de permisos')).not.toBeVisible();
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent(/El rol de permisos debe ser minúsculas y empezar con letra/);
  const create = screen.getByRole('button', { name: /^Crear$/ });
  const preview = screen.getByRole('button', { name: /previsualizar el alta/i });
  expect(create).toBeDisabled();
  expect(preview).toBeDisabled();
  await user.click(create);
  await user.click(preview);
  expect(changes).toEqual([]);

  await user.click(options);
  const role = screen.getByRole('textbox', { name: 'Rol de permisos' });
  expect(role).toBeVisible();
  await user.clear(role);
  await user.type(role, 'observer');
  await user.click(options);
  expect(options).toHaveTextContent('Opciones de alta: habilitado · rol observer');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(create).toBeEnabled();
  expect(preview).toBeEnabled();
  expect(changes).toEqual([]);
  await user.click(create);
  expect(await screen.findByText(/creado en la revisión 2/i)).toBeInTheDocument();
  expect(changes).toEqual([{
    dry_run: false, expected_revision: 1,
    mutation: {
      resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'reviewer',
      value: { role: 'observer', enabled: true },
    },
  }]);
});

it('mantiene visible el hub elegido en el resumen y lo envía aunque las opciones estén cerradas', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.selectOptions(await screen.findByLabelText('Recurso a crear'), 'tenant');
  const options = screen.getByText('Opciones de alta: habilitado · no es hub');
  await user.click(options);
  await user.click(screen.getByRole('checkbox', { name: 'Es hub' }));
  await user.click(options);
  expect(options).toHaveTextContent('Opciones de alta: habilitado · es hub');
  expect(screen.getByLabelText('Es hub')).not.toBeVisible();
  await user.type(screen.getByLabelText('Tenant'), 'Acme');
  await user.click(screen.getByRole('button', { name: /^Crear$/ }));
  expect(await screen.findByText(/Tenant creado en la revisión 2/i)).toBeInTheDocument();
  expect(changes[0]).toEqual({
    dry_run: false, expected_revision: 1,
    mutation: { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: null, is_hub: true, enabled: true } },
  });
});

it('deja los tres permisos entre tenants visibles y denegados por defecto', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.selectOptions(await screen.findByLabelText('Recurso a crear'), 'acl_edge');
  expect(screen.getByLabelText('Habilitado')).not.toBeVisible();
  for (const name of ['Ruta', 'Lectura', 'Control']) {
    const permission = screen.getByRole('checkbox', { name });
    expect(permission).toBeVisible();
    expect(permission).not.toBeChecked();
    expect(permission.closest('details')).toBeNull();
  }
  await user.type(screen.getByLabelText('Desde el tenant'), 'Acme');
  await user.type(screen.getByLabelText('Hacia el tenant'), 'Other');
  await user.click(screen.getByRole('button', { name: /^Crear$/ }));
  expect(await screen.findByText(/creado en la revisión 2/i)).toBeInTheDocument();
  expect(changes[0]).toEqual({
    dry_run: false, expected_revision: 1,
    mutation: {
      resource: 'acl_edge', action: 'create', from_tenant: 'Acme', to_tenant: 'Other',
      value: { enabled: true, allow_route: false, allow_read: false, allow_control: false },
    },
  });
});

it.each(['denied', 'unknown'])('abrir opciones no habilita controles con permiso %s', async (permission) => {
  server.use(http.get('*/v3/console/access', () => permission === 'denied'
    ? HttpResponse.json({ subject: 'Acme:reviewer', roles: ['agent'], permissions: ['message.publish'] })
    : HttpResponse.json({ error: 'internal' }, { status: 500 })));
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  const options = await screen.findByText('Opciones de alta: habilitado · rol agent');
  await user.click(options);
  expect(screen.getByRole('textbox', { name: 'Rol de permisos' })).toBeDisabled();
  const enabled = screen.getByRole('checkbox', { name: 'Habilitado' });
  expect(enabled).toBeDisabled();
  await user.click(enabled);
  expect(enabled).toBeChecked();
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
