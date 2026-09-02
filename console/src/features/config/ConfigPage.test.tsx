import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import {
  CONFIG_SIN_CONTROL_REASON, CONFIG_SIN_LECTURA_REASON, CONFIG_WRITE_NO_ACREDITADO_REASON,
} from '../../router';
import {
  irA, recordChanges, snapshotDeConfig, servirConfig,
  type ChangeRequest,
} from './ConfigPage.test-helpers';

const ESPACIOS = /espacios y miembros/i;
const PERMISOS = /^permisos$/i;
const AVISOS = /avisos y cadena/i;
const HISTORIAL = /historial y json/i;

function panelDe(nombre: RegExp): HTMLElement {
  const seccion = screen.getByRole('heading', { name: nombre }).closest('section');
  if (!seccion) throw new Error(`El panel ${String(nombre)} no tiene sección`);
  return seccion;
}

it('muestra las colecciones que el servidor publica más allá de las seis históricas', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, AVISOS);

  expect(await screen.findByRole('heading', { name: /chain visibility policy/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /proactive egress allowlist/i })).toBeInTheDocument();
  expect(screen.getByText(/"cycle_cut_enabled":true/)).toBeInTheDocument();
  expect(screen.getByText('steven_dm')).toBeInTheDocument();
});

it('no confunde una clave que el gateway no publica con una colección vacía', async () => {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json({
    revision: 1, observed_at: new Date().toISOString(), tenants: [], revisions: [],
  })));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);

  const tenants = (await screen.findByRole('heading', { name: 'Tenants' })).closest('section');
  expect(tenants).toHaveTextContent(/sin registros/i);
  await irA(user, AVISOS);
  const chain = screen.getByRole('heading', { name: /chain visibility policy/i }).closest('section');
  expect(chain).toHaveTextContent(/no publica esta colección/i);
});

it('FAMILIA 5: /config son CINCO pestañas reales, en el orden en que se monta una flota', async () => {
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  const pestanas = within(screen.getByRole('tablist', { name: /áreas de configuración/i }))
    .getAllByRole('tab');
  expect(pestanas.map((boton) => boton.textContent)).toEqual([
    'Espacios y miembros', 'Permisos', 'Agentes',
    'Avisos y cadena', 'Historial y JSON',
  ]);
  expect(pestanas[0]).toHaveAttribute('aria-selected', 'true');
  expect(pestanas.filter((boton) => boton.getAttribute('aria-selected') === 'true')).toHaveLength(1);
});

it('FAMILIA 5: la tira de /config gobierna su panel y se recorre con las flechas', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  const pestanas = within(screen.getByRole('tablist', { name: /áreas de configuración/i }))
    .getAllByRole('tab');
  const panel = screen.getByRole('tabpanel');
  expect(panel.id).not.toBe('');
  expect(pestanas[0]).toHaveAttribute('aria-controls', panel.id);
  expect(pestanas[0]).toHaveAttribute('tabindex', '0');
  expect(pestanas[1]).toHaveAttribute('tabindex', '-1');

  pestanas[0].focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('heading', { name: /directed acl/i })).toBeInTheDocument();
  expect(document.activeElement).toBe(pestanas[1]);
});

it('FAMILIA 5: el render es CONDICIONAL, no un scroll con todo pintado y un ancla', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  expect(screen.getByRole('heading', { name: /memberships/i })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /directed acl/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /agent registry/i })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Mutación JSON')).not.toBeInTheDocument();

  await irA(user, PERMISOS);
  expect(screen.getByRole('heading', { name: /directed acl/i })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /memberships/i })).not.toBeInTheDocument();
});

it('FAMILIA 5: «Alta rápida» NO se perdió: vive en «Espacios y miembros» y sigue dando de alta', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  const alta = panelDe(/alta rápida/i);
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
  expect(screen.queryByLabelText('Recurso a crear')).not.toBeInTheDocument();
  await irA(user, ESPACIOS);
  expect(screen.getByLabelText('Recurso a crear')).toBeInTheDocument();
});

it('FAMILIA 5: el cambio de rol por columna y el JSON crudo por fila siguen en «Espacios y miembros»', async () => {
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  const memberships = panelDe(/memberships/i);
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

  await irA(user, PERMISOS);
  await irA(user, ESPACIOS);
  expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
  expect(changes).toEqual([]);
});

it('FAMILIA 5: una colección que la consola no sabe clasificar aparece en «Otros», no desaparece', async () => {
  servirConfig(() => ({ ...snapshotDeConfig(1), gizmos: [{ id: 'g1', enabled: true }] }));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  await irA(user, /^otros$/i);
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
    // El GET exige `read` (gateway: requirePermission(actor,'read')). Mandar a pedir «control»
    // devolvía al operador con el permiso equivocado y sin la vista.
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

  expect(titulo).toHaveTextContent(/^Ajustes y altas$/);
  expect(document.querySelector('.eyebrow')).toHaveTextContent('Topología y permisos');
  expect(document.body.textContent).not.toMatch(/atomic control plane/i);
});

it('FAMILIA 8: hay UNA sola tira de pestañas, y el modo de alta es un segmentado DENTRO del panel', async () => {
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { name: /alta rápida/i });

  const tiras = screen.getAllByRole('tablist');
  expect(tiras).toHaveLength(1);
  expect(tiras[0]).toHaveAccessibleName(/áreas de configuración/i);

  const segmentado = screen.getByRole('group', { name: 'Modo de alta' });
  const panel = segmentado.closest('.panel');
  expect(panel, 'el segmentado del alta quedó fuera de todo panel').not.toBeNull();
  expect(within(panel as HTMLElement).getByRole('heading', { name: /alta rápida/i })).toBeInTheDocument();

  expect(screen.getByRole('button', { name: 'Un solo recurso' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /espacio completo/i })).toHaveAttribute('aria-pressed', 'false');
});

it('FAMILIA 8: la orientación de cada pestaña es UNA frase, y lo que sobra queda plegado y cerrado', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { name: /alta rápida/i });

  const frase = document.querySelector('.config-area-descripcion');
  expect(frase).toHaveTextContent('Los clientes, sus salas y quién está dentro de cada sala.');
  expect(frase?.textContent.length ?? 999).toBeLessThanOrEqual(90);

  const plegado = document.querySelector('.config-detalle');
  expect(plegado).not.toBeNull();
  expect(plegado).not.toHaveAttribute('open');

  expect(plegado).toHaveTextContent(/un alias sin membership habilitada no recibe entregas/i);

  await user.click(screen.getByText(/qué es exactamente «espacios y miembros»/i));
  expect(plegado).toHaveAttribute('open');

  await irA(user, PERMISOS);
  expect(document.querySelector('.config-detalle')).toHaveTextContent(/todo empieza denegado/i);
});

it('FAMILIA 8: el permiso se dice en castellano, sin perder el identificador que hay que citar', async () => {
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1 });
  const linea = document.querySelector('.config-permiso');
  expect(linea, 'la línea del permiso no se pinta').not.toBeNull();

  expect(linea).toHaveTextContent(/podés cambiar la configuración/i);
  expect(linea).toHaveTextContent(/config\.write/);
  expect(linea).toHaveAttribute('data-estado', 'allowed');
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
    const linea = document.querySelector('.config-permiso');
    expect(linea).toHaveAttribute('data-estado', estado);
    expect(linea).toHaveTextContent(texto);
    expect(linea).toHaveTextContent(/config\.write/);
  });
});

it('FAMILIA 8: las columnas de números se marcan para alinearse a la derecha, y sólo ellas', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1 });
  await irA(user, AVISOS);

  const heading = await screen.findByRole('heading', { name: /chain visibility policy/i });
  const panel = heading.closest('.panel');
  expect(panel).not.toBeNull();
  const tabla = panel?.querySelector('table');
  expect(tabla).not.toBeNull();
  if (tabla) {
    const cabeceras = Array.from(tabla.querySelectorAll('th'));
    const numerica = cabeceras.find((th) => /progress_relay_max_events/i.test(th.textContent));
    const texto = cabeceras.find((th) => /^\s*id\s*$/i.test(th.textContent));

    expect(numerica, 'no está la columna numérica del fixture').toBeDefined();
    expect(numerica).toHaveAttribute('data-numero', 'true');
    if (numerica) {
      const celda = tabla.querySelectorAll('tbody tr td')[cabeceras.indexOf(numerica)];
      expect(celda).toHaveAttribute('data-numero', 'true');
      expect(celda).toHaveTextContent('8');
    }

    expect(texto, 'no está la columna de texto del fixture').toBeDefined();
    expect(texto).not.toHaveAttribute('data-numero');
  }
});
