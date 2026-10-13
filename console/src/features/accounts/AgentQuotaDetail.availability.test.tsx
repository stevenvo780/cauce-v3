import { screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { QuotaAccount } from '../../api/client/my-quotas-client';
import { renderWithApi, testApi } from '../../test/render';
import { AgentQuotaDetail } from './AgentQuotaDetail';
import type { AgentQuotaReading } from './agent-quota-client';

const captured = '2026-10-12T19:37:00.000Z';
const unsupported: AgentQuotaReading = {
  tenant_id: 'One', alias: 'janus', revision: 1, reader_available: false, can_query: false,
  reason: 'quota_reader_unavailable', status: 'unsupported', captured_at: null, binding: null, sample: null, operation: null,
};
const account: QuotaAccount = {
  id: 'subscription', provider: 'codex', label: 'Cuenta', enabled: true, version: 1, payer_tenant_id: 'One',
  shared: false, agent_count: 1, agents: [{ tenant_id: 'One', alias: 'janus', enabled: true }],
  paused_until: null, paused_reason: null, observation_status: 'ok', remaining_percent: 0, note: null, windows: [],
};

it.each([false, true])('la cuenta vinculada conserva su error o agotamiento aunque el lector no exista (compact=%s)', async compact => {
  vi.spyOn(testApi, 'getAgentQuota').mockResolvedValue(unsupported);
  const readAccounts = vi.spyOn(testApi, 'getQuotaAccounts').mockResolvedValue({
    company_id: 'one', observed_at: captured, accounts: [{ ...account, observation_status: 'error' }],
  });
  const view = renderWithApi(<AgentQuotaDetail tenant="One" alias="janus" compact={compact} />);
  await waitFor(() => { expect(view.container.querySelector('[data-fatigue]')).toHaveAttribute('data-fatigue', 'error'); });
  expect(screen.queryByText(/Sin lector de cuota para este harness/u)).not.toBeInTheDocument();
  readAccounts.mockResolvedValue({ company_id: 'one', observed_at: captured, accounts: [account] });
  view.unmount();
  const next = renderWithApi(<AgentQuotaDetail tenant="One" alias="janus" compact={compact} />);
  await waitFor(() => { expect(next.container.querySelector('[data-fatigue]')).toHaveAttribute('data-fatigue', 'exhausted'); });
});

it.each([false, true])('un fallo de lectura de cuentas prevalece sobre la falta de lector (compact=%s)', async compact => {
  vi.spyOn(testApi, 'getAgentQuota').mockResolvedValue(unsupported);
  vi.spyOn(testApi, 'getQuotaAccounts').mockRejectedValue(new Error('No se pudieron leer las cuentas.'));
  const view = renderWithApi(<AgentQuotaDetail tenant="One" alias="janus" compact={compact} />);
  await waitFor(() => { expect(view.container.querySelector('[data-fatigue]')).toHaveAttribute('data-fatigue', 'error'); });
});

it.each([false, true])('una lectura desconocida del agente mantiene la disponibilidad de su cuenta (compact=%s)', async compact => {
  vi.spyOn(testApi, 'getAgentQuota').mockResolvedValue({ ...unsupported, reader_available: true, reason: null, status: 'unknown' });
  vi.spyOn(testApi, 'getQuotaAccounts').mockResolvedValue({
    company_id: 'one', observed_at: captured, accounts: [{ ...account, remaining_percent: 61 }],
  });
  const view = renderWithApi(<AgentQuotaDetail tenant="One" alias="janus" compact={compact} />);
  await waitFor(() => { expect(view.container.querySelector('[data-fatigue]')).toHaveAttribute('data-fatigue', 'available'); });
  expect(view.container.querySelector('[data-fatigue]')).toHaveTextContent('Disponible');
});

it('una ubicación no consultable muestra su motivo sin confundirlo con falta de lector', async () => {
  vi.spyOn(testApi, 'getAgentQuota').mockResolvedValue({ ...unsupported, reason: 'quota_target_unplaced' });
  vi.spyOn(testApi, 'getQuotaAccounts').mockResolvedValue({ company_id: 'one', observed_at: captured, accounts: [] });
  const view = renderWithApi(<AgentQuotaDetail tenant="One" alias="janus" />);
  expect(await screen.findByText(/un entorno de contenedor y un ordenador habilitado/u)).toBeVisible();
  expect(view.container.querySelector('[data-fatigue]')).toHaveAttribute('data-fatigue', 'unknown');
  expect(screen.queryByText('Sin lector de cuota')).not.toBeInTheDocument();
});
