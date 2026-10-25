import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConfigMutation } from '../../api/types';
import type { ConfigChangeOutcome } from './config-change';
import { SpaceWizard } from './SpaceWizard';

interface Call { mutation: ConfigMutation; dryRun: boolean }

function renderWizard(outcome: (call: Call) => ConfigChangeOutcome = accept, canWrite = true) {
  const calls: Call[] = [];
  render(<SpaceWizard canWrite={canWrite} busy={false} onChange={(mutation, dryRun) => {
    const call = { mutation, dryRun };
    calls.push(call);
    return Promise.resolve(outcome(call));
  }} />);
  return calls;
}

it('mantiene la navegación y el reinicio para lectores, pero deja inerte el borrador y las acciones de escritura', async () => {
  const user = userEvent.setup();
  const calls = renderWizard(accept, false);

  expect(screen.getByLabelText('Identificador del espacio')).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /crear el espacio/i })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: /3\. membresía/i }));
  expect(screen.getByLabelText('Identificador')).toBeDisabled();
  expect(screen.getByRole('button', { name: /siguiente/i })).toBeEnabled();

  await user.click(screen.getByRole('button', { name: review }));
  expect(screen.getByRole('button', { name: /previsualizar paso/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /aplicar paso/i })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: /empezar de nuevo/i }));
  expect(screen.getByLabelText('Identificador del espacio')).toBeDisabled();
  expect(calls).toHaveLength(0);
});

function accept({ dryRun }: Call): ConfigChangeOutcome {
  return { ok: true, result: { applied: !dryRun, dry_run: dryRun, revision: dryRun ? 1 : 2, summary: 'mock' } };
}

const review = /4\. revisar y aplicar/i;

it('encadena tenant, room y membership con las formas exactas del protocolo', async () => {
  const user = userEvent.setup();
  const calls = renderWizard();
  await user.click(screen.getByRole('button', { name: review }));

  for (let step = 0; step < 3; step += 1) {
    await user.click(screen.getByRole('button', { name: /previsualizar paso/i }));
    await user.click(await screen.findByRole('button', { name: /aplicar paso/i }));
  }

  expect(calls.filter((call) => !call.dryRun).map((call) => call.mutation)).toEqual([
    { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', is_hub: false, enabled: true } },
    { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
    { resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'agent', value: { role: 'agent', enabled: true } },
  ]);
  expect(calls).toHaveLength(6);
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
  await applyEveryStep(user, 3);
  expect(await screen.findByText(/espacio completo/i)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /1\. espacio/i }));
  await user.clear(screen.getByLabelText('Identificador del espacio'));
  await user.type(screen.getByLabelText('Identificador del espacio'), 'Beta');
  await user.click(screen.getByRole('button', { name: review }));

  expect(screen.queryByText(/espacio completo/i)).not.toBeInTheDocument();
  const entries = within(screen.getByLabelText('Plan del espacio')).getAllByRole('listitem');
  expect(entries[0]).toHaveTextContent(/^en curso/);
  expect(screen.getByLabelText('Mutación pendiente del wizard')).toHaveTextContent('"id": "Beta"');
  expect(entries[1]).toHaveTextContent(/^en cola/);
  expect(entries[2]).toHaveTextContent(/^en cola/);
  expect(screen.getByLabelText(/mutación pendiente del wizard/i)).toHaveTextContent('"id": "Beta"');
  expect(screen.getByRole('button', { name: /previsualizar paso/i })).toBeEnabled();
  expect(screen.getByRole('button', { name: /aplicar paso/i })).toBeDisabled();

  await applyEveryStep(user, 3);
  expect(calls.filter((call) => !call.dryRun).map((call) => call.mutation)).toEqual([
    { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', is_hub: false, enabled: true } },
    { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
    { resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'agent', value: { role: 'agent', enabled: true } },
    { resource: 'tenant', action: 'create', id: 'Beta', value: { display_name: 'Acme', is_hub: false, enabled: true } },
    { resource: 'room', action: 'create', tenant_id: 'Beta', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
    { resource: 'membership', action: 'create', tenant_id: 'Beta', room_id: 'grp.acme', alias: 'agent', value: { role: 'agent', enabled: true } },
  ]);
  expect(await screen.findByText(/espacio completo/i)).toBeInTheDocument();
});

it('vuelve a bloquear el apply cuando el plan cambia después del dry-run', async () => {
  const user = userEvent.setup();
  renderWizard();
  await user.click(screen.getByRole('button', { name: review }));
  await user.click(screen.getByRole('button', { name: /previsualizar paso/i }));
  expect(await screen.findByRole('button', { name: /aplicar paso/i })).toBeEnabled();

  await user.click(screen.getByRole('button', { name: /1\. espacio/i }));
  await user.clear(screen.getByLabelText('Identificador del espacio'));
  await user.type(screen.getByLabelText('Identificador del espacio'), 'Beta');
  await user.click(screen.getByRole('button', { name: review }));

  expect(screen.getByRole('button', { name: /aplicar paso/i })).toBeDisabled();
  expect(screen.getByLabelText(/mutación pendiente del wizard/i)).toHaveTextContent('"id": "Beta"');
});

it('bloquea el apply de nuevo cuando el servidor responde conflicto de revisión', async () => {
  const user = userEvent.setup();
  renderWizard((call) => call.dryRun
    ? accept(call)
    : { ok: false, conflict: true, message: 'Conflicto de revisión: vuelve a previsualizar.' });
  await user.click(screen.getByRole('button', { name: review }));
  await user.click(screen.getByRole('button', { name: /previsualizar paso/i }));
  await user.click(await screen.findByRole('button', { name: /aplicar paso/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/conflicto de revisión/i);
  expect(screen.getByRole('button', { name: /aplicar paso/i })).toBeDisabled();
  expect(screen.queryByLabelText(/dry-run del wizard/i)).not.toBeInTheDocument();
});

it('FAMILIA 4: no dice «aplicado» a secas cuando la relectura de la configuración NO llegó', async () => {
  const user = userEvent.setup();
  // The wizard was the only one of the four write paths that ignored `outcome.recarga`: it sang
  // "applied at revision 2" even though the subsequent GET had died with a 500.
  renderWizard((call) => call.dryRun ? accept(call) : {
    ok: true,
    result: { applied: true, dry_run: false, revision: 2, summary: 'mock' },
    recarga: { releido: false, motivo: 'config store caído' },
  });
  await user.click(screen.getByRole('button', { name: review }));
  await user.click(screen.getByRole('button', { name: /previsualizar paso/i }));
  await user.click(await screen.findByRole('button', { name: /aplicar paso/i }));

  const aviso = await screen.findByText(/espacio aplicado en revisión 2/i);
  expect(aviso).toHaveTextContent(/la relectura de la configuración NO llegó \(config store caído\)/i);
  expect(aviso).toHaveTextContent(/pueden estar vencidas/i);
  // Neither green nor red: it was applied, but what shows below may be stale.
  expect(aviso).toHaveClass('bg-warn-soft');
});

it('el asistente no ofrece ni envía la mutación global del harness', async () => {
  const user = userEvent.setup();
  const calls = renderWizard();
  await user.click(screen.getByRole('button', { name: review }));
  await applyEveryStep(user, 3);

  expect(screen.queryByRole('button', { name: /harness/i })).not.toBeInTheDocument();
  expect(calls.some((call) => call.mutation.resource === 'harness')).toBe(false);
  const membership = calls.filter((call) => !call.dryRun).at(-1)?.mutation;
  expect(membership?.resource).toBe('membership');
  const value = (membership as { value?: Record<string, unknown> }).value ?? {};
  expect(Object.hasOwn(value, 'command'), 'la clave inerte volvió a viajar').toBe(false);
  expect(Object.hasOwn(value, 'role')).toBe(true);
  expect(Object.hasOwn(value, 'enabled')).toBe(true);
});
