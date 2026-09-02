import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { renderWithApi } from '../test/render';
import { ConsoleAccessBoundary, ConsoleAccessProvider, useConsoleAccess } from './console-access';

function AccessProbe() {
  const access = useConsoleAccess();
  return <p>{access.data?.subject ?? 'leyendo acceso'}</p>;
}

function accessHandler(onRead: () => void) {
  return http.get('*/v3/console/access', () => {
    onRead();
    return HttpResponse.json({
      subject: 'Steven:kant', roles: ['operator'], permissions: ['config.write'],
    });
  });
}

it('el boundary crea el recurso para un render aislado', async () => {
  let reads = 0;
  server.use(accessHandler(() => { reads += 1; }));
  renderWithApi(<ConsoleAccessBoundary><AccessProbe /></ConsoleAccessBoundary>);

  expect(await screen.findByText('Steven:kant')).toBeInTheDocument();
  expect(reads).toBe(1);
});

it('el boundary reutiliza el provider existente sin duplicar la consulta', async () => {
  let reads = 0;
  server.use(accessHandler(() => { reads += 1; }));
  renderWithApi(
    <ConsoleAccessProvider>
      <ConsoleAccessBoundary><AccessProbe /></ConsoleAccessBoundary>
      <ConsoleAccessBoundary><AccessProbe /></ConsoleAccessBoundary>
    </ConsoleAccessProvider>,
  );

  expect(await screen.findAllByText('Steven:kant')).toHaveLength(2);
  await waitFor(() => { expect(reads).toBe(1); });
});
