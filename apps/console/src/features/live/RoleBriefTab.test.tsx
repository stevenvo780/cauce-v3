import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetActivitySnapshot } from '../../api/types';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * El editor del rol declarado se prueba DESDE la página viva, no aislado, porque la mitad del
 * encargo es dónde vive: el requisito era editar el rol donde ya se mira al bot, y un test del
 * componente suelto pasaría igual si la pestaña no estuviera enganchada al cajón.
 */

function conActividad(snapshot: FleetActivitySnapshot) {
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(snapshot)));
}

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

async function abrirRolDeKant() {
  const user = userEvent.setup();
  conActividad(mockActivity());
  renderWithApi(<LiveFleetPage />);

  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Rol' }));
  const textarea = await within(cajon).findByLabelText(/rol declarado de kant/i);
  return { user, cajon, textarea: textarea as HTMLTextAreaElement };
}

it('muestra el rol declarado del alias, completo y editable, dentro del cajón que ya se abre', async () => {
  const { cajon, textarea } = await abrirRolDeKant();

  expect(textarea).toHaveValue('Sos kant, el hub de coordinacion de la flota.');
  expect(textarea).not.toHaveAttribute('readonly');
  // Se sigue en /live: el editor no manda al operador a otra vista.
  expect(window.location.pathname).toBe('/live');
  expect(within(cajon).getByText(/^45 \/ 1200$/)).toBeInTheDocument();
});

it('el contador se mueve con lo que se escribe y avisa ANTES del tope, no después', async () => {
  const { cajon, textarea } = await abrirRolDeKant();

  fireEvent.change(textarea, { target: { value: 'ab' } });
  expect(within(cajon).getByText(/^2 \/ 1200$/)).toBeInTheDocument();

  // A 1150 todavía se puede guardar, pero el aviso ya está: pasarse no da ningún error visible,
  // así que avisar en el borde exacto sería avisar tarde.
  fireEvent.change(textarea, { target: { value: 'x'.repeat(1150) } });
  const contador = within(cajon).getByText(/^1150 \/ 1200$/);
  expect(contador).toHaveAttribute('data-tone', 'cerca');
  expect(within(cajon).getByText(/quedan 50 caracteres/i)).toBeInTheDocument();
  expect(within(cajon).getByRole('button', { name: /guardar el rol/i })).toBeEnabled();
});

it('a 1201 bloquea el guardado y dice qué pasaría: el alias se queda SORDO', async () => {
  const { cajon, textarea } = await abrirRolDeKant();

  fireEvent.change(textarea, { target: { value: 'x'.repeat(1200) } });
  expect(within(cajon).getByRole('button', { name: /guardar el rol/i })).toBeEnabled();

  fireEvent.change(textarea, { target: { value: 'x'.repeat(1201) } });
  expect(within(cajon).getByText(/^1201 \/ 1200$/)).toHaveAttribute('data-tone', 'pasado');
  expect(within(cajon).getByRole('button', { name: /guardar el rol/i })).toBeDisabled();
  expect(within(cajon).getByText(/sordo/i)).toBeInTheDocument();
});

it('cuenta puntos de código, igual que el CHECK de la base: un emoji es UN carácter', async () => {
  const { cajon, textarea } = await abrirRolDeKant();

  // `String.length` diría 2 por cada emoji y declararía pasado de largo un brief que la base
  // acepta sin chistar.
  fireEvent.change(textarea, { target: { value: '🙂'.repeat(600) } });
  expect(within(cajon).getByText(/^600 \/ 1200$/)).toBeInTheDocument();
});

it('guarda por la mutación de configuración, con tenant, alias y revisión esperada', async () => {
  let enviado: Record<string, unknown> | undefined;
  server.use(http.post('*/v3/console/config/changes', async ({ request }) => {
    enviado = await request.json() as Record<string, unknown>;
    return HttpResponse.json({ applied: true, dry_run: false, revision: 8, summary: 'agent updated' }, { status: 201 });
  }));

  const { cajon, textarea } = await abrirRolDeKant();
  fireEvent.change(textarea, { target: { value: 'Sos kant y coordinás a la flota.' } });
  await userEvent.setup().click(within(cajon).getByRole('button', { name: /guardar el rol/i }));

  await waitFor(() => expect(enviado).toBeDefined());
  expect(enviado).toMatchObject({
    dry_run: false,
    expected_revision: 1,
    mutation: {
      resource: 'agent',
      action: 'update',
      tenant_id: 'Steven',
      alias: 'kant',
      value: { role_brief: 'Sos kant y coordinás a la flota.' },
    },
  });
  expect(await within(cajon).findByText(/revisión 8/i)).toBeInTheDocument();
});

it('sin config.write se ve el rol en SOLO LECTURA y dice por qué, en vez de esconderlo', async () => {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({
    permissions: ['message.publish'],
    roles: ['observer'],
  })));

  const { cajon, textarea } = await abrirRolDeKant();

  await waitFor(() => expect(textarea).toHaveAttribute('readonly'));
  expect(textarea).toHaveValue('Sos kant, el hub de coordinacion de la flota.');
  expect(within(cajon).queryByRole('button', { name: /guardar el rol/i })).not.toBeInTheDocument();
  expect(within(cajon).getByText(/solo lectura/i)).toBeInTheDocument();
  expect(within(cajon).getByText(/no tiene permiso de control/i)).toBeInTheDocument();
});

it('cuando el servidor rechaza el guardado, el mensaje del servidor se ve: nada de fallar en silencio', async () => {
  server.use(http.post('*/v3/console/config/changes', () => HttpResponse.json(
    { error: 'invalid_input', message: 'agent role_brief admits 1200 characters at most; 1400 were sent' },
    { status: 422 },
  )));

  const { cajon, textarea } = await abrirRolDeKant();
  fireEvent.change(textarea, { target: { value: 'un rol nuevo' } });
  await userEvent.setup().click(within(cajon).getByRole('button', { name: /guardar el rol/i }));

  const alerta = await within(cajon).findByRole('alert');
  expect(alerta).toHaveTextContent(/1200 characters at most; 1400 were sent/);
  // El borrador NO se descarta: el operador tiene que poder corregir sobre lo que escribió.
  expect(textarea).toHaveValue('un rol nuevo');
});

it('un alias que no está en el registro lo declara, en vez de ofrecer un editor vacío que no guarda', async () => {
  const { cajon } = await abrirRolDeZeus();
  expect(await within(cajon).findByText(/no está en el registro de agentes/i)).toBeInTheDocument();
});

async function abrirRolDeZeus() {
  const user = userEvent.setup();
  conActividad(mockActivity());
  renderWithApi(<LiveFleetPage />);

  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /zeus/i }));
  const cajon = await screen.findByRole('complementary', { name: /detalle de zeus/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Rol' }));
  return { user, cajon };
}

/**
 * Un servidor de configuración que RECUERDA lo que le guardan.
 *
 * El handler por defecto devuelve siempre el mismo snapshot, así que con él «guardar y releer»
 * es indistinguible de «guardar y no releer»: los dos terminan mostrando el texto viejo. Como
 * media revisión adversarial fue sobre exactamente eso —la pantalla afirmando cosas que no
 * comprobó—, los tests de acá abajo necesitan un servidor que avance de revisión y devuelva lo
 * que se le mandó.
 */
function servidorDeConfig(inicial = 'Sos kant, el hub de coordinacion de la flota.') {
  const estado = { revision: 1, roleBrief: inicial as string | null, lecturas: 0, enviados: [] as Record<string, unknown>[] };
  const snapshot = () => ({
    revision: estado.revision,
    observed_at: new Date().toISOString(),
    agents: [
      { tenant_id: 'Steven', alias: 'kant', harness_id: 'claude-code', enabled: true, role_brief: estado.roleBrief },
      { tenant_id: 'Miguel', alias: 'iza', harness_id: 'hermes', enabled: false, role_brief: null },
    ],
  });
  server.use(
    http.get('*/v3/console/config', () => {
      estado.lecturas += 1;
      return HttpResponse.json(snapshot());
    }),
    http.post('*/v3/console/config/changes', async ({ request }) => {
      const cuerpo = await request.json() as { mutation?: { value?: { role_brief?: string } } };
      estado.enviados.push(cuerpo as Record<string, unknown>);
      const enviado = cuerpo.mutation?.value?.role_brief ?? '';
      estado.revision += 1;
      estado.roleBrief = enviado.trim().length === 0 ? null : enviado.trim();
      return HttpResponse.json(
        { applied: true, dry_run: false, revision: estado.revision, summary: 'agent updated' },
        { status: 201 },
      );
    }),
  );
  return estado;
}

const botonGuardar = (cajon: HTMLElement) => within(cajon).getByRole('button', { name: /guardar el rol/i });

it('ante un conflicto de revisión relee DE VERDAD y espera el dato: el reintento ya va con la revisión buena', async () => {
  // El defecto: el 409 decía «se recargó el snapshot» sin recargar nada, la revisión quedaba
  // congelada y CADA reintento volvía a mandar la vencida. Un bucle sin salida para el operador.
  const enviados: Record<string, unknown>[] = [];
  let lecturas = 0;
  const snapshot = (revision: number, roleBrief: string) => ({
    revision, observed_at: new Date().toISOString(),
    agents: [{ tenant_id: 'Steven', alias: 'kant', role_brief: roleBrief }],
  });
  server.use(
    http.get('*/v3/console/config', () => {
      lecturas += 1;
      // La primera lectura ve la revisión 1; para cuando se guarda, otro operador ya dejó la 7.
      return HttpResponse.json(lecturas === 1
        ? snapshot(1, 'Sos kant, el hub de coordinacion de la flota.')
        : snapshot(7, 'Rol cambiado por otro operador.'));
    }),
    http.post('*/v3/console/config/changes', async ({ request }) => {
      enviados.push(await request.json() as Record<string, unknown>);
      if (enviados.length === 1) {
        return HttpResponse.json(
          { error: 'conflict', message: 'revision changed: expected 1, current 7' },
          { status: 409 },
        );
      }
      return HttpResponse.json({ applied: true, dry_run: false, revision: 8, summary: 'agent updated' }, { status: 201 });
    }),
  );

  const { user, cajon, textarea } = await abrirRolDeKant();
  fireEvent.change(textarea, { target: { value: 'Sos kant y coordinás a la flota.' } });
  await user.click(botonGuardar(cajon));

  expect(await within(cajon).findByText(/la revisión buena es la 7/i)).toBeInTheDocument();
  expect(lecturas).toBeGreaterThanOrEqual(2);
  // El texto del operador no se pierde por un choque que no es suyo.
  expect(textarea).toHaveValue('Sos kant y coordinás a la flota.');

  await user.click(botonGuardar(cajon));
  await waitFor(() => expect(enviados).toHaveLength(2));
  expect(enviados[1]).toMatchObject({ expected_revision: 7 });
  expect(await within(cajon).findByText(/revisión 8/i)).toBeInTheDocument();
});

it('si el guardado sale bien pero la relectura falla, lo dice: nada de cartel verde sobre el texto viejo', async () => {
  // El defecto: se soltaba el borrador y se pintaba el verde sin esperar la relectura, así que un
  // GET caído dejaba el cartel «guardado» encima del texto ANTERIOR.
  let lecturas = 0;
  server.use(
    http.get('*/v3/console/config', () => {
      lecturas += 1;
      return lecturas === 1
        ? HttpResponse.json({
          revision: 1, observed_at: new Date().toISOString(),
          agents: [{ tenant_id: 'Steven', alias: 'kant', role_brief: 'Sos kant, el hub de coordinacion de la flota.' }],
        })
        : HttpResponse.json({ error: 'unavailable', message: 'store unreachable' }, { status: 503 });
    }),
    http.post('*/v3/console/config/changes', () => HttpResponse.json(
      { applied: true, dry_run: false, revision: 9, summary: 'agent updated' }, { status: 201 },
    )),
  );

  const { user, cajon, textarea } = await abrirRolDeKant();
  fireEvent.change(textarea, { target: { value: 'Sos kant y coordinás a la flota.' } });
  await user.click(botonGuardar(cajon));

  expect(await within(cajon).findByText(/pero NO pude releer la configuración/i)).toHaveTextContent(/store unreachable/);
  expect(within(cajon).queryByText(/releído del servidor/i)).not.toBeInTheDocument();
  // Y el borrador sigue en pantalla: soltarlo lo habría reemplazado por el texto viejo del snapshot.
  expect(textarea).toHaveValue('Sos kant y coordinás a la flota.');
});

it('una relectura caída se declara: lo que se ve es la última lectura buena, no lo que hay ahora', async () => {
  // El defecto: la guarda de error exigía `error && !data`, y `useResource` conserva el último
  // dato bueno — así que un GET caído después del primero no avisaba absolutamente nada.
  let lecturas = 0;
  server.use(
    http.get('*/v3/console/config', () => {
      lecturas += 1;
      return lecturas === 1
        ? HttpResponse.json({
          revision: 1, observed_at: new Date().toISOString(),
          agents: [{ tenant_id: 'Steven', alias: 'kant', role_brief: 'Sos kant, el hub de coordinacion de la flota.' }],
        })
        : HttpResponse.json({ error: 'unavailable', message: 'store unreachable' }, { status: 503 });
    }),
    http.post('*/v3/console/config/changes', () => HttpResponse.json(
      { applied: true, dry_run: false, revision: 9, summary: 'agent updated' }, { status: 201 },
    )),
  );

  const { user, cajon, textarea } = await abrirRolDeKant();
  fireEvent.change(textarea, { target: { value: 'un rol nuevo' } });
  await user.click(botonGuardar(cajon));

  expect(await within(cajon).findByText(/la ÚLTIMA lectura buena/i)).toHaveTextContent(/store unreachable/);
});

it('el borrador sobrevive al cambio de pestaña y al cierre del cajón, pero no se contagia a otro agente', async () => {
  // El defecto: cambiar de pestaña desmonta el componente y tiraba el borrador sin avisar, justo
  // cuando el operador va a «Entregas» a ver qué hace el bot mientras le redacta el rol.
  servidorDeConfig();
  const { user, cajon, textarea } = await abrirRolDeKant();
  fireEvent.change(textarea, { target: { value: 'Redactando el rol de kant.' } });

  await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));
  await user.click(within(cajon).getByRole('tab', { name: 'Rol' }));
  expect(await within(cajon).findByLabelText(/rol declarado de kant/i)).toHaveValue('Redactando el rol de kant.');

  await user.click(within(cajon).getByRole('button', { name: /cerrar el detalle/i }));
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const reabierto = await screen.findByRole('complementary', { name: /detalle de kant/i });
  await user.click(within(reabierto).getByRole('tab', { name: 'Rol' }));
  expect(await within(reabierto).findByLabelText(/rol declarado de kant/i)).toHaveValue('Redactando el rol de kant.');

  // Otro agente empieza LIMPIO: el borrador es de un bot concreto y no se hereda.
  await user.click(await screen.findByRole('row', { name: /iza/i }));
  const otro = await screen.findByRole('complementary', { name: /detalle de iza/i });
  await user.click(within(otro).getByRole('tab', { name: 'Rol' }));
  expect(await within(otro).findByLabelText(/rol declarado de iza/i)).toHaveValue('');
});

it('el verde del guardado se retira en cuanto se vuelve a escribir: no puede quedar sobre un texto sin guardar', async () => {
  servidorDeConfig();
  const { user, cajon, textarea } = await abrirRolDeKant();
  fireEvent.change(textarea, { target: { value: 'Sos kant y coordinás a la flota.' } });
  await user.click(botonGuardar(cajon));
  expect(await within(cajon).findByText(/releído del servidor/i)).toBeInTheDocument();

  fireEvent.change(textarea, { target: { value: 'Sos kant y coordinás a la flota. Y algo más.' } });
  await waitFor(() => expect(within(cajon).queryByText(/releído del servidor/i)).not.toBeInTheDocument());
});

it('la región viva es el aviso del tope, no el contador: el lector no canta el número en cada tecla', async () => {
  const { cajon, textarea } = await abrirRolDeKant();

  const contador = within(cajon).getByText(/^45 \/ 1200$/);
  expect(contador).not.toHaveAttribute('role');
  const region = within(cajon).getByRole('status');
  expect(region).toBeEmptyDOMElement();

  fireEvent.change(textarea, { target: { value: 'x'.repeat(1201) } });
  // El MISMO nodo, siempre presente: una región viva que aparece y desaparece se anuncia de forma
  // desigual según el lector, y este aviso es el único que hay antes de dejar al alias sordo.
  expect(within(cajon).getByRole('status')).toBe(region);
  expect(region).toHaveTextContent(/SORDO/);
});

it('cuenta sobre el texto recortado, igual que el store: pegar un .md con salto de línea final no bloquea nada', async () => {
  // El defecto: el contador medía el texto CRUDO y el store mide `trim()`, así que un fichero
  // pegado con su salto de línea final bloqueaba un guardado que el servidor aceptaba — y el
  // motivo era invisible, porque un salto de línea no se ve.
  const estado = servidorDeConfig();
  const { user, cajon, textarea } = await abrirRolDeKant();
  const pegado = `${'x'.repeat(1200)}\n`;
  fireEvent.change(textarea, { target: { value: pegado } });

  expect(within(cajon).getByText(/^1200 \/ 1200$/)).toHaveAttribute('data-tone', 'cerca');
  expect(botonGuardar(cajon)).toBeEnabled();

  await user.click(botonGuardar(cajon));
  await waitFor(() => expect(estado.enviados).toHaveLength(1));
  expect(estado.enviados[0]).toMatchObject({ mutation: { value: { role_brief: pegado } } });
  expect(await within(cajon).findByText(/releído del servidor/i)).toBeInTheDocument();
});
