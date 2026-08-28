import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * THE LEGACY JOURNAL AND ITS BRIDGE TO THE CANONICAL PROFILE, tested from the live page.
 *
 * Recovering a revision never writes `agents.role_brief`: it ends up in `role_summary`, inside
 * the Profile editor. A loose component test would pass even if the button reopened the generic
 * POST, which is why the flow is tested from the live page.
 *
 * The draft keeps the other profile fields, goes through its strict caps, and is only saved via
 * the canonical PUT with CAS and runtime ACK.
 */

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

function conHistorial(entries: Record<string, unknown>[]) {
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
  await user.click(await within(cajon).findByRole('button', { name: /abrir directiva completa/i }));
  const dialogo = await screen.findByRole('dialog', { name: /directiva de kant/i });
  const proyeccion = await within(dialogo).findByLabelText(/proyección del rol de kant/i);
  await user.click(within(dialogo).getByText('Historial de la proyección y restauración'));
  return { user, cajon, dialogo, proyeccion };
}

describe('HistorialRol', { timeout: 15_000 }, () => {
it('enseña los cambios del rol, el más nuevo arriba, dentro del mismo cajón', async () => {
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText('Se reescribió el rol')).toBeInTheDocument();
  expect(within(dialogo).getByText('Se le puso rol por primera vez')).toBeInTheDocument();

  const titulos = within(dialogo).getAllByText(/^Se (reescribió el rol|le puso rol por primera vez)$/);
  expect(titulos[0]).toHaveTextContent('Se reescribió el rol');
  // We stay on /live: the back navigation does not send the operator to another view.
  expect(window.location.pathname).toBe('/live');
});

it('declara desde cuándo hay diario: un registro corto no significa que el rol se tocara poco', async () => {
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/arranca el 23 de agosto de 2026/i)).toBeInTheDocument();
  expect(within(dialogo).getByText(/no significa que este rol se haya tocado poco/i)).toBeInTheDocument();
});

it('no atribuye las revisiones antiguas al operador que está mirando', async () => {
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/pueden no decir quién/i)).toBeInTheDocument();
  expect(within(dialogo).getAllByText(/no consta quién/i).length).toBeGreaterThan(0);
});

it('avisa de que editar a mano desvinculó la plantilla', async () => {
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/desvinculado de la plantilla «orquestador»/i)).toBeInTheDocument();
});

it('recuperar carga role_summary en Perfil y NO escribe por ninguna ruta', async () => {
  let cambiosGenericos = 0;
  let perfilesGuardados = 0;
  server.use(http.post('*/v3/console/config/changes', async () => {
    cambiosGenericos += 1;
    return HttpResponse.json({ applied: true, revision: 2 }, { status: 201 });
  }));
  server.use(http.put('*/v3/console/tenants/:tenantId/agents/:alias/perfil', async () => {
    perfilesGuardados += 1;
    return HttpResponse.json({ ok: true });
  }));

  const { user, cajon, dialogo, proyeccion } = await abrirDiarioDeKant();

  expect(proyeccion).toHaveValue('Sos kant, el hub de coordinacion de la flota.');
  const botones = await within(dialogo).findAllByRole('button', { name: /usar este texto en Perfil/i });
  await user.click(botones[0]);

  expect(screen.queryByRole('dialog', { name: /directiva de kant/i })).not.toBeInTheDocument();
  expect(within(cajon).getByRole('tab', { name: 'Perfil' })).toHaveAttribute('aria-selected', 'true');
  expect(await within(cajon).findByLabelText(/^Rol declarado/i)).toHaveValue('Sos kant.');
  expect(cambiosGenericos).toBe(0);
  expect(perfilesGuardados).toBe(0);
});

it('guardar una revisión recuperada usa sólo el PUT canónico con CAS y ACK', async () => {
  const rutaPerfil = '*/v3/console/tenants/:tenantId/agents/:alias/perfil';
  const base = {
    tenant_id: 'Steven', alias: 'kant', agent_enabled: true, exists: true,
    revision: 4, applied_revision: 4, runtime_state: 'applied', harness: 'codex',
    runtime_verification: {
      state: 'current', generation: 'gen-4', container_id: 'ws-kant',
      observed_at: '2026-08-26T00:00:00Z',
      documents: [{
        name: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md',
        expected_sha: 'a'.repeat(64), observed_sha: 'a'.repeat(64),
        expected_bytes: 18, observed_bytes: 18, current: true,
      }],
    },
    runtime_adoption: {
      evidence: 'adapter_delivery', revision: 4, generation: 'gen-4',
      adopted_at: '2026-08-26T00:01:00Z',
      documents: [{ name: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md', sha: 'a'.repeat(64) }],
    },
    perfil: {
      purpose: 'Coordinar la flota.', role_summary: 'PMO de la flota.',
      human_brief: 'Steven.', responsibilities: ['Coordinar'], restrictions: ['No inventar'],
      tools: ['terminal'], operating_rules: ['Verificar'],
    },
    limites: { purpose: 2_000, role_summary: 4_000, item: 1_000, items: 64, total: 24_000 },
    medida: { unidades: 80, tope: 24_000 }, base: 'fichero-vacio',
    ficheros: [{ nombre: 'AGENTS.md', politica: 'bloque-gestionado', texto: '', unidades: 0 }],
  };
  let actual = base;
  let cuerpoPut: Record<string, unknown> | undefined;
  let cambiosGenericos = 0;
  server.use(
    http.get(rutaPerfil, () => HttpResponse.json(actual)),
    http.put(rutaPerfil, async ({ request }) => {
      cuerpoPut = await request.json() as Record<string, unknown>;
      actual = {
        ...base,
        revision: 5,
        applied_revision: 5,
        runtime_adoption: { ...base.runtime_adoption, revision: 5 },
        perfil: cuerpoPut.profile as typeof base.perfil,
      };
      return HttpResponse.json({
        ok: true, state: 'applied', tenant_id: 'Steven', alias: 'kant',
        revision: 5, applied_revision: 5,
        acknowledgements: [{
          name: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md', state: 'written',
          sha: 'a'.repeat(64), bytes: 18, generation: 'gen-4', container_id: 'ws-kant',
        }],
        runtime_adoption: {
          ...base.runtime_adoption,
          revision: 5,
        },
      });
    }),
    http.post('*/v3/console/config/changes', () => {
      cambiosGenericos += 1;
      return HttpResponse.json({ applied: true }, { status: 201 });
    }),
  );

  const { user, cajon, dialogo } = await abrirDiarioDeKant();
  await user.click((await within(dialogo).findAllByRole('button', { name: /usar este texto en Perfil/i }))[0]);
  await user.click(await within(cajon).findByRole('button', { name: /guardar y aplicar perfil/i }));

  await waitFor(() => { expect(cuerpoPut).toBeDefined(); });
  expect(cuerpoPut).toMatchObject({
    expected_revision: 4,
    profile: {
      purpose: 'Coordinar la flota.', role_summary: 'Sos kant.',
      human_brief: 'Steven.', responsibilities: ['Coordinar'], restrictions: ['No inventar'],
      tools: ['terminal'], operating_rules: ['Verificar'],
    },
  });
  expect(cambiosGenericos).toBe(0);
  expect(await within(cajon).findByText(/desired y runtime acreditan la revisión 5/i)).toBeInTheDocument();
});

it('recuperar un alta se rotula como borrador vacío, no como borrado inmediato del alias', async () => {
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByRole('button', { name: /vaciar el rol en un borrador de Perfil/i }))
    .toBeInTheDocument();
});

it('un texto recuperado pasa por el tope estricto de role_summary antes del PUT', async () => {
  // 2,500 code points are 5,000 UTF-16 units: the canonical cap is 4,000 and Profile must
  // block saving before attempting any write.
  const viejo = '🙂'.repeat(2500);
  conHistorial([{
    id: '1', tenant_id: 'Steven', alias: 'kant', operation: 'update',
    previous_brief: viejo, new_brief: 'Sos kant, el hub de coordinacion de la flota.',
    previous_template_slug: null, new_template_slug: null,
    actor_tenant: null, actor_alias: null, changed_at: '2026-08-23T04:00:00.000Z',
  }]);

  const { user, cajon, dialogo } = await abrirDiarioDeKant();
  await user.click(await within(dialogo).findByRole('button', { name: /usar este texto en Perfil/i }));

  expect(await within(cajon).findByLabelText(/^Rol declarado/i)).toHaveValue(viejo);
  expect(within(cajon).getByText('5000 / 4000')).toHaveClass('perfil-cuenta-fuera');
  expect(within(cajon).getByRole('button', { name: /guardar y aplicar perfil/i })).toBeDisabled();
});

it('un alias sin cambios anotados lo dice como hecho medido, no como lista vacía muda', async () => {
  conHistorial([]);
  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/el servidor miró y no hay ningún cambio anotado/i)).toBeInTheDocument();
});

it('si el gateway no publica el diario dice «no se pudo mirar», nunca «no cambió nunca»', async () => {
  server.use(http.get('*/v3/console/role-assignments/:tenantId/:alias/history', () =>
    new HttpResponse(null, { status: 404 })));

  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/no se pudo mirar el diario del rol/i)).toBeInTheDocument();
  expect(within(dialogo).getByText(/NO significa que este rol no haya cambiado nunca/i)).toBeInTheDocument();
  expect(within(dialogo).queryByRole('button', { name: /usar este texto en Perfil/i })).not.toBeInTheDocument();
});

it('un 404 not_found del alias no se degrada a «gateway viejo»', async () => {
  server.use(http.get('*/v3/console/role-assignments/:tenantId/:alias/history', () => HttpResponse.json(
    { error: 'not_found', message: 'agent not found or not visible' }, { status: 404 },
  )));

  const { dialogo } = await abrirDiarioDeKant();

  expect(await within(dialogo).findByText(/agent not found or not visible/i)).toBeInTheDocument();
  expect(within(dialogo).queryByText(/gateway no publica/i)).not.toBeInTheDocument();
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
    expect(within(dialogo).queryByRole('button', { name: /usar este texto en Perfil/i })).not.toBeInTheDocument();
  });
});

it('el texto anterior se puede leer entero sin alterar la proyección', async () => {
  const { user, dialogo, proyeccion } = await abrirDiarioDeKant();

  await user.click((await within(dialogo).findAllByText(/ver el texto que había antes/i))[0]);

  expect(within(dialogo).getAllByText('Sos kant.').length).toBeGreaterThan(0);
  expect(proyeccion).toHaveValue('Sos kant, el hub de coordinacion de la flota.');
});

/**
 * The tools and prompts gap became a collapsible line in the FOOTER of the dialog. Open it
 * measured 679 px — almost the same as layer 1, the only editable one — and it led as if it
 * were another layer, when it is a scope note. It is still said in full: it folds, it is not
 * deleted.
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
  // Closed by default: that is what trims the height. If someone opens it from the factory, this goes red.
  expect(resumen.closest('details')?.open).toBe(false);
  await user.click(resumen);
  return within(dialogo).getByText(/lo que todavía no se puede desde aquí/i).closest('details') as HTMLElement;
}

it('el hueco de herramientas y prompts se DICE, con dónde vive la configuración de ese alias', async () => {
  const pendientes = await abrirPendientesDeKant();
  expect(within(pendientes).getByText(/herramientas · qué puede usar y qué no/i)).toBeInTheDocument();
  expect(within(pendientes).getByText(/prompts · falta acordar qué son/i)).toBeInTheDocument();
  // An actionable gap says where the thing lives, not just that it cannot be done.
  expect(within(pendientes).getByText('ws-kant')).toBeInTheDocument();
  expect(within(pendientes).getByText('/home/dev')).toBeInTheDocument();
  // And it offers no button: one that does nothing would be worse than the gap.
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

it('el role_summary recuperado sobrevive a desmontar Perfil y conserva los otros campos', async () => {
  const { user, cajon, dialogo } = await abrirDiarioDeKant();

  await user.click((await within(dialogo).findAllByRole('button', { name: /usar este texto en Perfil/i }))[0]);
  const rol = await within(cajon).findByLabelText(/^Rol declarado/i);
  const proposito = within(cajon).getByLabelText(/^Identidad y propósito/i);
  expect(rol).toHaveValue('Sos kant.');
  expect(proposito).toHaveValue('Coordinás lo pendiente de la flota y perseguís lo que se quedó a medias.');

  await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));
  await user.click(within(cajon).getByRole('tab', { name: 'Perfil' }));

  expect(await within(cajon).findByLabelText(/^Rol declarado/i)).toHaveValue('Sos kant.');
  expect(within(cajon).getByLabelText(/^Identidad y propósito/i))
    .toHaveValue('Coordinás lo pendiente de la flota y perseguís lo que se quedó a medias.');
});
});
