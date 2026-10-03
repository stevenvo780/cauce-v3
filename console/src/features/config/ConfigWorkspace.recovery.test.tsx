import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { snapshotDeConfig } from './ConfigPage.test-helpers';

it.each([
  ['forbidden', 403, 'read permission is required for configuration'],
  ['server error', 503, 'temporary configuration failure'],
])('preserves an accessible route back from administration read %s', async (_state, status, message) => {
  let reads = 0;
  let mutations = 0;
  server.use(
    http.get('*/v3/console/config', () => {
      reads += 1;
      return reads === 2
        ? HttpResponse.json({ error: 'unavailable', message }, { status })
        : HttpResponse.json(snapshotDeConfig(reads));
    }),
    http.post('*/v3/console/config/changes', () => {
      mutations += 1;
      return HttpResponse.json({ error: 'unexpected mutation' }, { status: 500 });
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('button', { name: 'Administración avanzada' }));
  expect(await screen.findByText(message)).toBeInTheDocument();
  const back = screen.getByRole('button', { name: 'Volver a agentes y contexto' });
  await user.click(back);

  expect(await screen.findByRole('searchbox', { name: 'Buscar agente o grupo' })).toBeInTheDocument();
  expect(document.activeElement).toHaveAttribute('tabindex', '-1');
  await user.tab();
  expect(document.activeElement).not.toBe(document.body);
  expect(mutations).toBe(0);
});

it('preserves the route back while the administration snapshot is loading', async () => {
  let reads = 0;
  let releaseSecondRead: (() => void) | undefined;
  server.use(http.get('*/v3/console/config', async () => {
    reads += 1;
    if (reads === 1) return HttpResponse.json(snapshotDeConfig(1));
    await new Promise<void>((resolve) => { releaseSecondRead = resolve; });
    return HttpResponse.json(snapshotDeConfig(2));
  }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.click(await screen.findByRole('button', { name: 'Administración avanzada' }));
  expect(await screen.findByText('Leyendo configuración versionada…')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Volver a agentes y contexto' }));

  releaseSecondRead?.();
  expect(await screen.findByRole('searchbox', { name: 'Buscar agente o grupo' })).toBeInTheDocument();
});
