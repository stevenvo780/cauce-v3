import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConsoleAuthState, ConsoleAuthority } from '../../api/types';
import { ApiError } from '../../api/client';
import { testApi, renderWithApi } from '../../test/render';
import { CompanySession } from '../auth/company-authority';
import { AgentQuotaDetail } from './AgentQuotaDetail';
import type { AgentQuotaQuery, AgentQuotaReading } from './agent-quota-client';

const captured = '2026-10-12T19:37:00.000Z';
const empty: AgentQuotaReading = {
  tenant_id: 'One', alias: 'janus', revision: 9, reader_available: true, can_query: true, reason: null, status: 'unknown',
  captured_at: null, binding: null, sample: null, operation: null,
};
const sample: NonNullable<AgentQuotaReading['sample']> = { provider: 'codex', ok: true, available: true,
  account_id: 'shared-subscription', effective_remaining_percent: 61, available_groups: [], limiting_groups: [],
  windows: [{ group_key: 'primary', window_key: 'weekly', remaining_percent: 61, reset_at: captured }],
};
const measured: AgentQuotaReading = { ...empty, status: 'ok', captured_at: captured,
  binding: { account_id: 'shared-subscription', enabled: true, shared: true, agent_count: 3 }, sample,
};
const authority: ConsoleAuthority = {
  role: 'company_owner', scope: 'company', home_company: 'one', acting_company: 'one', platform_override: false,
};
const session: ConsoleAuthState = { authenticated: true, subject: 'owner@example.test', home_tenant: 'One', authority };
let read = vi.fn<() => Promise<AgentQuotaReading>>();
let query = vi.fn<(tenant: string, alias: string, input: AgentQuotaQuery) => Promise<{ operation_id: string; status: 'pending' }>>();
let originalRead: typeof testApi.getAgentQuota;
let originalQuery: typeof testApi.queryAgentQuota;
beforeEach(() => {
  originalRead = testApi.getAgentQuota.bind(testApi); originalQuery = testApi.queryAgentQuota.bind(testApi);
  read = vi.fn(async () => empty);
  query = vi.fn(async () => ({ operation_id: 'query-1', status: 'pending' as const }));
  Object.assign(testApi, { getAgentQuota: read, queryAgentQuota: query });
  vi.spyOn(testApi, 'getQuotaAccounts').mockResolvedValue({ company_id: 'one', observed_at: captured, accounts: [] });
});
afterEach(() => {
  Object.assign(testApi, { getAgentQuota: originalRead, queryAgentQuota: originalQuery });
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function show(authority: ConsoleAuthState | undefined = session) {
  return renderWithApi(<CompanySession.Provider value={authority}><AgentQuotaDetail tenant="One" alias="janus" /></CompanySession.Provider>);
}

it('muestra la última medición con su hora y la suscripción compartida', async () => {
  read.mockResolvedValue(measured); const view = show();
  expect(await screen.findByText('Último saldo medido: 61%.')).toBeVisible();
  const instant = view.container.querySelector('time');
  expect(instant).toHaveAttribute('dateTime', captured);
  expect(instant?.textContent).toMatch(/19:37|14:37/u);
  expect(screen.getByText(/Consumo compartido por 3 agentes/u)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Consultar cuota' })).toBeEnabled();
});

it('sin lector muestra el estado explícito y solo permite releer', async () => {
  read.mockResolvedValue({ ...empty, status: 'unsupported', reader_available: false, can_query: false, reason: 'quota_reader_unavailable' });
  show(); const user = userEvent.setup();
  expect(await screen.findByText('Sin lector de cuota')).toBeVisible();
  expect(screen.getByText(/Sin lector de cuota para este harness/u)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Consultar cuota' })).toBeDisabled();
  expect(screen.queryByText(/100 %|0 %/u)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Releer cuota' }));
  await waitFor(() => { expect(read).toHaveBeenCalledTimes(2); });
  expect(query).not.toHaveBeenCalled();
});

it.each([{ authenticated: false as const }, { ...session, authority: { ...authority, role: 'reader' as const } }])('exige autoridad administrativa para consultar', async authority => {
  show(authority);
  await screen.findByText('Sin medición');
  expect(screen.getByRole('button', { name: 'Consultar cuota' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Releer cuota' })).toBeEnabled();
});

it('también respeta la capacidad de consulta del servidor aunque el lector exista', async () => {
  read.mockResolvedValue({ ...empty, can_query: false }); show();
  await screen.findByText('Sin medición');
  expect(screen.getByRole('button', { name: 'Consultar cuota' })).toBeDisabled();
});

it('permite consultar con lector vigente aunque la última observación no tuviera lector', async () => {
  read.mockResolvedValue({ ...empty, status: 'unsupported' }); show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Consultar cuota' }));
  expect(query).toHaveBeenCalledOnce();
  expect(screen.queryByText(/Sin lector de cuota para este harness/u)).not.toBeInTheDocument();
});

it('explica una sola vez la ubicación no operativa con su etiqueta y sin el aviso de lector ausente', async () => {
  read.mockResolvedValue({ ...empty, status: 'unsupported', reader_available: false, can_query: false, reason: 'quota_target_unplaced' });
  show();
  expect(await screen.findByText('Sin ubicación operativa')).toBeVisible();
  expect(screen.getAllByText('La consulta de cuota requiere un agente y un harness habilitados, un entorno de contenedor y un ordenador habilitado.')).toHaveLength(1);
  expect(screen.queryByText(/Sin lector de cuota/u)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Consultar cuota' })).toBeDisabled();
});

it('explica el ordenador sin respuesta y permite releer sin ofrecer una consulta', async () => {
  read.mockResolvedValue({ ...empty, can_query: false, reason: 'quota_host_unavailable' }); show();
  await screen.findByText('Sin ubicación operativa');
  expect(screen.getAllByText('El ordenador no responde; reintenta cuando vuelva a estar en línea.')).toHaveLength(1);
  expect(screen.queryByText(/Sin lector de cuota/u)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Consultar cuota' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Releer cuota' })).toBeEnabled();
});

it('encola con revisión e idempotencia y relee hasta el resultado durable', async () => {
  let current = empty;
  read.mockImplementation(async () => current);
  query.mockImplementation(async () => {
    current = { ...empty, status: 'pending', operation: { id: 'query-1', status: 'pending', error_code: null, created_at: captured, updated_at: captured } };
    return { operation_id: 'query-1', status: 'pending' };
  });
  const intervals = vi.spyOn(window, 'setInterval'); const user = userEvent.setup(); show();
  await user.click(await screen.findByRole('button', { name: 'Consultar cuota' }));
  await screen.findByText('Consulta pendiente');
  const call = query.mock.calls.at(0);
  expect(call?.slice(0, 2)).toEqual(['One', 'janus']);
  expect(call?.[2].expected_revision).toBe(9);
  expect(call?.[2].idempotency_key).toMatch(/^[a-f\d-]{36}$/u);
  expect(screen.getByRole('button', { name: 'Consultar cuota' })).toBeDisabled();
  expect(screen.queryByText('Medición recibida')).not.toBeInTheDocument();
  const tick = intervals.mock.calls.filter(([, period]) => period === 2_000).at(-1)?.[0];
  if (typeof tick !== 'function') throw new Error('Falta la relectura de la operación pendiente.');
  current = { ...measured, operation: { id: 'query-1', status: 'done', error_code: null, created_at: captured, updated_at: captured } };
  act(() => { tick(); });
  expect(await screen.findByText('Medición recibida')).toBeVisible();
  expect(screen.getByText('Último saldo medido: 61%.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Consultar cuota' })).toBeEnabled();
  expect(read).toHaveBeenCalledTimes(3);
});

it.each([
  [new Error('La respuesta no llegó.'), 'No se confirmó la consulta. Relee su estado antes de reintentar.'],
  [new ApiError('La respuesta no llegó.', 503), 'Este servidor no puede atender la operación ahora. Inténtalo más tarde.'],
])('tras un fallo ambiguo conserva la misma petición idempotente para el reintento', async (failure, message) => {
  query.mockRejectedValueOnce(failure);
  const user = userEvent.setup(); show();
  await user.click(await screen.findByRole('button', { name: 'Consultar cuota' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  await user.click(screen.getByRole('button', { name: 'Reintentar consulta' }));
  await waitFor(() => { expect(query).toHaveBeenCalledTimes(2); });
  expect(query.mock.calls[1]).toEqual(query.mock.calls[0]);
});

it('un conflicto confirmado relee la nueva revisión y permite iniciar otra consulta', async () => {
  read.mockResolvedValueOnce(empty).mockResolvedValue({ ...empty, revision: 10 });
  query.mockRejectedValueOnce(new ApiError('La revisión cambió.', 409, 'conflict'));
  const user = userEvent.setup(); show();
  await user.click(await screen.findByRole('button', { name: 'Consultar cuota' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Otro cambio llegó antes, o el recurso aún tiene dependencias. Relee y vuelve a intentarlo.');
  await user.click(screen.getByRole('button', { name: 'Consultar cuota' }));
  await waitFor(() => { expect(query).toHaveBeenCalledTimes(2); });
  expect(query.mock.calls[1]?.[2].expected_revision).toBe(10);
  expect(query.mock.calls[1]?.[2].idempotency_key).not.toEqual(query.mock.calls[0]?.[2].idempotency_key);
});

it('un error de lectura bloquea la consulta y la relectura permite recuperarla', async () => {
  read.mockRejectedValueOnce(new Error('No se pudo leer el resultado.'));
  const user = userEvent.setup(); show();
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo leer la cuota. Relee antes de consultar.');
  expect(screen.queryByRole('button', { name: 'Consultar cuota' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Releer cuota' }));
  expect(await screen.findByRole('button', { name: 'Consultar cuota' })).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('un error del proveedor conserva la hora y no convierte un saldo antiguo en medición acreditada', async () => {
  read.mockResolvedValue({ ...measured, status: 'error', sample: { ...sample, ok: false, available: false, note: 'rate_limited' } });
  show();
  expect(await screen.findByText('Saldo no acreditado en la última medición.')).toBeVisible();
  expect(screen.queryByText(/61\s*%/u)).not.toBeInTheDocument();
  expect(screen.getByText(/El proveedor limitó la consulta/u)).toBeVisible();
});

it('avisa del ordenador que no responde aunque la ficha relea periódicamente su estado', async () => {
  vi.useFakeTimers();
  read.mockImplementation(() => new Promise<AgentQuotaReading>(resolve => { window.setTimeout(() => { resolve({ ...empty,
    status: 'pending', operation: { id: 'query-1', status: 'pending', error_code: null, created_at: captured, updated_at: captured },
  }); }, 100); }));
  await act(async () => { show(); });
  for (let second = 0; second < 130; second++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(screen.getByRole('alert')).toHaveTextContent(/el ordenador no responde/iu);
});
