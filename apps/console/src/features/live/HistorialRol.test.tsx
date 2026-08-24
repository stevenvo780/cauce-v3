import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * EL DIARIO DEL ROL Y LA VUELTA ATRÁS, probados desde la página viva.
 *
 * Igual que el editor del rol, y por la misma razón: la mitad del encargo era DÓNDE vive. Deshacer
 * un cambio tiene que terminar en el mismo textarea donde el operador estaba mirando, y un test
 * del componente suelto pasaría igual si el botón no estuviera enganchado al editor.
 *
 * El caso que más importa de este fichero es el último: restaurar pasa por el borrador, así que
 * hereda el bloqueo de UTF-16. Un «deshacer» que escribiera directo se lo saltaría, y el texto que
 * restaura es justamente el que más riesgo tiene —se escribió por psql, antes de que hubiera
 * guarda ninguna—.
 */

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

function conHistorial(entries: Array<Record<string, unknown>>) {
  server.use(http.get('*/v3/console/role-assignments/:tenantId/:alias/history', () => HttpResponse.json({
    observed_at: new Date().toISOString(), tenant_id: 'Steven', alias: 'kant', entries,
  })));
}

async function abrirDiarioDeKant() {
  const user = userEvent.setup();
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(mockActivity())));
  renderWithApi(<LiveFleetPage />);

  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Directiva' }));
  // El diario sigue viviendo DEBAJO del editor, y el editor pasó a la columna 1 del diálogo.
  await user.click(await within(cajon).findByRole('button', { name: /abrir directiva completa/i }));
  const dialogo = await screen.findByRole('dialog', { name: /directiva de kant/i });
  const textarea = await within(dialogo).findByLabelText(/rol declarado de kant/i) as HTMLTextAreaElement;
  await user.click(within(dialogo).getByText('Historial y vuelta atrás'));
  return { user, cajon, dialogo, textarea };
}

it('enseña los cambios del rol, el más nuevo arriba, dentro del mismo cajón', async () => {
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText('Se reescribió el rol')).toBeInTheDocument();
  expect(within(dialogo).getByText('Se le puso rol por primera vez')).toBeInTheDocument();

  const titulos = within(dialogo).getAllByText(/^Se (reescribió el rol|le puso rol por primera vez)$/);
  expect(titulos[0]).toHaveTextContent('Se reescribió el rol');
  // Se sigue en /live: la vuelta atrás no manda al operador a otra vista.
  expect(window.location.pathname).toBe('/live');
});

it('declara desde cuándo hay diario: un registro corto no significa que el rol se tocara poco', async () => {
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/arranca el 23 de agosto de 2026/i)).toBeInTheDocument();
  expect(within(dialogo).getByText(/no significa que este rol se haya tocado poco/i)).toBeInTheDocument();
});

it('dice que el diario NO sabe quién, en vez de rellenarlo con quien está mirando', async () => {
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/no dice quién/i)).toBeInTheDocument();
  expect(within(dialogo).getAllByText(/no consta quién/i).length).toBeGreaterThan(0);
});

it('avisa de que editar a mano desvinculó la plantilla', async () => {
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/desvinculado de la plantilla «orquestador»/i)).toBeInTheDocument();
});

it('restaurar trae el texto al editor y NO guarda: el operador lo ve antes de decidir', async () => {
  let guardados = 0;
  server.use(http.post('*/v3/console/config/changes', async () => {
    guardados += 1;
    return HttpResponse.json({ applied: true, revision: 2 }, { status: 201 });
  }));

  const { user, dialogo, textarea } = await abrirDiarioDeKant();

  expect(textarea).toHaveValue('Sos kant, el hub de coordinacion de la flota.');
  const botones = await within(dialogo).findAllByRole('button', { name: /traer este texto al editor/i });
  await user.click(botones[0]);

  // El texto anterior a la reescritura queda cargado, y el botón de guardar se enciende porque
  // ahora hay algo distinto que guardar — pero nadie escribió nada todavía.
  await waitFor(() => expect(textarea).toHaveValue('Sos kant.'));
  expect(guardados).toBe(0);
  expect(within(dialogo).getByRole('button', { name: /guardar el rol/i })).toBeEnabled();
  expect(within(dialogo).getAllByText(/no se guarda hasta que pulses/i).length).toBeGreaterThan(0);
});

it('deshacer el alta se rotula como lo que es: dejaría al alias SIN rol', async () => {
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByRole('button', { name: /dejaría al alias SIN rol/i })).toBeInTheDocument();
});

it('un texto restaurado pasa por el bloqueo de UTF-16: restaurar no puede dejar sordo a un alias', async () => {
  // Un brief viejo escrito por psql puede medir 1200 puntos de código y 2400 unidades UTF-16: la
  // base lo acepta y el adaptador desplegado lo rechaza entero. Si «deshacer» escribiera directo,
  // se saltaría esta guarda. Al pasar por el borrador, no.
  const viejo = '🙂'.repeat(1200);
  conHistorial([{
    id: '1', tenant_id: 'Steven', alias: 'kant', operation: 'update',
    previous_brief: viejo, new_brief: 'Sos kant, el hub de coordinacion de la flota.',
    previous_template_slug: null, new_template_slug: null,
    actor_tenant: null, actor_alias: null, changed_at: '2026-08-23T04:00:00.000Z',
  }]);

  const { user, dialogo, textarea } = await abrirDiarioDeKant();
  await user.click(await within(dialogo).findByRole('button', { name: /traer este texto al editor/i }));

  await waitFor(() => expect(textarea).toHaveValue(viejo));
  // 1200 puntos de código: la base lo aceptaría, y el contador lo da por bueno.
  expect(within(dialogo).getByText(/^1200 \/ 1200$/)).toBeInTheDocument();
  // Y aun así el guardado queda bloqueado, porque el adaptador que corre hoy mide 2400.
  expect(within(dialogo).getByRole('button', { name: /guardar el rol/i })).toBeDisabled();
  expect(within(dialogo).getByText(/2400 unidades UTF-16/i)).toBeInTheDocument();
});

it('un alias sin cambios anotados lo dice como hecho medido, no como lista vacía muda', async () => {
  conHistorial([]);
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/el servidor miró y no hay ningún cambio anotado/i)).toBeInTheDocument();
});

it('si el gateway no publica el diario dice «no se pudo mirar», nunca «no cambió nunca»', async () => {
  server.use(http.get('*/v3/console/role-assignments/:tenantId/:alias/history', () => HttpResponse.json(
    { error: 'not_found', message: 'no route' }, { status: 404 },
  )));

  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/no se pudo mirar el diario del rol/i)).toBeInTheDocument();
  expect(within(dialogo).getByText(/NO significa que este rol no haya cambiado nunca/i)).toBeInTheDocument();
  expect(within(dialogo).queryByRole('button', { name: /traer este texto al editor/i })).not.toBeInTheDocument();
});

it('un fallo de lectura tampoco se disfraza de «no cambió nunca»', async () => {
  server.use(http.get('*/v3/console/role-assignments/:tenantId/:alias/history', () => HttpResponse.json(
    { error: 'invalid_request', message: 'timeout exceeded when trying to connect' }, { status: 400 },
  )));

  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/no se pudo leer el diario del rol de kant/i)).toBeInTheDocument();
  expect(within(dialogo).getByText(/significa que la consola no lo pudo mirar/i)).toBeInTheDocument();
});

it('sin config.write el diario se LEE igual: lo que se retira es la vuelta atrás, no la vista', async () => {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({
    permissions: ['message.publish'], roles: ['observer'],
  })));

  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText('Se reescribió el rol')).toBeInTheDocument();
  await waitFor(() => {
    expect(within(dialogo).queryByRole('button', { name: /traer este texto al editor/i })).not.toBeInTheDocument();
  });
});

it('el texto anterior se puede leer entero antes de traerlo, sin cargarlo en el editor', async () => {
  const { user, dialogo, textarea } = await abrirDiarioDeKant();

  await user.click((await within(dialogo).findAllByText(/ver el texto que había antes/i))[0]);

  expect(within(dialogo).getAllByText('Sos kant.').length).toBeGreaterThan(0);
  // Mirarlo no es traerlo: el editor sigue con lo que hay guardado.
  expect(textarea).toHaveValue('Sos kant, el hub de coordinacion de la flota.');
});

/**
 * El hueco de herramientas y prompts pasó a ser un renglón plegable en el PIE del diálogo. Abierto
 * medía 679 px —casi lo mismo que la capa 1, la única editable— y encabezaba como si fuera una
 * capa más, cuando es una nota de alcance. Sigue diciéndose entero: se pliega, no se borra.
 */
async function abrirPendientesDeKant() {
  const user = userEvent.setup();
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(mockActivity())));
  renderWithApi(<LiveFleetPage />);

  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Directiva' }));
  await user.click(await within(cajon).findByRole('button', { name: /abrir directiva completa/i }));
  const dialogo = await screen.findByRole('dialog', { name: /directiva de kant/i });

  const resumen = within(dialogo).getByText(/lo que todavía no se puede desde aquí/i);
  // Cerrado por defecto: es lo que recorta el alto. Si alguien lo abre de fábrica, esto se pone rojo.
  expect(resumen.closest('details')?.open).toBe(false);
  await user.click(resumen);
  return within(dialogo).getByText(/lo que todavía no se puede desde aquí/i).closest('details') as HTMLElement;
}

it('el hueco de herramientas y prompts se DICE, con dónde vive la configuración de ese alias', async () => {
  const pendientes = await abrirPendientesDeKant();
  expect(within(pendientes).getByText(/herramientas · qué puede usar y qué no/i)).toBeInTheDocument();
  expect(within(pendientes).getByText(/prompts · falta acordar qué son/i)).toBeInTheDocument();
  // Un hueco accionable dice dónde vive la cosa, no sólo que no se puede.
  expect(within(pendientes).getByText('ws-kant')).toBeInTheDocument();
  expect(within(pendientes).getByText('/home/dev')).toBeInTheDocument();
  // Y no ofrece ningún botón: uno que no hace nada sería peor que el hueco.
  expect(within(pendientes).queryByRole('button')).not.toBeInTheDocument();
});

it('no se inventa la ubicación cuando el registro no la declara', async () => {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json({
    revision: 1, observed_at: new Date().toISOString(),
    agents: [{ tenant_id: 'Steven', alias: 'kant', role_brief: 'Sos kant.' }],
    revisions: [],
  })));

  const pendientes = await abrirPendientesDeKant();
  expect(within(pendientes).getByText(/contenedor UNKNOWN/i)).toBeInTheDocument();
  expect(within(pendientes).getByText(/\$HOME UNKNOWN/i)).toBeInTheDocument();
});

it('el texto restaurado es un borrador de verdad: sobrevive a cerrar el diálogo y cambiar de pestaña', async () => {
  // Restaurar es una puerta NUEVA al borrador compartido del cajón. Si escribiera en el estado
  // local del editor, cerrar el diálogo o cambiar de pestaña lo desmontaría y el texto recuperado
  // se perdería sin avisar —justo lo que ya pasó una vez con lo que se teclea a mano—. Desde que
  // el editor vive en un diálogo, el recorrido tiene un desmontaje MÁS que antes.
  const { user, cajon, dialogo, textarea } = await abrirDiarioDeKant();

  await user.click((await within(dialogo).findAllByRole('button', { name: /traer este texto al editor/i }))[0]);
  await waitFor(() => expect(textarea).toHaveValue('Sos kant.'));

  await user.click(within(dialogo).getByRole('button', { name: /cerrar la directiva/i }));
  await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));
  await user.click(within(cajon).getByRole('tab', { name: 'Directiva' }));

  // El resumen del cajón ya lo dice sin abrir nada, y lo declara como borrador sin guardar.
  expect(await within(cajon).findByText('Sos kant.')).toBeInTheDocument();
  expect(within(cajon).getByText(/borrador sin guardar/i)).toBeInTheDocument();

  await user.click(within(cajon).getByRole('button', { name: /abrir directiva completa/i }));
  const reabierto = await screen.findByRole('dialog', { name: /directiva de kant/i });
  expect(await within(reabierto).findByLabelText(/rol declarado de kant/i)).toHaveValue('Sos kant.');
});
