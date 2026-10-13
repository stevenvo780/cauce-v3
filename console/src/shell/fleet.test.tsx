import { useEffect } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, onTestFinished } from 'vitest';
import type { FleetActivityAgent } from '../api/types';
import { ChatLauncher } from '../features/messages/ChatLauncher';
import { server } from '../mocks/server';
import { renderWithApi } from '../test/render';
import { FleetProvider } from './fleet';
import { useFleet } from './fleet-context';

function FleetProbe() {
  const { agents, activity, live, salud, setActivityIntervalMs } = useFleet();
  useEffect(() => { setActivityIntervalMs(0); }, [setActivityIntervalMs]);
  return (
    <>
      <button onClick={() => { void activity.reload(); }}>Reload activity</button>
      <output aria-label="Fleet snapshot">{JSON.stringify({
        agents, activity: activity.data, error: activity.error?.message,
        live: Object.fromEntries(live), salud,
      })}</output>
    </>
  );
}

function snapshot() {
  return JSON.parse(screen.getByLabelText('Fleet snapshot').textContent ?? '{}') as {
    agents: { alias: string; leaseState: string; presence?: unknown; origenes: string[]; registrado?: boolean }[];
    activity: { agents: FleetActivityAgent[] };
    error?: string;
    live: Record<string, { state: string }>;
    salud: Record<string, { pendientes?: number; enCurso?: number; reintentos?: number }>;
  };
}

it.each([false, true])('retains the registry-only chat after a 503 without stale live data and replaces it on recovery (presence: %s)', async (withPresence) => {
  const user = userEvent.setup();
  const gaia: FleetActivityAgent = {
    tenant_id: 'Steven', alias: 'gaia', registered: true, agent_enabled: true,
    work_state: 'working', in_flight: 2, queued: 3, retrying: 1,
    ...(withPresence ? {
      presence: { online: true, epoch: 9, lease_until: new Date(Date.now() + 60_000).toISOString() },
    } : {}),
  };
  let reads = 0;
  let releaseRecovery = () => undefined as void;
  const recovery = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  onTestFinished(() => { releaseRecovery(); });
  server.use(
    http.get('*/v3/status', () => HttpResponse.json({ presence: [] })),
    http.get('*/v3/console/topology', () => HttpResponse.json({
      tenants: [{ id: 'Steven', rooms: [{ id: 'office', members: [{ alias: 'argos', enabled: true }] }] }],
    })),
    http.get('*/v3/console/messages', () => HttpResponse.json({ items: [] })),
    http.get('*/v3/console/queues', () => HttpResponse.json({ items: [] })),
    http.get('*/v3/console/activity', async () => {
      reads += 1;
      if (reads === 2) return HttpResponse.json({ error: 'unavailable', message: 'actividad sin servicio' }, { status: 503 });
      if (reads > 2) await recovery;
      return HttpResponse.json({ agents: [reads === 1 ? gaia : {
        tenant_id: 'Steven', alias: 'hegel', registered: true, work_state: 'working', in_flight: 1,
      }] });
    }),
  );
  renderWithApi(<FleetProvider><FleetProbe /><ChatLauncher phone={false} /></FleetProvider>);

  const firstLink = await screen.findByRole('link', { name: /^gaia\b/u });
  expect(firstLink).toHaveAttribute('href', '/messages/Steven/gaia');
  expect(firstLink).toHaveTextContent('Trabajando');
  await waitFor(() => { expect(snapshot().salud['Steven:gaia']).toMatchObject({ pendientes: 3, enCurso: 2, reintentos: 1 }); });
  expect(snapshot().agents.find((agent) => agent.alias === 'gaia')?.origenes).toEqual(['registro']);

  await user.click(screen.getByRole('button', { name: 'Reload activity' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('No se pudo actualizar la lista de agentes: actividad sin servicio');
  expect(alert).toHaveTextContent('Se muestra la última lista conocida');
  const retainedLink = screen.getByRole('link', { name: /^gaia\b/u });
  expect(retainedLink).toHaveAttribute('href', '/messages/Steven/gaia');
  expect(retainedLink).toHaveTextContent('Desconocido');
  expect(retainedLink).not.toHaveTextContent(/Caído|Libre|Trabajando|en curso|en cola|en reintento/u);
  const failed = snapshot();
  expect(failed.error).toBe('actividad sin servicio');
  expect(failed.activity.agents).toEqual([gaia]);
  expect(failed.agents.find((agent) => agent.alias === 'gaia')).toMatchObject({ leaseState: 'unknown', registrado: true });
  expect(failed.agents.find((agent) => agent.alias === 'gaia')?.presence).toBeUndefined();
  expect(failed.live['Steven:gaia']).toBeUndefined();
  expect(failed.salud['Steven:gaia']).toBeUndefined();
  expect(screen.getByRole('link', { name: /^argos\b/u })).toBeInTheDocument();

  await user.click(within(alert).getByRole('button', { name: 'Reintentar' }));
  await waitFor(() => { expect(reads).toBe(3); });
  const pending = snapshot();
  expect(pending.live['Steven:gaia']).toBeUndefined();
  expect(pending.salud['Steven:gaia']).toBeUndefined();
  expect(pending.agents.find((agent) => agent.alias === 'gaia')).toMatchObject({ leaseState: 'unknown' });
  expect(screen.getByRole('link', { name: /^gaia\b/u })).toHaveTextContent('Desconocido');
  releaseRecovery();
  expect(await screen.findByRole('link', { name: /^hegel\b/u })).toHaveAttribute('href', '/messages/Steven/hegel');
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
  expect(screen.queryByRole('link', { name: /^gaia\b/u })).toBeNull();
  expect(snapshot().agents.map((agent) => agent.alias).sort()).toEqual(['argos', 'hegel']);
  expect(snapshot().live['Steven:hegel'].state).toBe('thinking');
  expect(snapshot().salud['Steven:hegel'].enCurso).toBe(1);
  expect(snapshot().error).toBeUndefined();
});

it('keeps the lease-derived state during a normal activity reload without a prior failure', async () => {
  const user = userEvent.setup();
  const future = new Date(Date.now() + 60_000).toISOString();
  let reads = 0;
  let releaseReload = () => undefined as void;
  const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve; });
  onTestFinished(() => { releaseReload(); });
  server.use(
    http.get('*/v3/status', () => HttpResponse.json({
      presence: [{ tenant_id: 'Steven', alias: 'argos', epoch: 3, lease_expires_at: future }],
    })),
    http.get('*/v3/console/topology', () => HttpResponse.json({
      tenants: [{ id: 'Steven', rooms: [{ id: 'office', members: [{ alias: 'argos', enabled: true }] }] }],
    })),
    http.get('*/v3/console/messages', () => HttpResponse.json({ items: [] })),
    http.get('*/v3/console/queues', () => HttpResponse.json({ items: [] })),
    http.get('*/v3/console/activity', async () => {
      reads += 1;
      if (reads > 1) await reloadGate;
      return HttpResponse.json({ agents: [] });
    }),
  );
  renderWithApi(<FleetProvider><FleetProbe /><ChatLauncher phone={false} /></FleetProvider>);

  expect(await screen.findByRole('link', { name: /^argos\b/u })).toHaveTextContent('Libre');
  await user.click(screen.getByRole('button', { name: 'Reload activity' }));
  await waitFor(() => { expect(reads).toBe(2); });
  expect(screen.getByRole('link', { name: /^argos\b/u })).toHaveTextContent('Libre');
  expect(screen.getByRole('link', { name: /^argos\b/u })).not.toHaveTextContent('Desconocido');
  releaseReload();
  expect(await screen.findByRole('link', { name: /^argos\b/u })).toHaveTextContent('Libre');
});
