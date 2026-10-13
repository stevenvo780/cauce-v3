import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { useResource } from '../../api/use-resource';
import { renderWithApi, testApi } from '../../test/render';
import { CompanySession } from '../auth/company-authority';
import { AgentQuotaReader } from './AgentQuotaReader';
import type { AgentQuotaReading } from './agent-quota-client';

const empty: AgentQuotaReading = {
  tenant_id: 'One', alias: 'janus', revision: 9, reader_available: true, can_query: true, reason: null,
  status: 'unknown', captured_at: null, binding: null, sample: null, operation: null,
};
const pending: AgentQuotaReading = { ...empty, status: 'pending', operation: {
  id: 'query-1', status: 'pending', error_code: null, created_at: '2026-10-12T19:37:00Z', updated_at: '2026-10-12T19:37:00Z',
} };

function Reader({ load }: { load: () => Promise<AgentQuotaReading> }) {
  const quota = useResource('agent-quota:One/janus', load);
  return <CompanySession.Provider value={{ authenticated: true, authority: {
    role: 'company_owner', scope: 'company', home_company: 'one', acting_company: 'one', platform_override: false,
  } }}><AgentQuotaReader tenant="One" alias="janus" quota={quota} /></CompanySession.Provider>;
}
async function show(load: () => Promise<AgentQuotaReading>) {
  await act(async () => { renderWithApi(<Reader load={load} />); });
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
afterEach(() => { vi.useRealTimers(); });

it('espacia las relecturas pendientes y se detiene avisando si el ordenador no responde', async () => {
  vi.useFakeTimers(); const load = vi.fn(async () => pending); await show(load);
  await advance(2_000); expect(load).toHaveBeenCalledTimes(2);
  await advance(2_000); expect(load).toHaveBeenCalledTimes(2);
  await advance(2_000); expect(load).toHaveBeenCalledTimes(3);
  for (const delay of [8_000, 16_000, 30_000, 30_000]) await advance(delay);
  expect(load).toHaveBeenCalledTimes(7);
  expect(screen.getByRole('alert')).toHaveTextContent(/el ordenador no responde/iu);
  await advance(120_000); expect(load).toHaveBeenCalledTimes(7);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Releer cuota' })); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await advance(2_000); expect(load).toHaveBeenCalledTimes(9);
});

it('pausa el sondeo mientras la lectura anterior está cargando', async () => {
  vi.useFakeTimers(); let resolve: ((value: AgentQuotaReading) => void) | undefined;
  const load = vi.fn().mockResolvedValueOnce(pending).mockImplementationOnce(() => new Promise<AgentQuotaReading>(done => { resolve = done; })).mockResolvedValue(pending);
  await show(load); await advance(2_000);
  expect(screen.getByRole('button', { name: 'Releer cuota' })).toBeDisabled();
  await advance(60_000); expect(load).toHaveBeenCalledTimes(2);
  await act(async () => { resolve?.(pending); });
  await advance(4_000); expect(load).toHaveBeenCalledTimes(3);
});

it('deja de sondear cuando recibe la operación terminada', async () => {
  vi.useFakeTimers(); const load = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue({ ...empty,
    operation: { ...pending.operation, status: 'done' },
  });
  await show(load); await advance(2_000); await advance(120_000);
  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/el ordenador no responde/iu)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Consultar' })).toBeEnabled();
});

it.each([
  [403, 'forbidden', 'Tu rol no permite esta acción.'],
  [409, 'conflict', 'Otro cambio llegó antes, o el recurso aún tiene dependencias. Relee y vuelve a intentarlo.'],
  [503, 'unavailable', 'Este servidor no puede atender la operación ahora. Inténtalo más tarde.'],
  [504, 'timeout', 'No se confirmó la consulta. Relee su estado antes de reintentar.'],
])('traduce el rechazo de la consulta HTTP %s sin presentar el mensaje remoto', async (status, code, message) => {
  vi.spyOn(testApi, 'queryAgentQuota').mockRejectedValue(new ApiError('remote quota request rejected', status, code));
  await show(async () => empty);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Consultar' })); });
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  expect(screen.queryByText('remote quota request rejected')).not.toBeInTheDocument();
});

it('traduce el timeout de lectura en la ficha sin presentar el mensaje remoto', async () => {
  await show(() => Promise.reject(new ApiError('remote quota request timed out', 504, 'timeout')));
  expect(screen.getByRole('alert')).toHaveTextContent('No se pudo leer la cuota. Relee antes de consultar.');
});

it('explica el fallo del ordenador por código de operación', async () => {
  const operation = pending.operation;
  if (!operation) throw new Error('Falta la operación pendiente del fixture.');
  await show(async () => ({ ...empty, status: 'failed', operation: { ...operation, status: 'failed', error_code: 'HOST_UNAVAILABLE' } }));
  expect(screen.getByText('La computadora del entorno no está disponible. Revisa su conexión.')).toBeVisible();
});

it('etiqueta la ausencia de ubicación operativa sin atribuirla al lector del harness', async () => {
  await show(async () => ({ ...empty, status: 'unsupported', reader_available: false, can_query: false, reason: 'quota_target_unplaced' }));
  expect(screen.getByText('Sin ubicación operativa')).toBeVisible();
  expect(screen.queryByText(/Sin lector de cuota/u)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Consultar' })).not.toBeInTheDocument();
});
