import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ApiProvider } from '../../api/context';
import { CauceApi } from '../../api/client';
import { server } from '../../mocks/server';
import { AgentContextPanel } from './AgentContextPanel';
import { configConBrief } from './agent-state-fixtures';
import { abrirContexto, selectSection } from './context-test-utils';
import { RUTA_PERFIL, perfilAplicado } from './perfil-fixtures';

const REPOSITORIO = 'http://localhost/v3/console/tenants/Steven/agents/kant/context/repository';

beforeEach(() => {
  server.use(http.get(RUTA_PERFIL, () => HttpResponse.json(perfilAplicado())));
});

it('offers profile, files, directive, history and Git as sections, opening on the profile', async () => {
  await abrirContexto('perfil');
  const tabs = screen.getAllByRole('tab', { name: /^(Perfil|Ficheros|Directiva|Historial|Git)/u });
  expect(tabs.map((tab) => tab.textContent)).toEqual(['Perfil', 'Ficheros', 'Directiva', 'Historial', 'Git']);
  expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  expect(await screen.findByLabelText(/^Identidad y propósito/i)).toBeVisible();
});

it('does not read the Git binding until its section is opened', async () => {
  let reads = 0;
  server.use(http.get(REPOSITORIO, () => { reads += 1; return HttpResponse.json({ error: 'unavailable' }, { status: 501 }); }));
  const { user } = await abrirContexto('perfil');
  await screen.findByLabelText(/^Identidad y propósito/i);
  expect(reads).toBe(0);
  await selectSection(user, 'git');
  expect(await screen.findByText('Este gateway todavía no publica la inspección Git.')).toBeInTheDocument();
  expect(reads).toBe(1);
});

it('opens the requested section first', async () => {
  render(<ApiProvider api={new CauceApi('http://localhost')}><AgentContextPanel tenantId="Steven" alias="kant" initialSection="historial" /></ApiProvider>);
  expect(await screen.findByRole('tab', { name: /^Historial/ })).toHaveAttribute('aria-selected', 'true');
});

it('sends the directive layers to the one place that edits each of them', async () => {
  configConBrief('Sos kant, el hub.');
  const { user } = await abrirContexto('directiva');
  await user.click(await screen.findByRole('button', { name: /Editar el manual en Ficheros/i }));
  expect(screen.getByRole('tab', { name: /^Ficheros/ })).toHaveAttribute('aria-selected', 'true');
  await selectSection(user, 'directiva');
  await user.click(await screen.findByRole('button', { name: /Editar los campos canónicos/i }));
  expect(screen.getByRole('tab', { name: /^Perfil/ })).toHaveAttribute('aria-selected', 'true');
});

it('marks the section holding an unsaved draft and guards the page against closing', async () => {
  const user = userEvent.setup();
  render(<ApiProvider api={new CauceApi('http://localhost')}>
    <AgentContextPanel tenantId="Steven" alias="kant" />
  </ApiProvider>);
  await user.type(await screen.findByLabelText(/^Identidad y propósito/i), 'algo');
  expect(await screen.findByRole('img', { name: 'borrador sin guardar' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /^Perfil/ })).toHaveAccessibleName(/borrador sin guardar/);
  expect(screen.getByText(/Borrador sin guardar\. Cerrar este panel lo conserva/)).toBeInTheDocument();
  const closing = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(closing);
  expect(closing.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Descartar borrador de perfil y releer' }));
  await waitFor(() => { expect(screen.queryByRole('img', { name: 'borrador sin guardar' })).not.toBeInTheDocument(); });
});
