import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(mockActivity())));
});

async function abrirProyeccionDeKant() {
  const user = userEvent.setup();
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Directiva' }));
  await user.click(await within(cajon).findByRole('button', { name: /abrir directiva completa/i }));
  const dialogo = await screen.findByRole('dialog', { name: /directiva de kant/i });
  return { user, cajon, dialogo };
}

it('muestra role_brief como proyección legacy de sólo lectura y no ofrece el POST genérico', async () => {
  let cambiosGenericos = 0;
  server.use(http.post('*/v3/console/config/changes', () => {
    cambiosGenericos += 1;
    return HttpResponse.json({ applied: true }, { status: 201 });
  }));

  const { dialogo } = await abrirProyeccionDeKant();
  const proyeccion = await within(dialogo).findByLabelText(/proyección del rol de kant/i);

  expect(proyeccion).toHaveValue('Sos kant, el hub de coordinacion de la flota.');
  expect(proyeccion).toHaveAttribute('readonly');
  const aviso = within(dialogo).getByText(/solo lectura:/i);
  expect(aviso).toHaveTextContent(/role_summary.*canónico/i);
  expect(within(dialogo).queryByRole('button', { name: /guardar el rol/i })).not.toBeInTheDocument();
  expect(cambiosGenericos).toBe(0);
}, 25_000);

it('el único control de edición lleva a Perfil dentro del mismo cajón', async () => {
  const { user, cajon, dialogo } = await abrirProyeccionDeKant();

  await user.click(within(dialogo).getByRole('button', { name: /editar el perfil canónico/i }));

  expect(await within(cajon).findByRole('heading', { name: /perfil de kant/i })).toBeInTheDocument();
  expect(within(cajon).getByRole('tab', { name: 'Perfil' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('dialog', { name: /directiva de kant/i })).not.toBeInTheDocument();
}, 25_000);

it('una lectura fallida no se presenta como un rol vacío ni habilita escritura', async () => {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json(
    { error: 'unavailable', message: 'snapshot caído' },
    { status: 503 },
  )));

  const { dialogo } = await abrirProyeccionDeKant();
  expect(await within(dialogo).findByText(/no se pudo leer la proyección/i)).toHaveTextContent('snapshot caído');
  expect(within(dialogo).queryByRole('button', { name: /guardar/i })).not.toBeInTheDocument();
}, 25_000);
