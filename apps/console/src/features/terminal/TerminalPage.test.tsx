import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { TerminalPage } from './TerminalPage';

it('opens simultaneous-capable agent sessions and publishes through the durable feed', async () => {
  const user = userEvent.setup();
  renderWithApi(<TerminalPage />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Ultimate Terminal' })).toBeInTheDocument();
  expect(await screen.findByText('12 agentes')).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));

  const input = await screen.findByRole('textbox', { name: /entrada para kant/i });
  await user.type(input, 'Verificá el estado operativo');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));

  expect(await screen.findByText(/Aceptado por el control plane/i)).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /kant/i })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText(/no crea workers remotos/i)).toBeInTheDocument();
});

it('keeps the durable feed operational on a real PTY 501 and disables only PTY', async () => {
  const user = userEvent.setup();
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'Steven:kant', roles: ['operator'], permissions: ['message.publish', 'delivery.replay'],
    })),
    http.get('http://localhost/v3/console/terminal/capability', () => new HttpResponse(null, { status: 501 })),
  );
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con argos/i }));
  const input = await screen.findByRole('textbox', { name: /entrada para argos/i });
  await waitFor(() => expect(input).toBeEnabled());
  expect(screen.getByRole('button', { name: /^PTY$/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /^Feed$/i })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/4 ACK/i)).toBeInTheDocument();

  await user.type(input, 'El feed no depende del PTY');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));
  expect(await screen.findByText(/Aceptado por el control plane/i)).toBeInTheDocument();
  expect(screen.getByText('DENIED')).toBeInTheDocument();
});

it('publishes cross-tenant from the operator source room and blocks destinations without ACL', async () => {
  const user = userEvent.setup();
  let published: Record<string, unknown> | undefined;
  server.use(http.post('http://localhost/v3/console/messages', async ({ request }) => {
    published = await request.json() as Record<string, unknown>;
    return HttpResponse.json({ message_id: 'cross-tenant-message' }, { status: 202 });
  }));
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con kratos/i }));
  const allowedInput = await screen.findByRole('textbox', { name: /entrada para kratos/i });
  await waitFor(() => expect(allowedInput).toBeEnabled());
  await user.type(allowedInput, 'Diagnóstico remoto');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));
  await waitFor(() => expect(published).toMatchObject({
    room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Miguel', alias: 'kratos' }],
  }));

  await user.click(screen.getByRole('button', { name: /abrir sesión con salva/i }));
  expect(await screen.findByRole('textbox', { name: /entrada para salva/i })).toBeDisabled();
  expect(screen.getByText(/ACL Steven → Isa no concede route \+ control/i)).toBeInTheDocument();
});

it('derives the operator ACL from /v3/console/topology and never calls a route the gateway does not serve', async () => {
  const user = userEvent.setup();
  let phantomCalls = 0;
  // Reproduces production: the gateway only registers /v3/console/topology.
  server.use(http.get('*/v3/console/topology/access', () => {
    phantomCalls += 1;
    return HttpResponse.json({ error: 'not_found', message: 'Route GET:/v3/console/topology/access not found' }, { status: 404 });
  }));
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));
  const input = await screen.findByRole('textbox', { name: /entrada para kant/i });
  await waitFor(() => expect(input).toBeEnabled());
  expect(phantomCalls).toBe(0);
  expect(screen.queryByText(/Topología de acceso del tenant operador UNKNOWN/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/ACL del operador/i)).not.toBeInTheDocument();
});
