import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';
import { nextStep } from './agent-menu.test-helpers';

const snapshot: ConfigurationSnapshot = {
  revision: 4, tenants: [{ id: 'A', display_name: 'Tenant A' }], agents: [], memberships: [],
  rooms: [{ tenant_id: 'A', id: 'grp.a', display_name: 'Grupo A', enabled: true }], harness_definitions: [{ id: 'codex' }],
};

beforeEach(() => {
  window.history.replaceState({}, '', '/config?seccion=agentes');
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'Hub:operator', roles: ['operator'], permissions: ['config.read', 'config.write'],
    })),
    http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({ hosts: [] })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({
      available: false, actions: [], placements: [], reason: 'executor_unconfigured',
    })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
  );
});

async function openWizard() {
  const user = userEvent.setup();
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
  await user.click(await screen.findByRole('button', { name: 'Añadir agente' }));
  return user;
}

function currentStep() {
  return within(screen.getByRole('list', { name: 'Pasos del alta' })).getAllByRole('listitem')
    .findIndex((item) => item.getAttribute('aria-current') === 'step') + 1;
}

it('does not leave the identity step until the workspace, alias and name are valid', async () => {
  const user = await openWizard();
  await nextStep(user);
  expect(await screen.findByRole('alert')).toHaveTextContent('Elige un espacio de trabajo');
  expect(currentStep()).toBe(1);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Espacio de trabajo' }), 'A');
  await user.type(screen.getByRole('textbox', { name: 'Alias' }), 'Bad Alias');
  await nextStep(user);
  expect(screen.getByRole('alert')).toHaveTextContent(/El alias debe empezar con una letra minúscula/);
  await user.clear(screen.getByRole('textbox', { name: 'Alias' }));
  await user.type(screen.getByRole('textbox', { name: 'Alias' }), 'worker');
  await nextStep(user);
  expect(screen.getByRole('alert')).toHaveTextContent('Indica un nombre visible');
  expect(currentStep()).toBe(1);
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Worker');
  await nextStep(user);
  expect(currentStep()).toBe(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('validates the capacity and the all-or-nothing runtime fields before the groups step', async () => {
  const user = await openWizard();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Espacio de trabajo' }), 'A');
  await user.type(screen.getByRole('textbox', { name: 'Alias' }), 'worker');
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Worker');
  await nextStep(user);
  await user.clear(screen.getByRole('spinbutton', { name: 'Máximo de entregas concurrentes' }));
  await user.type(screen.getByRole('spinbutton', { name: 'Máximo de entregas concurrentes' }), '500');
  await nextStep(user);
  expect(screen.getByRole('alert')).toHaveTextContent('La capacidad debe ser un entero entre 1 y 100');
  await user.clear(screen.getByRole('spinbutton', { name: 'Máximo de entregas concurrentes' }));
  await user.type(screen.getByRole('spinbutton', { name: 'Máximo de entregas concurrentes' }), '3');
  await user.click(screen.getByText('Entorno de ejecución (opcional)'));
  await user.type(screen.getByRole('textbox', { name: 'Nombre del contenedor' }), 'box');
  await nextStep(user);
  expect(screen.getByRole('alert')).toHaveTextContent('Completa los cuatro campos del entorno de ejecución');
  expect(currentStep()).toBe(2);
});

it('goes back without losing what was typed and reviews the whole draft before creating', async () => {
  const user = await openWizard();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Espacio de trabajo' }), 'A');
  await user.type(screen.getByRole('textbox', { name: 'Alias' }), 'worker');
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Worker');
  await nextStep(user, 2);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Grupo inicial (opcional)' }), 'grp.a');
  await nextStep(user);
  const summary = screen.getByLabelText('Resumen del alta');
  expect(summary).toHaveTextContent('Tenant A');
  expect(summary).toHaveTextContent('worker');
  expect(summary).toHaveTextContent('Grupo A · rol agent');
  expect(screen.getByRole('button', { name: 'Crear registro' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Atrás' }));
  expect(screen.getByRole('combobox', { name: 'Grupo inicial (opcional)' })).toHaveValue('grp.a');
});

it('offers «Solo preparar, sin desplegar» in the same modal and explains each option', async () => {
  const user = await openWizard();
  expect(screen.getByText(/Lo da de alta en el registro, deshabilitado/)).toBeInTheDocument();
  expect(screen.getByText(/Deja listo su entorno de ejecución en una computadora/)).toBeInTheDocument();
  await user.click(screen.getByRole('radio', { name: /Solo preparar, sin desplegar/ }));
  expect(await screen.findByRole('region', { name: 'Alta operativa de agente' })).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Pasos del alta' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('radio', { name: /Registrar el agente/ }));
  expect(screen.getByRole('list', { name: 'Pasos del alta' })).toBeInTheDocument();
});
