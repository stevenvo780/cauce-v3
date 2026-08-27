import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import {
  CONFIG_SIN_CONTROL_REASON, CONFIG_WRITE_NO_ACREDITADO_REASON,
} from '../../navigation';

interface ChangeRequest { dry_run?: boolean; expected_revision?: number; mutation?: Record<string, unknown> }
type Usuario = ReturnType<typeof userEvent.setup>;

async function irA(user: Usuario, pestana: RegExp) {
  await user.click(await screen.findByRole('tab', { name: pestana }));
}

const ESPACIOS = /espacios y miembros/i;
const PERMISOS = /^permisos$/i;
const ROLES = /roles de agente/i;
const AVISOS = /avisos y cadena/i;
const HISTORIAL = /historial y json/i;

function recordChanges(sink: ChangeRequest[]) {
  server.use(http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest;
    sink.push(input);
    return HttpResponse.json({
      applied: input.dry_run !== true, dry_run: input.dry_run === true,
      revision: input.dry_run ? 1 : 2, mutation: input.mutation,
      inverse_mutation: input.mutation, rolled_back_revision_id: null,
      summary: 'mock configuration validation',
    }, { status: input.dry_run ? 200 : 201 });
  }));
}

function snapshotDeConfig(revision: number) {
  return {
    revision,
    observed_at: new Date().toISOString(),
    tenants: [{ id: 'Miguel', display_name: 'Miguel', is_hub: false, enabled: true }],
    rooms: [{ id: 'grp.miguel', tenant_id: 'Miguel', display_name: 'grp.miguel', enabled: true }],
    memberships: [{ tenant_id: 'Miguel', room_id: 'grp.miguel', alias: 'janus', role: 'agent', enabled: true }],
    acl_edges: [],
    role_policies: [{ role: 'agent' }, { role: 'operator' }],
    revisions: [],
  };
}

function servirConfig(snapshot: () => Record<string, unknown>) {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json(snapshot())));
}

function snapshotConAgentes() {
  return {
    ...snapshotDeConfig(1),
    agents: [
      { tenant_id: 'Steven', alias: 'zeus', role_brief: 'Sos el orquestador de la flota.', enabled: true },
      { tenant_id: 'Steven', alias: 'kant', role_brief: 'Sos el orquestador de la flota.', enabled: true },
      { tenant_id: 'Steven', alias: 'argos', role_brief: null, enabled: true },
    ],
  };
}

function panelDe(nombre: RegExp): HTMLElement {
  const seccion = screen.getByRole('heading', { name: nombre }).closest('section');
  if (!seccion) throw new Error(`El panel ${String(nombre)} no tiene sección`);
  return seccion as HTMLElement;
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

it('FAMILIA 5: /config son SEIS pestañas reales, en el orden en que se monta una flota', async () => {
  renderWithApi(<ConfigPage />);
  await screen.findByRole('heading', { level: 1, name: /ajustes/i });

  const pestanas = within(screen.getByRole('tablist', { name: /áreas de configuración/i }))
    .getAllByRole('tab');
  expect(pestanas.map((boton) => boton.textContent)).toEqual([
    'Espacios y miembros', 'Permisos', 'Roles de agente', 'Agentes y cuentas',
    'Avisos y cadena', 'Historial y JSON',
  ]);
  expect(pestanas[0]).toHaveAttribute('aria-selected', 'true');
  expect(pestanas.filter((boton) => boton.getAttribute('aria-selected') === 'true')).toHaveLength(1);
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
    within(memberships).getByLabelText('Rol de Miguel/grp.miguel/janus'), 'operator',
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

  await user.selectOptions(await screen.findByLabelText('Rol de Miguel/grp.miguel/janus'), 'operator');
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

it('FAMILIA 6: «Roles de agente» cataloga los roles en uso y dice quién lleva cada uno', async () => {
  servirConfig(snapshotConAgentes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ROLES);

  const enUso = panelDe(/roles en uso/i);
  expect(within(enUso).getByRole('heading', { name: /sos el orquestador de la flota/i })).toBeInTheDocument();
  expect(within(enUso).getByText('Steven/zeus')).toBeInTheDocument();
  expect(within(enUso).getByText('Steven/kant')).toBeInTheDocument();
  expect(within(enUso).getByText(/no un nombre guardado/i)).toBeInTheDocument();
  expect(within(panelDe(/bots sin rol declarado/i)).getByText('Steven/argos')).toBeInTheDocument();
});

it('FAMILIA 6: el catálogo es sólo lectura y enlaza al Perfil canónico sin POST genérico', async () => {
  const changes: ChangeRequest[] = [];
  servirConfig(snapshotConAgentes);
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ROLES);

  const enlace = within(panelDe(/bots sin rol declarado/i)).getByRole('link', { name: /Steven\/argos/i });
  expect(enlace).toHaveAttribute('href', '/live?agente=Steven%2Fargos&pestana=perfil');
  expect(screen.getByText(/esta vista no envía mutaciones genéricas/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/bot que recibirá el rol/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /aplicar el rol/i })).not.toBeInTheDocument();
  expect(changes).toEqual([]);
});

it('FAMILIA 6: un rol pasado del tope NO se puede aplicar a otro bot: lo dejaría SORDO', async () => {
  const changes: ChangeRequest[] = [];
  const conEmojis = '🙂'.repeat(1150);
  servirConfig(() => ({
    ...snapshotDeConfig(1),
    agents: [
      { tenant_id: 'Steven', alias: 'zeus', role_brief: conEmojis, enabled: true },
      { tenant_id: 'Steven', alias: 'argos', role_brief: null, enabled: true },
    ],
  }));
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ROLES);

  expect(screen.getByText(/lo dejaría SORDO/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /aplicar el rol a ese bot/i })).not.toBeInTheDocument();
  expect(changes).toEqual([]);
});

it('FAMILIA 6: un gateway que no publica el registro de agentes no inventa un catálogo vacío', async () => {
  servirConfig(() => snapshotDeConfig(1));
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await irA(user, ROLES);

  expect(await screen.findByText(/no publica el registro de agentes/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /aplicar el rol a ese bot/i })).not.toBeInTheDocument();
});

describe('llegar a /config por URL directa sin permiso de control', () => {
  function servir403() {
    server.use(
      http.get('http://localhost/v3/console/config', () => HttpResponse.json(
        { error: 'forbidden', message: 'control permission is required' }, { status: 403 },
      )),
      http.get('http://localhost/v3/console/access', () => HttpResponse.json({
        subject: 'Miguel:janus', roles: ['agent'], permissions: ['message.publish'],
      })),
    );
  }

  it('dice LO MISMO que la barra lateral, y no que no se pudo leer Cauce', async () => {
    servir403();
    renderWithApi(<ConfigPage />);

    expect(await screen.findByText(CONFIG_SIN_CONTROL_REASON)).toBeInTheDocument();
    expect(screen.queryByText('No se pudo leer Cauce V3')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reintentar/i })).not.toBeInTheDocument();
  });

  it('cita el 403 crudo del servidor y ofrece una salida real en vez de un reintento imposible', async () => {
    servir403();
    renderWithApi(<ConfigPage />);

    expect(await screen.findByText(/El servidor contestó 403/)).toBeInTheDocument();
    expect(screen.getByText('control permission is required')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ir a la portada/i })).toHaveAttribute('href', '/');
  });

  it('un fallo que NO es de permiso sigue cayendo en el error genérico con su reintento', async () => {
    server.use(http.get('http://localhost/v3/console/config', () => HttpResponse.json(
      { error: 'internal', message: 'la base no responde' }, { status: 500 },
    )));
    renderWithApi(<ConfigPage />);

    expect(await screen.findByText('No se pudo leer Cauce V3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
    expect(screen.queryByText(CONFIG_SIN_CONTROL_REASON)).not.toBeInTheDocument();
  });
});

it('FAMILIA 8: la página se llama IGUAL que su entrada de menú, y no hay antetítulo en inglés', async () => {
  renderWithApi(<ConfigPage />);
  const titulo = await screen.findByRole('heading', { level: 1 });

  expect(titulo).toHaveTextContent(/^Ajustes y altas$/);
  expect(document.querySelector('.eyebrow')).toBeNull();
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
  expect(frase?.textContent?.length ?? 999).toBeLessThanOrEqual(90);

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

  const tabla = (await screen.findByRole('heading', { name: /chain visibility policy/i }))
    .closest('.panel')!.querySelector('table')!;
  const cabeceras = [...tabla.querySelectorAll('th')];
  const numerica = cabeceras.find((th) => /progress_relay_max_events/i.test(th.textContent ?? ''));
  const texto = cabeceras.find((th) => /^\s*id\s*$/i.test(th.textContent ?? ''));

  expect(numerica, 'no está la columna numérica del fixture').toBeDefined();
  expect(numerica).toHaveAttribute('data-numero', 'true');
  const celda = tabla.querySelectorAll('tbody tr td')[cabeceras.indexOf(numerica!)];
  expect(celda).toHaveAttribute('data-numero', 'true');
  expect(celda).toHaveTextContent('8');

  expect(texto, 'no está la columna de texto del fixture').toBeDefined();
  expect(texto).not.toHaveAttribute('data-numero');
});
