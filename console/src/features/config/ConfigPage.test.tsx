import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { must } from '../../test/must';
import {
  CONFIG_SIN_CONTROL_REASON, CONFIG_SIN_LECTURA_REASON, CONFIG_WRITE_NO_ACREDITADO_REASON,
} from '../../router';
import {
  irA, recordChanges, snapshotDeConfig, servirConfig,
  type ChangeRequest,
} from './ConfigPage.test-helpers';

const ESPACIOS = /espacios y salas/i;
const PERMISOS = /acceso y roles/i;
const AVISOS = /^general$/i;
const HISTORIAL = /^avanzado$/i;

function panelDe(nombre: RegExp): HTMLElement {
  const seccion = screen.getByRole('heading', { name: nombre }).closest('section');
  if (!seccion) throw new Error(`El panel ${String(nombre)} no tiene sección`);
  return seccion;
}

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=espacios'); });

it('muestra las colecciones que el servidor publica más allá de las seis históricas', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, AVISOS);

  expect(await screen.findByRole('heading', { name: /política de cadena/i })).toBeInTheDocument();
  expect(screen.getByText(/"cycle_cut_enabled":true/)).toBeInTheDocument();
  await irA(user, PERMISOS);
  expect(await screen.findByRole('heading', { name: /destinos de aviso proactivo/i })).toBeInTheDocument();
  expect(screen.getByText('steven_dm')).toBeInTheDocument();
});
it('no confunde una clave que el gateway no publica con una colección vacía', async () => {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json({
    revision: 1, observed_at: new Date().toISOString(), tenants: [], revisions: [],
  })));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  const tenants = (await screen.findByRole('heading', { name: 'Clientes' })).closest('section');
  expect(tenants).toHaveTextContent(/sin registros/i);
  await irA(user, AVISOS);
  const chain = screen.getByRole('heading', { name: /política de cadena/i }).closest('section');
  expect(chain).toHaveTextContent(/no publica esta colección/i);
});

it('FAMILIA 5: /config son SIETE secciones reales, en el orden en que se monta una flota', async () => {
  window.history.replaceState({}, '', '/config');
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  const pestanas = within(screen.getByRole('tablist', { name: /secciones de ajustes/i }))
    .getAllByRole('tab');
  expect(pestanas.map((boton) => boton.textContent)).toEqual([
    'General', 'Espacios y salas', 'Agentes', 'Computadoras', 'Arneses', 'Acceso y roles', 'Avanzado',
  ]);
  expect(pestanas[0]).toHaveAttribute('aria-selected', 'true');
  expect(pestanas.filter((boton) => boton.getAttribute('aria-selected') === 'true')).toHaveLength(1);
});

it('FAMILIA 5: la sección pedida por la URL abre primero, y una desconocida cae en General', async () => {
  window.history.replaceState({}, '', '/config?seccion=agentes');
  const primera = renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('tab', { name: 'Agentes' })).toHaveAttribute('aria-selected', 'true');
  primera.unmount();

  window.history.replaceState({}, '', '/config?seccion=inventada');
  renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
});
it('FAMILIA 5: la tira de /config se recorre con las flechas y gobierna su panel', async () => {
  window.history.replaceState({}, '', '/config');
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  const pestanas = within(screen.getByRole('tablist', { name: /secciones de ajustes/i }))
    .getAllByRole('tab');
  expect(pestanas[0]).toHaveAttribute('tabindex', '0');
  expect(pestanas[1]).toHaveAttribute('tabindex', '-1');
  expect(screen.getByRole('tabpanel')).toHaveAccessibleName('General');

  pestanas[0].focus();
  await user.keyboard('{ArrowRight}');
  expect(await screen.findByRole('heading', { name: /^clientes$/i })).toBeInTheDocument();
  expect(document.activeElement).toBe(pestanas[1]);
});
it('FAMILIA 5: sólo la sección elegida es visible y navegable', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  expect(screen.getByRole('heading', { name: /membresías/i })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /permisos entre clientes/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /agentes y grupos/i })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Mutación JSON')).not.toBeVisible();

  await irA(user, PERMISOS);
  expect(screen.getByRole('heading', { name: /permisos entre clientes/i })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /membresías/i })).not.toBeInTheDocument();
});

it('FAMILIA 5: «Alta rápida» NO se perdió: vive en «Espacios y salas» y sigue dando de alta', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  const alta = panelDe(/alta de espacios/i);
  expect(alta).toBeInTheDocument();
  expect(within(alta).getByLabelText('Recurso a crear')).toBeInTheDocument();

  await user.type(within(alta).getByLabelText('Tenant'), 'Miguel');
  await user.type(within(alta).getByLabelText('Room'), 'grp.miguel');
  await user.type(within(alta).getByLabelText('Alias'), 'atlas');
  await user.click(within(alta).getByRole('button', { name: /^Crear$/ }));
  expect(changes[0]?.mutation).toEqual({
    resource: 'membership', action: 'create', tenant_id: 'Miguel', room_id: 'grp.miguel',
    alias: 'atlas', value: { role: 'agent', enabled: true },
  });

  await irA(user, HISTORIAL);
  expect(screen.getByLabelText('Recurso a crear')).not.toBeVisible();
  await irA(user, ESPACIOS);
  expect(screen.getByLabelText('Recurso a crear')).toBeInTheDocument();
});

it('FAMILIA 5: el cambio de rol por columna y el JSON crudo por fila siguen en «Espacios y salas»', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  const memberships = panelDe(/membresías/i);
  expect(within(memberships).getByText(/ver crudo/i)).toBeInTheDocument();

  await user.selectOptions(
    within(memberships).getByLabelText('Rol de permisos de Miguel/grp.miguel/janus'), 'operator',
  );
  await user.click(screen.getByRole('button', { name: 'Confirmar' }));
  expect(changes[0]?.mutation).toEqual({
    resource: 'membership', action: 'update', tenant_id: 'Miguel', room_id: 'grp.miguel',
    alias: 'janus', value: { role: 'operator' },
  });
});

it('FAMILIA 5: cambiar de pestaña con una confirmación pendiente la ANULA, no la deja escondida', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  await user.selectOptions(await screen.findByLabelText('Rol de permisos de Miguel/grp.miguel/janus'), 'operator');
  expect(screen.getByRole('button', { name: 'Confirmar' })).toBeInTheDocument();

  // The modal hides the strip from assistive tech; a programmatic section change must still cancel it.
  await user.click(screen.getByRole('tab', { name: PERMISOS, hidden: true }));
  await user.click(screen.getByRole('tab', { name: ESPACIOS, hidden: true }));
  expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
  expect(changes).toEqual([]);
});

it('FAMILIA 5: una colección que la consola no sabe clasificar aparece en «Avanzado», no desaparece', async () => {
  servirConfig(() => ({ ...snapshotDeConfig(1), gizmos: [{ id: 'g1', enabled: true }] }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  await irA(user, HISTORIAL);
  expect(screen.getByRole('heading', { name: 'gizmos' })).toBeInTheDocument();
});
describe('llegar a /config por URL directa sin permiso de lectura', () => {
  function servir403() {
    server.use(
      http.get('http://localhost/v3/console/config', () => HttpResponse.json(
        { error: 'forbidden', message: 'read permission is required for configuration' },
        { status: 403 },
      )),
      http.get('http://localhost/v3/console/access', () => HttpResponse.json({
        subject: 'Miguel:janus', roles: ['agent'], permissions: ['message.publish'],
      })),
    );
  }

  it('nombra el permiso que el servidor exige —LECTURA—, y no que no se pudo leer Cauce', async () => {
    // The GET requires `read`; asking for «control» sent the operator back with the wrong permission.
    servir403();
    renderWithApi(<ConfigPage />);

    expect(await screen.findByText(CONFIG_SIN_LECTURA_REASON)).toBeInTheDocument();
    expect(screen.getByText(/necesita permiso de lectura/i)).toBeInTheDocument();
    expect(screen.queryByText(CONFIG_SIN_CONTROL_REASON)).not.toBeInTheDocument();
    expect(screen.queryByText('No se pudo leer Cauce V3')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reintentar/i })).not.toBeInTheDocument();
  });

  it('cita el 403 crudo del servidor y ofrece una salida real en vez de un reintento imposible', async () => {
    servir403();
    renderWithApi(<ConfigPage />);

    expect(await screen.findByText(/El servidor contestó 403/)).toBeInTheDocument();
    expect(screen.getByText('read permission is required for configuration')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ir a la portada/i })).toHaveAttribute('href', '/');
  });

  it('un fallo que NO es de permiso sigue cayendo en el error genérico con su reintento', async () => {
    server.use(http.get('http://localhost/v3/console/config', () => HttpResponse.json(
      { error: 'internal', message: 'la base no responde' }, { status: 500 },
    )));
    renderWithApi(<ConfigPage />);

    expect(await screen.findByText('No se pudo leer Cauce V3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
    expect(screen.queryByText(CONFIG_SIN_LECTURA_REASON)).not.toBeInTheDocument();
  });
});

it('FAMILIA 8: la página se llama IGUAL que su entrada de menú, y no hay antetítulo en inglés', async () => {
  renderWithApi(<ConfigPage />);
  const titulo = await screen.findByRole('heading', { level: 1 });

  expect(titulo).toHaveTextContent(/^Ajustes$/);
  expect(titulo.closest('header')).toHaveTextContent(/^Configuración/);
  expect(document.body.textContent).not.toMatch(/atomic control plane/i);
});

it('FAMILIA 8: hay UNA sola tira de secciones, y el modo de alta es un segmentado DENTRO de su tarjeta', async () => {
  renderWithApi(<ConfigPage />);
  await screen.findByRole('group', { name: 'Modo de alta' });

  const tiras = screen.getAllByRole('tablist');
  expect(tiras).toHaveLength(1);
  expect(tiras[0]).toHaveAccessibleName(/secciones de ajustes/i);

  const segmentado = screen.getByRole('group', { name: 'Modo de alta' });
  const tarjeta = segmentado.closest('section');
  expect(tarjeta, 'el segmentado del alta quedó fuera de toda tarjeta').not.toBeNull();
  expect(within(must(tarjeta, 'the enrolment card')).getByRole('heading', { name: /alta de espacios/i })).toBeInTheDocument();

  expect(screen.getByRole('button', { name: 'Un solo recurso' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /espacio completo/i })).toHaveAttribute('aria-pressed', 'false');
});

it('FAMILIA 8: el propósito de cada sección es UNA frase, y lo que sobra queda plegado y cerrado', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  const panel = await screen.findByRole('tabpanel', { name: 'Espacios y salas' });

  const frase = within(panel).getByText('Los clientes, sus salas y quién está dentro de cada una.');
  expect(frase.textContent.length).toBeLessThanOrEqual(120);

  const plegado = within(panel).getByText('¿Qué es esto?').closest('details');
  expect(plegado).not.toBeNull();
  expect(plegado).not.toHaveAttribute('open');
  expect(plegado).toHaveTextContent(/un alias sin membresía habilitada no recibe entregas/i);

  await user.click(within(panel).getByText('¿Qué es esto?'));
  expect(plegado).toHaveAttribute('open');

  await irA(user, PERMISOS);
  expect(within(screen.getByRole('tabpanel', { name: 'Acceso y roles' })).getByText('¿Qué es esto?').closest('details'))
    .toHaveTextContent(/todo empieza denegado/i);
});

it('FAMILIA 8: el permiso se dice en castellano, sin perder el identificador que hay que citar', async () => {
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1 });
  await waitFor(() => { expect(document.querySelector('[data-estado]')).toHaveAttribute('data-estado', 'allowed'); });
  const linea = document.querySelector('[data-estado]');

  expect(linea).toHaveTextContent(/podés cambiar la configuración/i);
  expect(linea).toHaveTextContent(/config\.write/);
});

it.each([
  ['denied', ['agent'], /^Solo lectura: /],
  ['unknown', undefined, new RegExp(CONFIG_WRITE_NO_ACREDITADO_REASON, 'i')],
] as const)('FAMILIA 8: con el permiso «%s» la línea lo dice con todas las letras', async (estado, roles, texto) => {
  server.use(http.get('*/v3/console/access', () => (roles
    ? HttpResponse.json({ subject: 'Miguel:janus', roles, permissions: ['message.publish'] })
    : HttpResponse.json({ error: 'internal' }, { status: 500 }))));
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1 });

  await waitFor(() => {
    const linea = document.querySelector('[data-estado]');
    expect(linea).toHaveAttribute('data-estado', estado);
    expect(linea).toHaveTextContent(texto);
    expect(linea).toHaveTextContent(/config\.write/);
  });
});

it('la política de cadena muestra etiquetas en español y pliega los topes bajo su interruptor', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1 });
  await irA(user, AVISOS);

  const heading = await screen.findByRole('heading', { name: /política de cadena/i });
  const tabla = heading.closest('section')?.querySelector('table');
  expect(tabla).not.toBeNull();
  const cabeceras = Array.from(tabla?.querySelectorAll('th') ?? []).map((th) => th.textContent);

  expect(cabeceras.join(' ')).not.toMatch(/_/);
  expect(cabeceras.some((texto) => /relé de progreso/i.test(texto))).toBe(true);
  expect(cabeceras.some((texto) => /eventos por relé/i.test(texto))).toBe(false);
  expect(tabla).toHaveTextContent('hasta 8 eventos');
  expect(tabla).toHaveTextContent('6 por turno · 3 por arista · 64 por raíz');
});
