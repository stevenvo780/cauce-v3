import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { FleetAgentDetailPage } from './FleetAgentDetailPage';

const targetKant = {
  tenant_id: 'Steven', alias: 'kant', container: 'ws-zeus', runtime_user: 'dev', harness: 'codex',
  shares_container_with: [], modes: ['harness'], pty_state: 'online', last_seen: null,
  authorized: true, reason: 'Autorizado por el servidor.',
};

function enablePty() {
  server.use(http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
    available: true,
    plugin_id: 'ultimate-terminal.client',
    capabilities: ['terminal.pty.client'],
    websocket_path: '/v3/console/terminal/ws',
    target_label: 'Cauce fleet PTY',
  })));
}

it('resolves tenant + alias into a single agent and reuses the terminal workspace to open its session', async () => {
  const user = userEvent.setup();
  renderWithApi(<FleetAgentDetailPage tenantId="Steven" alias="kant" />);

  expect(await screen.findByRole('heading', { level: 1, name: 'kant' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /volver a fleet/i })).toHaveAttribute('href', '/fleet');
  expect(await screen.findByText('1 agentes')).toBeInTheDocument();

  await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));
  expect(await screen.findByRole('textbox', { name: /entrada para kant/i })).toBeInTheDocument();
});

it('shows an explicit not-found state instead of inventing an agent the server never observed', async () => {
  renderWithApi(<FleetAgentDetailPage tenantId="Ghost" alias="nadie" />);

  expect(await screen.findByText(/no observa/i)).toBeInTheDocument();
  expect(screen.getByText('Ghost:nadie')).toBeInTheDocument();
});

it('loads the exact server target and passes its PTY/TUI authority to the shared workspace', async () => {
  enablePty();
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
    observed_at: new Date().toISOString(),
    websocket_path: '/v3/console/terminal/ws',
    items: [targetKant],
  })));

  renderWithApi(<FleetAgentDetailPage tenantId="Steven" alias="kant" />);

  expect(await screen.findByRole('button', { name: /abrir sesión con kant.*pty: tui en vivo/i }))
    .toBeInTheDocument();
});

it('fails closed when the PTY target inventory cannot be verified', async () => {
  enablePty();
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json(
    { error: 'target inventory unavailable' }, { status: 503 },
  )));
  const user = userEvent.setup();

  renderWithApi(<FleetAgentDetailPage tenantId="Steven" alias="kant" />);

  const agent = await screen.findByRole('button', { name: /abrir sesión con kant.*pty: pty desconocido/i });
  await user.click(agent);
  expect(await screen.findByRole('button', { name: /^pty$/i })).toBeDisabled();
});

it('keeps the global refresh busy until the slowest resource, including targets, settles', async () => {
  let targetReads = 0;
  let releaseTargets: (() => void) | undefined;
  const pendingTargets = new Promise<void>((resolve) => { releaseTargets = resolve; });
  server.use(http.get('*/v3/console/terminal/targets', async () => {
    targetReads += 1;
    if (targetReads > 1) await pendingTargets;
    return HttpResponse.json({ observed_at: new Date().toISOString(), items: [targetKant] });
  }));
  const user = userEvent.setup();

  renderWithApi(<FleetAgentDetailPage tenantId="Steven" alias="kant" />);
  const refresh = await screen.findByRole('button', { name: /^actualizar$/i });
  await user.click(refresh);

  expect(await screen.findByRole('button', { name: /actualizando/i })).toBeDisabled();
  releaseTargets?.();
  await waitFor(() => expect(screen.getByRole('button', { name: /^actualizar$/i })).toBeEnabled());
  expect(targetReads).toBeGreaterThanOrEqual(2);
});
