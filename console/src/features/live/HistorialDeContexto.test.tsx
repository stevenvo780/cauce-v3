import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';
import { RUTA_PERFIL, ackAplicado, perfilAplicado } from './perfil-fixtures';

/**
 * THE CONTEXT JOURNAL AND ITS RESTORE, tested from the live page.
 *
 * Where it lives is half the task: a loose component test would go green with the panel detached
 * from the drawer, which is how a screen ends up existing with no way to reach it. And the
 * restore is only worth anything if it ends in the canonical PUT —CAS, governed batch, ACK and a
 * hand-typed reason—, so it is followed to the end instead of stopping at the draft.
 */

const RUTA_REVISIONES = '*/v3/console/tenants/:tenantId/agents/:alias/perfil/revisions';
const RUTA_REVISIONES_FICHERO = '*/v3/console/tenants/:tenantId/agents/:alias/documents/:kind/revisions';
const RUTA_DOCUMENTOS = '*/v3/console/tenants/:tenantId/agents/:alias/documents';

interface RevisionCruda {
  id: string;
  revision: number;
  operation: 'insert' | 'update' | 'delete';
  purpose: string | null;
  role_summary: string | null;
  human_brief: string | null;
  responsibilities: string[];
  restrictions: string[];
  tools: string[];
  operating_rules: string[];
  actor_tenant: string | null;
  actor_alias: string | null;
  changed_at: string;
}

function revision(numero: number, parcial: Partial<RevisionCruda> = {}): RevisionCruda {
  return {
    id: String(numero),
    revision: numero,
    operation: numero === 1 ? 'insert' : 'update',
    purpose: 'Coordinar la flota.',
    role_summary: 'PMO de la flota.',
    human_brief: 'Steven.',
    responsibilities: ['Coordinar', 'Perseguir lo pendiente'],
    restrictions: ['No inventar'],
    tools: ['terminal'],
    operating_rules: ['Verificar'],
    actor_tenant: null,
    actor_alias: null,
    changed_at: `2026-08-2${String(numero)}T10:00:00.000Z`,
    ...parcial,
  };
}

const REVISION_VIEJA = revision(1, {
  role_summary: 'Hub de coordinación.',
  responsibilities: ['Coordinar'],
  actor_tenant: 'Steven',
  actor_alias: 'zeus',
});

const REVISION_NUEVA = revision(2);

/** Newest first, with a distinct date per entry so the merge does not have to break ties. */
function diarioLargo(cuantas: number): RevisionCruda[] {
  return Array.from({ length: cuantas }, (_unused, indice) => {
    const numero = cuantas - indice;
    return revision(numero, {
      id: String(numero),
      changed_at: new Date(Date.UTC(2026, 7, 1, 0, numero)).toISOString(),
      role_summary: `rol ${String(numero)}`,
    });
  });
}

function paginaDelDiario(entradas: RevisionCruda[], limite: number) {
  return HttpResponse.json({
    observed_at: new Date().toISOString(), tenant_id: 'Steven', alias: 'kant',
    entries: entradas.slice(0, limite),
  });
}

function conDiario(entradas: RevisionCruda[]) {
  server.use(http.get(RUTA_REVISIONES, ({ request }) => {
    const limite = Number(new URL(request.url).searchParams.get('limit') ?? '20');
    return HttpResponse.json({
      observed_at: new Date().toISOString(),
      tenant_id: 'Steven',
      alias: 'kant',
      entries: entradas.slice(0, limite),
    });
  }));
}

async function abrirHistorialDeKant() {
  const user = userEvent.setup();
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));
  await user.click(await within(cajon).findByRole('button', { name: /abrir directiva completa/i }));
  const dialogo = await screen.findByRole('dialog', { name: /directiva de kant/i });
  await user.click(within(dialogo).getByText('Historial y diff del contexto'));
  return { user, cajon, dialogo };
}

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
  server.use(http.get('*/v3/console/activity', () => HttpResponse.json(mockActivity())));
  conDiario([REVISION_NUEVA, REVISION_VIEJA]);
  server.use(http.get(RUTA_REVISIONES_FICHERO, ({ params }) => HttpResponse.json({
    observed_at: new Date().toISOString(),
    tenant_id: 'Steven',
    alias: 'kant',
    kind: String(params.kind),
    entries: [
      {
        id: '2', tenant_id: 'Steven', alias: 'kant', kind: String(params.kind),
        path: '/home/stev/.claude/CLAUDE.md', sha256: 'b'.repeat(64), bytes: 300,
        actor_tenant: 'Steven', actor_alias: 'zeus', written_at: '2026-08-31T10:00:00.000Z',
      },
      {
        id: '1', tenant_id: 'Steven', alias: 'kant', kind: String(params.kind),
        path: '/home/stev/.claude/CLAUDE.md', sha256: 'a'.repeat(64), bytes: 240,
        actor_tenant: null, actor_alias: null, written_at: '2026-08-30T10:00:00.000Z',
      },
    ],
  })));
});

it('enseña las revisiones del perfil, la más nueva arriba, con quién y cuándo', async () => {
  const { dialogo } = await abrirHistorialDeKant();

  expect(await within(dialogo).findByText(/Cambio del perfil · revisión 2/)).toBeInTheDocument();
  expect(within(dialogo).getByText(/Alta del perfil · revisión 1/)).toBeInTheDocument();
  const titulos = within(dialogo).getAllByText(/(Cambio|Alta) del perfil · revisión \d/);
  expect(titulos[0]).toHaveTextContent('revisión 2');

  // The one that was attributed says who; the one that was not says so, and is not attributed
  // to the operator who is watching.
  expect(within(dialogo).getByText('Steven/zeus')).toBeInTheDocument();
  expect(within(dialogo).getAllByText(/no consta quién/i).length).toBeGreaterThan(0);
}, 25_000);

it('el diff nombra el campo que cambió y deja fuera los seis que no', async () => {
  const { user, dialogo } = await abrirHistorialDeKant();

  await user.click((await within(dialogo).findAllByRole('button', { name: /ver qué cambió/i }))[0]);

  const diff = within(dialogo).getByRole('group', { name: /diferencias con la revisión 1/i });
  expect(within(diff).getByText('Rol declarado')).toBeInTheDocument();
  expect(within(diff).getByText('Responsabilidades')).toBeInTheDocument();
  expect(within(diff).queryByText('Tu humano y cómo tratarlo')).not.toBeInTheDocument();

  expect(within(diff).getByText('Hub de coordinación.')).toHaveAttribute('data-clase', 'quitada');
  expect(within(diff).getByText('PMO de la flota.')).toHaveAttribute('data-clase', 'agregada');
  expect(within(diff).getByText('Coordinar')).toHaveAttribute('data-clase', 'igual');
  expect(within(diff).getByText('Perseguir lo pendiente')).toHaveAttribute('data-clase', 'agregada');
}, 25_000);

it('la revisión más vieja leída dice que no hay con qué compararla, en vez de ofrecer un diff vacío', async () => {
  const { dialogo } = await abrirHistorialDeKant();

  const entradas = await within(dialogo).findAllByRole('listitem');
  expect(within(entradas[entradas.length - 1]).queryByRole('button', { name: /ver qué cambió/i }))
    .not.toBeInTheDocument();
  expect(within(dialogo).getByText(/es la revisión más vieja de las leídas/i)).toBeInTheDocument();
}, 25_000);

it('restaurar carga los SIETE campos en el borrador canónico y no escribe por ninguna ruta', async () => {
  let cambiosGenericos = 0;
  let perfilesGuardados = 0;
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(perfilAplicado(4))),
    http.post('*/v3/console/config/changes', () => {
      cambiosGenericos += 1;
      return HttpResponse.json({ applied: true, revision: 2 }, { status: 201 });
    }),
    http.put(RUTA_PERFIL, () => {
      perfilesGuardados += 1;
      return HttpResponse.json(ackAplicado(5));
    }),
  );

  const { user, cajon, dialogo } = await abrirHistorialDeKant();
  await user.click((await within(dialogo).findAllByRole('button', { name: /restaurar esta revisión/i }))[0]);

  expect(screen.queryByRole('dialog', { name: /directiva de kant/i })).not.toBeInTheDocument();
  expect(within(cajon).getByRole('tab', { name: 'Contexto' })).toHaveAttribute('aria-selected', 'true');
  expect(await within(cajon).findByLabelText(/^Identidad y propósito/i))
    .toHaveValue('Coordinar la flota.');
  expect(within(cajon).getByLabelText(/^Rol declarado/i)).toHaveValue('PMO de la flota.');
  expect(within(cajon).getByLabelText(/^Tu humano y cómo tratarlo/i)).toHaveValue('Steven.');
  expect(within(cajon).getByLabelText(/^Responsabilidades/i))
    .toHaveValue('Coordinar\nPerseguir lo pendiente');
  expect(within(cajon).getByLabelText(/^Restricciones/i)).toHaveValue('No inventar');
  expect(within(cajon).getByLabelText(/^Herramientas declaradas/i)).toHaveValue('terminal');
  expect(within(cajon).getByLabelText(/^Instrucciones fijas/i)).toHaveValue('Verificar');
  expect(cambiosGenericos).toBe(0);
  expect(perfilesGuardados).toBe(0);
}, 25_000);

it('guardar lo restaurado exige el motivo escrito a mano y sale por el PUT canónico con CAS', async () => {
  let actual = perfilAplicado(4);
  let cuerpoPut: Record<string, unknown> | undefined;
  let cambiosGenericos = 0;
  server.use(
    http.get(RUTA_PERFIL, () => HttpResponse.json(actual)),
    http.put(RUTA_PERFIL, async ({ request }) => {
      cuerpoPut = await request.json() as Record<string, unknown>;
      actual = perfilAplicado(5, { perfil: cuerpoPut.profile as typeof actual.perfil });
      return HttpResponse.json(ackAplicado(5));
    }),
    http.post('*/v3/console/config/changes', () => {
      cambiosGenericos += 1;
      return HttpResponse.json({ applied: true }, { status: 201 });
    }),
  );

  const { user, cajon, dialogo } = await abrirHistorialDeKant();
  await user.click((await within(dialogo).findAllByRole('button', { name: /restaurar esta revisión/i }))[0]);

  const guardar = await within(cajon).findByRole('button', { name: /guardar y aplicar perfil/i });
  // The negative control of the reason: everything else is in place and it still does not go.
  expect(guardar).toBeDisabled();

  await user.type(
    within(cajon).getByLabelText(/Motivo de este cambio de perfil/i),
    'vuelvo a la revisión 2 del perfil',
  );
  await user.click(within(cajon).getByRole('button', { name: /guardar y aplicar perfil/i }));

  await waitFor(() => { expect(cuerpoPut).toBeDefined(); });
  expect(cuerpoPut).toMatchObject({
    expected_revision: 4,
    reason: 'vuelvo a la revisión 2 del perfil',
    profile: {
      purpose: 'Coordinar la flota.',
      role_summary: 'PMO de la flota.',
      human_brief: 'Steven.',
      responsibilities: ['Coordinar', 'Perseguir lo pendiente'],
      restrictions: ['No inventar'],
      tools: ['terminal'],
      operating_rules: ['Verificar'],
    },
  });
  expect(cambiosGenericos).toBe(0);
  expect(await within(cajon).findByText(/desired y runtime acreditan la revisión 5/i))
    .toBeInTheDocument();
}, 30_000);

it('un diario largo se pagina pidiendo una ventana más ancha del mismo diario', async () => {
  const largas = diarioLargo(25);
  const limites: number[] = [];
  server.use(http.get(RUTA_REVISIONES, ({ request }) => {
    const limite = Number(new URL(request.url).searchParams.get('limit') ?? '20');
    limites.push(limite);
    return HttpResponse.json({
      observed_at: new Date().toISOString(), tenant_id: 'Steven', alias: 'kant',
      entries: largas.slice(0, limite),
    });
  }));

  const { user, dialogo } = await abrirHistorialDeKant();
  await waitFor(() => { expect(dialogo.querySelectorAll('.historial-entrada')).toHaveLength(20); });
  expect(within(dialogo).getByText(/· revisión 25$/)).toBeInTheDocument();
  expect(within(dialogo).queryByText(/· revisión 5$/)).not.toBeInTheDocument();

  await user.click(within(dialogo).getByRole('button', { name: /ver más/i }));

  await waitFor(() => { expect(dialogo.querySelectorAll('.historial-entrada')).toHaveLength(25); });
  expect(within(dialogo).getByText(/· revisión 5$/)).toBeInTheDocument();
  expect(limites).toEqual([20, 40]);
  // A short page proves there is no more: the button stops offering a trip to nowhere.
  await waitFor(() => {
    expect(within(dialogo).queryByRole('button', { name: /ver más/i })).not.toBeInTheDocument();
  });
}, 30_000);

it('sin config.write el diario se LEE igual: lo que se retira es la restauración', async () => {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({
    permissions: ['message.publish'], roles: ['observer'],
  })));

  const { dialogo } = await abrirHistorialDeKant();

  expect(await within(dialogo).findByText(/Cambio del perfil · revisión 2/)).toBeInTheDocument();
  await waitFor(() => {
    expect(within(dialogo).queryByRole('button', { name: /restaurar esta revisión/i }))
      .not.toBeInTheDocument();
  });
  expect(within(dialogo).getByText(/no puede cargar una revisión/i)).toBeInTheDocument();
}, 25_000);

it('un fallo de lectura no se disfraza de «este contexto no cambió nunca»', async () => {
  server.use(http.get(RUTA_REVISIONES, () => HttpResponse.json(
    { error: 'unavailable', message: 'la base no responde' }, { status: 503 },
  )));

  const { dialogo } = await abrirHistorialDeKant();

  expect(await within(dialogo).findByText(/no se pudo leer el diario del perfil/i))
    .toHaveTextContent('la base no responde');
  expect(within(dialogo).getByText(/no significa que este contexto no haya cambiado/i))
    .toBeInTheDocument();
  expect(within(dialogo).queryByRole('button', { name: /restaurar esta revisión/i }))
    .not.toBeInTheDocument();
}, 25_000);

it('un diario vacío se dice como hecho medido, no como lista vacía muda', async () => {
  conDiario([]);
  const { dialogo } = await abrirHistorialDeKant();

  expect(await within(dialogo).findByText(/el servidor miró y no hay ninguna revisión anotada/i))
    .toBeInTheDocument();
  expect(within(dialogo).getByText(/no significa que este contexto se haya tocado poco/i))
    .toBeInTheDocument();
}, 25_000);

it('el diario de un fichero enseña huella y tamaño, y declara que el texto no se guarda', async () => {
  const { user, dialogo } = await abrirHistorialDeKant();

  await user.click(await within(dialogo).findByRole('tab', { name: /CLAUDE\.md/i }));

  expect(await within(dialogo).findByText('bbbbbbbbbbbb')).toBeInTheDocument();
  expect(within(dialogo).getByText(/300 bytes/)).toBeInTheDocument();
  expect(within(dialogo).getByText(/la huella cambió y el fichero creció 60 bytes/i))
    .toBeInTheDocument();
  expect(within(dialogo).getByText(/nunca el texto/i)).toBeInTheDocument();
  // There is no body stored, so there is nothing to restore from here and nothing is offered.
  expect(within(dialogo).queryByRole('button', { name: /restaurar/i })).not.toBeInTheDocument();
}, 25_000);

it('un «Ver más» que falla se ve roto: la lista sigue, el fallo se dice y se puede reintentar', async () => {
  const largas = diarioLargo(25);
  let pedidos = 0;
  server.use(http.get(RUTA_REVISIONES, ({ request }) => {
    pedidos += 1;
    if (pedidos > 1) {
      return HttpResponse.json(
        { error: 'unavailable', message: 'la base no responde' }, { status: 503 },
      );
    }
    return paginaDelDiario(largas, Number(new URL(request.url).searchParams.get('limit') ?? '20'));
  }));

  const { user, dialogo } = await abrirHistorialDeKant();
  await waitFor(() => { expect(dialogo.querySelectorAll('.historial-entrada')).toHaveLength(20); });
  await user.click(within(dialogo).getByRole('button', { name: /ver más/i }));

  expect(await within(dialogo).findByText(/no se pudo leer el resto del diario del perfil/i))
    .toHaveTextContent('la base no responde');
  // The twenty already measured stay on screen, and the failure is not dressed up as the end.
  expect(dialogo.querySelectorAll('.historial-entrada')).toHaveLength(20);
  expect(within(dialogo).getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
}, 30_000);

it('la escalera de la ventana para en el tope de la ruta y dice que lo viejo quedó sin leer', async () => {
  const muchas = diarioLargo(400);
  const limites: number[] = [];
  server.use(http.get(RUTA_REVISIONES, ({ request }) => {
    const limite = Number(new URL(request.url).searchParams.get('limit') ?? '20');
    limites.push(limite);
    if (limite > 200) {
      return HttpResponse.json(
        { error: 'invalid_input', message: 'limit tiene que ser un entero entre 1 y 200' },
        { status: 400 },
      );
    }
    return paginaDelDiario(muchas, limite);
  }));

  const { user, dialogo } = await abrirHistorialDeKant();
  for (let esperado = 40; esperado <= 200; esperado += 20) {
    await user.click(within(dialogo).getByRole('button', { name: /ver más/i }));
    await waitFor(() => {
      expect(dialogo.querySelectorAll('.historial-entrada')).toHaveLength(esperado);
    });
  }

  // Never buys the 400 the route promises above its own MAX_PAGE.
  expect(Math.max(...limites)).toBe(200);
  expect(within(dialogo).queryByRole('button', { name: /ver más/i })).not.toBeInTheDocument();
  expect(within(dialogo).getByText(/no devuelve más de 200 entradas por lectura/i))
    .toBeInTheDocument();
}, 60_000);

it('un inventario de ficheros que falla no se dice «este gateway no lo publica»', async () => {
  server.use(http.get(RUTA_DOCUMENTOS, () => HttpResponse.json(
    { error: 'internal_error', message: 'la base de gobierno no contesta' }, { status: 500 },
  )));

  const { dialogo } = await abrirHistorialDeKant();

  expect(await within(dialogo).findByText(/no se pudo leer el inventario de ficheros de kant/i))
    .toHaveTextContent('la base de gobierno no contesta');
  expect(within(dialogo).queryByText(/no publica/i)).not.toBeInTheDocument();
  // Without an inventory it read, it does not invent a file tab either.
  expect(within(dialogo).queryByRole('tab', { name: /CLAUDE\.md/i })).not.toBeInTheDocument();
}, 25_000);

it('un gateway que no publica el inventario lo dice con las palabras del cliente', async () => {
  server.use(http.get(RUTA_DOCUMENTOS, () => HttpResponse.json(
    { error: 'not_implemented', message: 'sin inventario' }, { status: 501 },
  )));

  const { dialogo } = await abrirHistorialDeKant();

  expect(await within(dialogo).findByText(/no publica GET/i)).toBeInTheDocument();
  expect(within(dialogo).queryByText(/no se pudo leer el inventario/i)).not.toBeInTheDocument();
}, 25_000);

it('restaurar un borrado del perfil no se ofrece con las mismas palabras que volver atrás', async () => {
  conDiario([
    revision(3, {
      operation: 'delete',
      purpose: null,
      role_summary: null,
      human_brief: null,
      responsibilities: [],
      restrictions: [],
      tools: [],
      operating_rules: [],
      changed_at: '2026-08-30T10:00:00.000Z',
    }),
    REVISION_NUEVA,
  ]);

  const { dialogo } = await abrirHistorialDeKant();

  const borrado = await within(dialogo).findByRole('button', { name: /restaurar este borrado/i });
  expect(borrado).toBeInTheDocument();
  // The other row keeps the plain wording AND the plain skin: the difference is the point.
  const volverAtras = within(dialogo).getByRole('button', { name: /^restaurar esta revisión$/i });
  expect(volverAtras).toBeInTheDocument();
  expect(borrado.className).toContain('historial-restaurar-vacia');
  expect(volverAtras.className).not.toContain('historial-restaurar-vacia');
  expect(volverAtras.className).toContain('secondary');
  expect(borrado.className).not.toContain('secondary');
}, 25_000);
