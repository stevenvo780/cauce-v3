import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConfigMutation } from '../../api/types';
import type { ConfigChangeOutcome } from './config-change';
import { SpaceWizard } from './SpaceWizard';

interface Call { mutation: ConfigMutation; dryRun: boolean }

function renderWizard(outcome: (call: Call) => ConfigChangeOutcome = accept) {
  const calls: Call[] = [];
  render(<SpaceWizard canWrite busy={false} onChange={(mutation, dryRun) => {
    const call = { mutation, dryRun };
    calls.push(call);
    return Promise.resolve(outcome(call));
  }} />);
  return calls;
}

function accept({ dryRun }: Call): ConfigChangeOutcome {
  return { ok: true, result: { applied: !dryRun, dry_run: dryRun, revision: dryRun ? 1 : 2, summary: 'mock' } };
}

const review = /5\. dry-run y aplicar/i;

it('encadena tenant, room, membership y harness con las formas exactas del protocolo', async () => {
  const user = userEvent.setup();
  const calls = renderWizard();
  await user.click(screen.getByRole('button', { name: review }));

  for (let step = 0; step < 4; step += 1) {
    await user.click(screen.getByRole('button', { name: /previsualizar paso/i }));
    await user.click(await screen.findByRole('button', { name: /aplicar paso/i }));
  }

  expect(calls.filter((call) => !call.dryRun).map((call) => call.mutation)).toEqual([
    { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', is_hub: false, enabled: true } },
    { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
    { resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'agent', value: { role: 'agent', enabled: true } },
    { resource: 'harness', action: 'create', id: 'custom', value: { display_name: 'Custom harness', command: null, capabilities: [], enabled: true } },
  ]);
  expect(calls).toHaveLength(8);
  expect(await screen.findByText(/espacio completo/i)).toBeInTheDocument();
});

async function applyEveryStep(user: ReturnType<typeof userEvent.setup>, steps: number) {
  for (let step = 0; step < steps; step += 1) {
    await user.click(screen.getByRole('button', { name: /previsualizar paso/i }));
    await user.click(await screen.findByRole('button', { name: /aplicar paso/i }));
  }
}

it('devuelve a pendiente los pasos cuyo contenido cambió después de aplicar el espacio completo', async () => {
  const user = userEvent.setup();
  const calls = renderWizard();
  await user.click(screen.getByRole('button', { name: review }));
  await applyEveryStep(user, 4);
  expect(await screen.findByText(/espacio completo/i)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /1\. tenant/i }));
  await user.clear(screen.getByLabelText('Tenant id'));
  await user.type(screen.getByLabelText('Tenant id'), 'Beta');
  await user.click(screen.getByRole('button', { name: review }));

  expect(screen.queryByText(/espacio completo/i)).not.toBeInTheDocument();
  const entries = within(screen.getByLabelText('Plan del espacio')).getAllByRole('listitem');
  expect(entries[0]).toHaveTextContent(/^en curso/);
  expect(entries[0]).toHaveTextContent('"id":"Beta"');
  expect(entries[1]).toHaveTextContent(/^en cola/);
  expect(entries[2]).toHaveTextContent(/^en cola/);
  // El harness no depende del tenant: su mutación sigue siendo la que el servidor aceptó.
  expect(entries[3]).toHaveTextContent(/^aplicado/);
  expect(screen.getByLabelText(/mutación pendiente del wizard/i)).toHaveTextContent('"id": "Beta"');
  expect(screen.getByRole('button', { name: /previsualizar paso/i })).toBeEnabled();
  expect(screen.getByRole('button', { name: /aplicar paso/i })).toBeDisabled();

  await applyEveryStep(user, 3);
  expect(calls.filter((call) => !call.dryRun).map((call) => call.mutation)).toEqual([
    { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', is_hub: false, enabled: true } },
    { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
    { resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'agent', value: { role: 'agent', enabled: true } },
    { resource: 'harness', action: 'create', id: 'custom', value: { display_name: 'Custom harness', command: null, capabilities: [], enabled: true } },
    { resource: 'tenant', action: 'create', id: 'Beta', value: { display_name: 'Acme', is_hub: false, enabled: true } },
    { resource: 'room', action: 'create', tenant_id: 'Beta', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
    { resource: 'membership', action: 'create', tenant_id: 'Beta', room_id: 'grp.acme', alias: 'agent', value: { role: 'agent', enabled: true } },
  ]);
  expect(await screen.findByText(/espacio completo/i)).toBeInTheDocument();
});

it('quita el tilde de aplicado del paso cuya mutación ya no es la que aceptó el servidor', async () => {
  const user = userEvent.setup();
  renderWizard();
  await user.click(screen.getByRole('button', { name: review }));
  await applyEveryStep(user, 1);
  expect(screen.getByRole('button', { name: /1\. tenant/i }).querySelector('svg')).not.toBeNull();

  await user.click(screen.getByRole('button', { name: /1\. tenant/i }));
  await user.type(screen.getByLabelText(/display name/i), ' SA');

  expect(screen.getByRole('button', { name: /1\. tenant/i }).querySelector('svg')).toBeNull();
});

it('vuelve a bloquear el apply cuando el plan cambia después del dry-run', async () => {
  const user = userEvent.setup();
  renderWizard();
  await user.click(screen.getByRole('button', { name: review }));
  await user.click(screen.getByRole('button', { name: /previsualizar paso/i }));
  expect(await screen.findByRole('button', { name: /aplicar paso/i })).toBeEnabled();

  await user.click(screen.getByRole('button', { name: /1\. tenant/i }));
  await user.clear(screen.getByLabelText('Tenant id'));
  await user.type(screen.getByLabelText('Tenant id'), 'Beta');
  await user.click(screen.getByRole('button', { name: review }));

  expect(screen.getByRole('button', { name: /aplicar paso/i })).toBeDisabled();
  expect(screen.getByLabelText(/mutación pendiente del wizard/i)).toHaveTextContent('"id": "Beta"');
});

it('bloquea el apply de nuevo cuando el servidor responde conflicto de revisión', async () => {
  const user = userEvent.setup();
  renderWizard((call) => call.dryRun
    ? accept(call)
    : { ok: false, conflict: true, message: 'Conflicto de revisión: volvé a previsualizar.' });
  await user.click(screen.getByRole('button', { name: review }));
  await user.click(screen.getByRole('button', { name: /previsualizar paso/i }));
  await user.click(await screen.findByRole('button', { name: /aplicar paso/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/conflicto de revisión/i);
  expect(screen.getByRole('button', { name: /aplicar paso/i })).toBeDisabled();
  expect(screen.queryByLabelText(/dry-run del wizard/i)).not.toBeInTheDocument();
});

it('deja fuera del plan los recursos que el operador no incluye', async () => {
  const user = userEvent.setup();
  const calls = renderWizard();
  await user.click(screen.getByRole('checkbox', { name: /crear el tenant/i }));
  await user.click(screen.getByRole('button', { name: review }));
  await user.click(screen.getByRole('button', { name: /previsualizar paso/i }));

  expect(screen.getByLabelText('Plan del espacio').children).toHaveLength(3);
  expect(calls[0]?.mutation.resource).toBe('room');
});

it('no deja avanzar con un alias que el protocolo rechaza', async () => {
  const user = userEvent.setup();
  renderWizard();
  await user.click(screen.getByRole('button', { name: /3\. membership/i }));
  await user.clear(screen.getByLabelText('Alias'));
  await user.type(screen.getByLabelText('Alias'), 'Agent Uno');

  expect(await screen.findByRole('alert')).toHaveTextContent(/el alias debe ser minúsculas/i);
  expect(screen.getByRole('button', { name: /siguiente/i })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: review }));
  expect(screen.getByRole('button', { name: /previsualizar paso/i })).toBeDisabled();
});
