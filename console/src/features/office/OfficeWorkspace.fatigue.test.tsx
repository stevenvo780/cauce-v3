import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { QuotaAccount, QuotaAccountsSnapshot } from '../../api/client/my-quotas-client';
import { renderWithApi, testApi } from '../../test/render';
import { AgentQuotaDetail } from '../accounts/AgentQuotaDetail';
import type { FatigueState } from '../accounts/quota-availability';
import { CompanySessionProvider } from '../auth/company-session';
import { OfficeWorkspace } from './OfficeWorkspace';

const account: QuotaAccount = {
  id: 'subscription', provider: 'codex', label: 'Cuenta', enabled: true, version: 1, payer_tenant_id: 'One',
  shared: false, agent_count: 1, agents: [{ tenant_id: 'One', alias: 'worker', enabled: true }],
  paused_until: null, paused_reason: null, observation_status: 'ok', remaining_percent: 60, note: null, windows: [],
};
const snapshot = (accounts: QuotaAccount[]): QuotaAccountsSnapshot => ({ company_id: 'one', observed_at: new Date().toISOString(), accounts });
const topology = { tenants: [{ id: 'One', rooms: [
  { id: 'general', label: 'General', members: [{ alias: 'worker', enabled: true }, { alias: 'retired', enabled: false }] },
  { id: 'second', label: 'Segunda', members: [{ alias: 'worker', enabled: true }] },
] }] };
function workspace(onAgent = vi.fn()) {
  return <CompanySessionProvider state={{ authenticated: true, authority: { role: 'company_owner', scope: 'company', home_company: 'one', acting_company: 'one', platform_override: false } }}>
    <OfficeWorkspace campus={<p>Campus actual</p>} topology={topology} agents={[]} onAgent={onAgent} />
  </CompanySessionProvider>;
}
const cases: { state: FatigueState; label: string; accounts: QuotaAccount[] }[] = [
  { state: 'unknown', label: 'Sin datos', accounts: [] },
  { state: 'error', label: 'Error de consulta', accounts: [{ ...account, observation_status: 'error', remaining_percent: 0 }] },
  { state: 'stale', label: 'Datos antiguos', accounts: [{ ...account, observation_status: 'stale', remaining_percent: 0 }] },
  { state: 'exhausted', label: 'Sin disponibilidad', accounts: [{ ...account, remaining_percent: 0 }] },
  { state: 'low', label: 'Cansado', accounts: [{ ...account, remaining_percent: 24 }] },
  { state: 'available', label: 'Disponible', accounts: [{ ...account, remaining_percent: 25 }] },
  { state: 'paused', label: 'En pausa', accounts: [{ ...account, paused_until: new Date(Date.now() + 86_400_000).toISOString() }] },
  { state: 'model_dependent', label: 'Varía por modelo', accounts: [{ ...account, remaining_percent: 0, windows: [{
    group_key: 'codex', window_key: 'week', model: 'limited-model', label: 'Semanal', host: 'fixture', used_percent: 100,
    remaining_percent: 0, window_minutes: 10_080, captured_at: null, received_at: null, reset_at: null, observation_status: 'ok',
  }] }] },
];

it.each(cases)('muestra $state con su etiqueta en campus, plano y ficha', async ({ state, label, accounts }) => {
  const reads = vi.spyOn(testApi, 'getQuotaAccounts').mockResolvedValue(snapshot(accounts));
  vi.spyOn(testApi, 'getAgentQuota').mockResolvedValue({ tenant_id: 'One', alias: 'worker', revision: 0, reader_available: true,
    can_query: false, reason: null, status: 'unknown', captured_at: null, binding: null, sample: null, operation: null });
  const user = userEvent.setup(); const onAgent = vi.fn(); const view = renderWithApi(workspace(onAgent));
  const campus = within(screen.getByRole('region', { name: 'Cansancio de agentes del campus' }));
  expect(await campus.findByText(label)).toBeVisible();
  expect(campus.getByText(label).closest('[data-fatigue]')).toHaveAttribute('data-fatigue', state);
  expect(campus.getAllByRole('button')).toHaveLength(1);
  expect(campus.queryByText('retired')).not.toBeInTheDocument();
  await user.click(campus.getByRole('button', { name: `worker ${label}` }));
  expect(onAgent).toHaveBeenCalledWith('One/worker');
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await user.click(await screen.findByRole('button', { name: 'General One' }));
  const roster = within(screen.getByRole('region', { name: 'Agentes de sala One/General' }));
  expect(roster.getByText(label)).toBeVisible();
  expect(roster.getByText(label).closest('[data-fatigue]')).toHaveAttribute('data-fatigue', state);
  expect(reads).toHaveBeenCalledTimes(1);
  view.unmount();
  renderWithApi(<AgentQuotaDetail tenant="One" alias="worker" compact />);
  const detail = screen.getByRole('region', { name: 'Disponibilidad de worker' });
  await waitFor(() => { expect(detail.querySelector('[data-fatigue]')).toHaveAttribute('data-fatigue', state); });
  expect(within(detail).getByText(label)).toBeVisible();
});

it('la lectura inicial del campus espera los datos y una consulta fallida se distingue del agotamiento', async () => {
  let resolve: (value: QuotaAccountsSnapshot) => void = () => undefined;
  const pending = new Promise<QuotaAccountsSnapshot>(done => { resolve = done; });
  const reads = vi.spyOn(testApi, 'getQuotaAccounts').mockReturnValue(pending);
  const user = userEvent.setup(); renderWithApi(workspace());
  const campus = screen.getByRole('region', { name: 'Cansancio de agentes del campus' });
  expect(within(campus).getByRole('status')).toHaveTextContent('Leyendo cuotas…');
  expect(campus.querySelector('[data-fatigue]')).toBeNull();
  await act(async () => { resolve(snapshot([account])); await pending; });
  expect(await within(campus).findByText('Disponible')).toBeVisible();
  reads.mockRejectedValue(new Error('No se pudo leer la cuota.'));
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await user.click(screen.getByRole('button', { name: 'Releer plano y cuotas' }));
  await waitFor(() => { expect(campus.querySelector('[data-fatigue]')).toHaveAttribute('data-fatigue', 'error'); });
  await user.click(screen.getByRole('button', { name: 'General One' }));
  const roster = screen.getByRole('region', { name: 'Agentes de sala One/General' });
  expect(roster.querySelector('[data-fatigue]')).toHaveAttribute('data-fatigue', 'error');
  expect(within(roster).queryByText('Sin disponibilidad')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Campus' }));
  expect(within(campus).getByText('Error de consulta')).toBeVisible();
});
